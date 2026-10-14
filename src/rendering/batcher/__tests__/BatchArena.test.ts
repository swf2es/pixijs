import { getWebGLRenderer, loseAndRestoreContext } from '@test-utils';
import { Texture } from '~/rendering/renderers/shared/texture/Texture';
import { Container } from '~/scene/container/Container';
import { Sprite } from '~/scene/sprite/Sprite';

import type { Batcher } from '../shared/Batcher';
import type { BatcherPipe } from '../shared/BatcherPipe';
import type { WebGLRenderer } from '~/rendering/renderers/gl/WebGLRenderer';

/**
 * A group of `count` white sprites in a row.
 * @param count - how many sprites
 * @returns the group
 */
function row(count: number): Container
{
    const group = new Container({ isRenderGroup: true });

    for (let i = 0; i < count; i++)
    {
        group.addChild(new Sprite({ texture: Texture.WHITE, x: i * 2, y: i }));
    }

    return group;
}

/**
 * The default batcher of `group`'s instruction set.
 * @param renderer - the renderer that built it
 * @param group - the render group
 * @returns its batcher
 */
function batcherOf(renderer: WebGLRenderer, group: Container): Batcher
{
    const pipe = renderer.renderPipes.batch as unknown as BatcherPipe;

    return pipe['_batchersByInstructionSet'][group.renderGroup.instructionSet.uid].default;
}

/**
 * The floats the GPU holds of `batcher`'s attributes.
 * @param renderer - the renderer
 * @param batcher - the batcher
 * @param count - how many floats to read
 * @returns the floats
 */
function onGpu(renderer: WebGLRenderer, batcher: Batcher, count: number): number[]
{
    const gl = renderer.gl as WebGL2RenderingContext;
    const out = new Float32Array(count);

    gl.bindBuffer(gl.COPY_READ_BUFFER, renderer.buffer.getGlBuffer(batcher.geometry.buffers[0]).buffer);
    gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, out);
    gl.bindBuffer(gl.COPY_READ_BUFFER, null);

    return Array.from(out);
}

/**
 * What Pixi packs for `group` as it keeps it on the CPU, for an arena's GPU copy to equal.
 * @param build - makes the group anew
 * @returns the floats packed
 */
async function packedOnCpu(build: () => Container): Promise<number[]>
{
    const renderer = (await getWebGLRenderer()) as WebGLRenderer;
    const group = build();

    renderer.render(group);

    const batcher = batcherOf(renderer, group);
    const packed = Array.from(batcher.attributeBuffer.float32View.subarray(0, batcher.attributeSize));

    renderer.destroy();

    return packed;
}

describe('BatchArena', () =>
{
    it('should keep a group\'s batches on the GPU alone, as Pixi packs them', async () =>
    {
        const renderer = (await getWebGLRenderer()) as WebGLRenderer;
        const pipe = renderer.renderPipes.batch as unknown as BatcherPipe;

        pipe.gpuResident = true;
        expect(pipe.gpuResident).toBe(true);

        const group = row(50);

        renderer.render(group);

        const batcher = batcherOf(renderer, group);

        expect(batcher.attributeBuffer.size).toBe(0);
        expect(batcher.geometry.buffers[0].data).toHaveLength(0);
        expect(batcher.geometry.indexBuffer.data.BYTES_PER_ELEMENT).toBe(2);
        expect(onGpu(renderer, batcher, batcher.attributeSize)).toEqual(await packedOnCpu(() => row(50)));

        renderer.destroy();
    });

    it('should write an element updated in place where it lies on the GPU', async () =>
    {
        const renderer = (await getWebGLRenderer()) as WebGLRenderer;

        (renderer.renderPipes.batch as unknown as BatcherPipe).gpuResident = true;

        const group = row(20);

        renderer.render(group);

        const batcher = batcherOf(renderer, group);

        // moved, not rebuilt: the two sprites go up in one write, the rest stay as they were
        group.children[3].x += 100;
        group.children[4].y += 100;
        renderer.render(group);

        expect(batcher.attributeBuffer.size).toBe(0);
        const moved = await packedOnCpu(() =>
        {
            const group = row(20);

            group.children[3].x += 100;
            group.children[4].y += 100;

            return group;
        });

        expect(onGpu(renderer, batcher, batcher.attributeSize)).toEqual(moved);

        renderer.destroy();
    });

    it('should pack groups one after another into the same buffers', async () =>
    {
        const renderer = (await getWebGLRenderer()) as WebGLRenderer;

        (renderer.renderPipes.batch as unknown as BatcherPipe).gpuResident = true;

        const small = row(10);
        const large = row(300);

        renderer.render(small);
        renderer.render(large);

        const arena = (renderer.renderPipes.batch as unknown as BatcherPipe)['_arena'];
        const packing = arena['_packing'].default;

        // grown to the larger group's, and lent to the next build
        expect(packing.attributes.size).toBeGreaterThanOrEqual(batcherOf(renderer, large).attributeSize * 4);
        small.addChild(new Sprite(Texture.WHITE));
        renderer.render(small);
        expect(arena['_packing'].default.attributes).toBe(packing.attributes);

        const grown = await packedOnCpu(() => row(10).addChild(new Sprite(Texture.WHITE)).parent);

        expect(onGpu(renderer, batcherOf(renderer, small), grown.length)).toEqual(grown);

        renderer.destroy();
    });

    it('should pack a group again for a context given back after a loss', async () =>
    {
        const renderer = (await getWebGLRenderer()) as WebGLRenderer;

        (renderer.renderPipes.batch as unknown as BatcherPipe).gpuResident = true;

        const group = row(30);

        renderer.render(group);
        await loseAndRestoreContext(renderer);
        renderer.render(group);

        const batcher = batcherOf(renderer, group);

        expect(onGpu(renderer, batcher, batcher.attributeSize)).toEqual(await packedOnCpu(() => row(30)));

        renderer.destroy();
    });

    it('should pack a group again for a renderer it moves to, where either keeps batches on the GPU', async () =>
    {
        const resident = (await getWebGLRenderer()) as WebGLRenderer;
        const keeping = (await getWebGLRenderer()) as WebGLRenderer;

        (resident.renderPipes.batch as unknown as BatcherPipe).gpuResident = true;

        const group = row(25);
        const packed = await packedOnCpu(() => row(25));

        // from a renderer that kept nothing on the CPU, to one that would upload it from there
        resident.render(group);
        keeping.render(group);
        expect(batcherOf(keeping, group)).toBeDefined();
        expect(Array.from(batcherOf(keeping, group).attributeBuffer.float32View.subarray(0, packed.length)))
            .toEqual(packed);

        // and back, to one that updates in place only what it packed itself
        resident.render(group);
        group.children[2].x += 50;
        resident.render(group);

        const moved = await packedOnCpu(() =>
        {
            const group = row(25);

            group.children[2].x += 50;

            return group;
        });

        expect(onGpu(resident, batcherOf(resident, group), moved.length)).toEqual(moved);

        resident.destroy();
        keeping.destroy();
    });
});
