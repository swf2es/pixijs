import { Graphics } from '../shared/Graphics';
import { GraphicsContext } from '../shared/GraphicsContext';
import { GpuGraphicsContext } from '../shared/GraphicsContextSystem';
import '../init';
import { getWebGLRenderer } from '@test-utils';
import { Texture } from '~/rendering/renderers/shared/texture/Texture';
import { Container } from '~/scene/container/Container';

import type { GraphicsContextRenderData, GraphicsGeometryData } from '../shared/GraphicsContextSystem';

/**
 * A star of `points` points, many enough to be compacted.
 * @param points - how many points
 * @param batchMode - how the context is drawn
 * @param texture - what it is filled with, if not a colour
 */
function star(points: number, batchMode: 'batch' | 'no-batch', texture?: Texture): GraphicsContext
{
    const context = new GraphicsContext();

    context.batchMode = batchMode;
    context.moveTo(100, 0);

    for (let i = 1; i < points * 2; i++)
    {
        const r = i % 2 ? 40 : 100;
        const a = (i * Math.PI) / points;

        context.lineTo((r * Math.cos(a)) + 0.1, (r * Math.sin(a)) + 0.3);
    }

    return context.closePath().fill(texture ? { texture, color: 0xffffff } : { color: 0xff0000 });
}

function plain(data: GraphicsGeometryData)
{
    return {
        vertices: Array.from(data.vertices),
        uvs: Array.from(data.uvs),
        indices: Array.from(data.indices),
    };
}

