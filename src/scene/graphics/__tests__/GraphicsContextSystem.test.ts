import { Graphics } from '../shared/Graphics';
import { GraphicsContext } from '../shared/GraphicsContext';
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
});
