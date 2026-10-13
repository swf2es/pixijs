import { getWebGLRenderer } from '@test-utils';
import { Texture } from '~/rendering/renderers/shared/texture/Texture';
import { Container } from '~/scene/container/Container';
import { Sprite } from '~/scene/sprite/Sprite';

import type { BatcherPipe } from '../shared/BatcherPipe';
import type { WebGLRenderer } from '~/rendering/renderers/gl/WebGLRenderer';

describe('BatcherPipe', () =>
{
    it('should release cached batchers when the owning container is destroyed', async () =>
    {
        const renderer = (await getWebGLRenderer()) as WebGLRenderer;
        const batchPipe = renderer.renderPipes.batch as unknown as BatcherPipe;

        const cache = batchPipe['_batchersByInstructionSet'] as Record<number, unknown>;

        const container = new Container({ isRenderGroup: true });

        container.addChild(new Sprite(Texture.WHITE));

        renderer.render(container);

        const uid = container.renderGroup.instructionSet.uid;

        // Sanity check: rendering populated the per-instructionSet batcher cache.
        expect(cache[uid]).toBeDefined();

        container.destroy({ children: true });

        // should not leak: entry should not survive RenderGroup destruction.
        expect(cache[uid]).toBeUndefined();

        renderer.destroy();
    });

    it('should cut back the buffers of a batcher that has long used little of them', async () =>
    {
        const renderer = (await getWebGLRenderer()) as WebGLRenderer;
        const batchPipe = renderer.renderPipes.batch as unknown as BatcherPipe;
        const container = new Container({ isRenderGroup: true });

        for (let i = 0; i < 2000; i++)
        {
            container.addChild(new Sprite(Texture.WHITE));
        }

        renderer.render(container);
        container.removeChildren(10);
        renderer.render(container);

        const batcher = batchPipe['_batchersByInstructionSet'][container.renderGroup.instructionSet.uid].default;
        const held = batcher.attributeBuffer.size;
        const packed = Array.from(batcher.attributeBuffer.float32View.subarray(0, batcher.attributeSize));

        batchPipe.trim(0);
        batchPipe.trim(1000);
        expect(batcher.attributeBuffer.size).toBe(held);

        batchPipe.trim(5000);
        expect(batcher.attributeBuffer.size).toBe(batcher.attributeSize * 2 * 4);
        expect(batcher.indexBuffer).toHaveLength(batcher.indexSize * 2);
        expect(Array.from(batcher.attributeBuffer.float32View.subarray(0, batcher.attributeSize))).toEqual(packed);
        expect(batcher.geometry.buffers[0].data).toBe(batcher.attributeBuffer.float32View);
        expect(batcher.geometry.indexBuffer.data).toBe(batcher.indexBuffer);

        // the GPU's copy is made again at the new size as it is next uploaded
        renderer.render(container);
        expect(renderer.buffer.getGlBuffer(batcher.geometry.buffers[0]).byteLength)
            .toBe(batcher.attributeBuffer.size);

        renderer.destroy();
    });

    it('should keep the buffers of a batcher using much of them', async () =>
    {
        const renderer = (await getWebGLRenderer()) as WebGLRenderer;
        const batchPipe = renderer.renderPipes.batch as unknown as BatcherPipe;
        const container = new Container({ isRenderGroup: true });

        for (let i = 0; i < 2000; i++)
        {
            container.addChild(new Sprite(Texture.WHITE));
        }

        renderer.render(container);

        const batcher = batchPipe['_batchersByInstructionSet'][container.renderGroup.instructionSet.uid].default;
        const held = batcher.attributeBuffer.size;

        batchPipe.trim(0);
        batchPipe.trim(5000);
        expect(batcher.attributeBuffer.size).toBe(held);

        renderer.destroy();
    });
});