describe('GraphicsContextSystem', () =>
{
    it('should keep a context drawn alone as 32-bit positions, zeros for UVs and 16-bit indices', async () =>
    {
        const renderer = await getWebGLRenderer();
        const context = star(40, 'no-batch');
        const gpuContext = renderer.graphicsContext.updateGpuContext(context);
        const data = gpuContext.geometryData;

        expect(gpuContext.isBatchable).toBe(false);
        expect(data.vertices).toBeInstanceOf(Float32Array);
        expect(data.uvs).toBeInstanceOf(Float32Array);
        expect(data.indices).toBeInstanceOf(Uint16Array);
        expect(data.uvs).toHaveLength(data.vertices.length);
        expect(Array.from(data.uvs).every((uv) => uv === 0)).toBe(true);

        // built again, from new arrays, it is the same
        const first = plain(data);

        context.dirty = true;
        expect(plain(renderer.graphicsContext.updateGpuContext(context).geometryData)).toEqual(first);

        renderer.destroy();
    });

    it('should keep a batched context\'s positions as 64-bit floats, and a textured one\'s UVs', async () =>
    {
        const renderer = await getWebGLRenderer();
        const batched = renderer.graphicsContext.updateGpuContext(star(40, 'batch'));

        expect(batched.isBatchable).toBe(true);
        expect(batched.geometryData.vertices).toBeInstanceOf(Float64Array);
        expect(batched.geometryData.vertices[2]).toBe((40 * Math.cos(Math.PI / 40)) + 0.1);

        const textured = renderer.graphicsContext.updateGpuContext(star(40, 'no-batch', Texture.EMPTY));

        expect(textured.geometryData.uvs).toBeInstanceOf(Float32Array);
        expect(Array.from(textured.geometryData.uvs).some((uv) => uv !== 0)).toBe(true);

        renderer.destroy();
    });

    it('should take a built context\'s tessellation rather than tessellate the same shapes again', async () =>
    {
        const renderer = await getWebGLRenderer();
        const contexts = renderer.graphicsContext;
        const alone = star(40, 'no-batch');
        const batched = star(40, 'batch');
        const fresh = plain(contexts.updateGpuContext(star(40, 'batch')).geometryData);
        const freshBatches = contexts.updateGpuContext(star(40, 'batch')).batches.length;

        batched.tessellationOf = alone;

        // not yet built, it tessellates its own shapes
        const own = contexts.updateGpuContext(batched);

        expect(plain(own.geometryData)).toEqual(fresh);

        // the other built, it takes that one's geometry, compacted for a batch, as 32-bit floats were kept
        contexts.updateGpuContext(alone);
        batched.dirty = true;

        const taken = contexts.updateGpuContext(batched);

        const shared = plain(contexts.updateGpuContext(alone).geometryData);

        expect(taken.isBatchable).toBe(true);
        expect(taken.geometryData.vertices).toBeInstanceOf(Float64Array);
        expect(plain(taken.geometryData)).toEqual(shared);
        expect(shared.vertices).toEqual(fresh.vertices.map((v) => Math.fround(v)));
        expect(shared.indices).toEqual(fresh.indices);
        // what no build changes once built is shared, not copied
        expect(taken.geometryData.indices).toBe(contexts.updateGpuContext(alone).geometryData.indices);
        expect(taken.geometryData.uvs).toBe(contexts.updateGpuContext(alone).geometryData.uvs);
        expect(taken.batches).toHaveLength(freshBatches);
        expect(taken.batches.every((batch) => batch.geometryData === taken.geometryData)).toBe(true);
        expect(taken.batches[0].attributeSize).toBe(fresh.vertices.length / 2);

        // drawn, as a batch would draw it
        const stage = new Container();

        stage.addChild(new Graphics(batched), new Graphics(alone));
        renderer.render(stage);

        renderer.destroy();
    });

    it('should leave a small context as it was built', async () =>
    {
        const renderer = await getWebGLRenderer();
        const gpuContext = renderer.graphicsContext.updateGpuContext(star(3, 'no-batch'));

        expect(Array.isArray(gpuContext.geometryData.vertices)).toBe(true);

        renderer.destroy();
    });

    it('should let go of what a frame packed as it ends, and pack it again once the GPU loses it', async () =>
    {
        const renderer = await getWebGLRenderer();
        const contexts = renderer.graphicsContext;
        const context = star(40, 'no-batch');
        const stage = new Container();
        const packing = (data: GraphicsContextRenderData) => ({
            attributes: Array.from(data.batcher.attributeBuffer.float32View.subarray(0, data.batcher.attributeSize)),
            indices: Array.from(data.batcher.indexBuffer.subarray(0, data.batcher.indexSize)),
        });

        stage.addChild(new Graphics(context));
        contexts.updateGpuContext(context);

        const data = contexts.getContextRenderData(context);
        const packed = packing(data);
        const type = data.batcher.indexBuffer.constructor;

        // drawn, and so uploaded, and the frame ended
        renderer.render(stage);

        expect(data._dropped).toBe(true);
        expect(data.batcher.attributeBuffer.float32View).toHaveLength(0);
        expect(data.batcher.indexBuffer).toHaveLength(0);
        expect(data.batcher.indexBuffer.constructor).toBe(type);
        expect(data.batcher.geometry.indexBuffer.data).toBe(data.batcher.indexBuffer);
        expect(contexts.getContextRenderData(context)).toBe(data);

        // drawn again from the GPU's copy
        renderer.render(stage);
        expect(contexts.getContextRenderData(context)).toBe(data);

        // the GPU's copy gone, as a lost context leaves it: packed again, the same
        data.batcher.geometry.buffers[0]._gpuData[renderer.uid] = null;

        const again = contexts.getContextRenderData(context);

        expect(again._dropped).toBe(false);
        expect(packing(again)).toEqual(packed);

        // and on the CPU though the GPU holds it, for what reads the arrays
        renderer.render(stage);
        expect(again._dropped).toBe(true);
        expect(packing(contexts.getContextRenderDataOnCpu(context))).toEqual(packed);

        renderer.destroy();
    });

    it('should tell onContextBuilt of each build, and onReset of each reset', async () =>
    {
        const renderer = await getWebGLRenderer();
        const contexts = renderer.graphicsContext;
        const context = star(3, 'no-batch');
        const built: [GraphicsContext, GpuGraphicsContext][] = [];
        // each reset, with the batches it still had
        const reset: [GpuGraphicsContext, number][] = [];

        contexts.onContextBuilt = (c, gpuContext) => built.push([c, gpuContext]);
        GpuGraphicsContext.onReset = (gpuContext) => reset.push([gpuContext, gpuContext.batches.length]);

        try
        {
            const gpuContext = contexts.updateGpuContext(context);

            contexts.updateGpuContext(context);
            expect(built).toEqual([[context, gpuContext]]);
            expect(reset).toEqual([]);

            context.dirty = true;
            contexts.updateGpuContext(context);
            expect(built).toHaveLength(2);
            expect(reset).toEqual([[gpuContext, 1]]);
        }
        finally
        {
            GpuGraphicsContext.onReset = null;
        }

        renderer.destroy();
    });
});
