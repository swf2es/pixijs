import { Matrix } from '../../../../maths/matrix/Matrix';
import { Texture } from '../../../../rendering/renderers/shared/texture/Texture';
import { CanvasGraphicsAdaptor } from '../../canvas/CanvasGraphicsAdaptor';
import { GraphicsContext } from '../GraphicsContext';
import { GpuGraphicsContext, GraphicsContextSystem } from '../GraphicsContextSystem';
import { buildContextBatches } from '../utils/buildContextBatches';
import type { Graphics } from '../Graphics';
import type { GraphicsPipeLike } from '../GraphicsPipe';

const geometry = {
    vertices: new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

describe('finished fill geometry', () =>
{
    it('shares zero UVs for white finished fills without temporary numeric UV arrays', () =>
    {
        const positions = new Float64Array([...geometry.vertices, ...geometry.vertices]);
        const source = new GraphicsContext()
            .fillGeometry({ vertices: positions.subarray(0, 8), indices: geometry.indices }, 1)
            .fillGeometry({ vertices: positions.subarray(8), indices: geometry.indices }, 2);
        const copy = source.clone();
        const first = new GpuGraphicsContext();
        const second = new GpuGraphicsContext();

        buildContextBatches(source, first);
        buildContextBatches(copy, second);
        expect(first.geometryData.uvs).toBeInstanceOf(Float32Array);
        expect((first.geometryData.uvs as Float32Array).buffer)
            .toBe((second.geometryData.uvs as Float32Array).buffer);
        expect(Array.from(first.geometryData.uvs)).toEqual(Array(positions.length).fill(0));
        expect(first.batches.map((batch) => [batch.attributeOffset, batch.attributeSize,
            batch.indexOffset, batch.indexSize])).toEqual([[0, 4, 0, 6], [4, 4, 6, 6]]);

        first.destroy();
        second.destroy();
        source.destroy();
        copy.destroy();
    });

    it('keeps shared zero UVs intact when a larger finished fill grows the buffer', () =>
    {
        const source = new GraphicsContext().fillGeometry(geometry);
        const first = new GpuGraphicsContext();

        buildContextBatches(source, first);
        const saved = first.geometryData.uvs;
        const large = new GraphicsContext().fillGeometry({
            vertices: new Float64Array(8192), indices: geometry.indices,
        });
        const second = new GpuGraphicsContext();

        buildContextBatches(large, second);
        expect(saved.length).toBe(geometry.vertices.length);
        expect(Array.from(saved)).toEqual(Array(geometry.vertices.length).fill(0));
        expect(second.geometryData.uvs.length).toBe(8192);
        expect(Array.from(second.geometryData.uvs).every((value) => value === 0)).toBe(true);

        first.reset();
        buildContextBatches(source, first);
        expect(Array.from(first.geometryData.uvs)).toEqual(Array.from(saved));
        first.destroy();
        second.destroy();
        source.destroy();
        large.destroy();
    });

    it('builds UVs for mixed white and textured finished fills', () =>
    {
        const positions = new Float64Array([...geometry.vertices, ...geometry.vertices]);
        const source = new GraphicsContext()
            .fillGeometry({ vertices: positions.subarray(0, 8), indices: geometry.indices })
            .fillGeometry({ vertices: positions.subarray(8), indices: geometry.indices },
                { texture: Texture.EMPTY });
        const gpu = new GpuGraphicsContext();

        buildContextBatches(source, gpu);
        expect(Array.from(gpu.geometryData.uvs).slice(0, 8)).toEqual(Array(8).fill(0));
        expect(Array.from(gpu.geometryData.uvs).slice(8).some((value) => value !== 0)).toBe(true);
        expect(gpu.geometryData.uvs.length).toBe(positions.length);
        gpu.destroy();
        source.destroy();
    });

    it('paints the whole Canvas fill once, without alpha seams on internal triangle edges', () =>
    {
        const source = new GraphicsContext().fillGeometry(geometry, { color: 0x336699, alpha: 0.5 });
        let fills = 0;
        const canvas = {
            globalAlpha: 1,
            fillStyle: '',
            save() {}, restore() {}, transform() {}, beginPath() {},
            moveTo() {}, lineTo() {}, closePath() {},
            fill() { fills++; },
        };
        const renderer = {
            globalUniforms: {},
            canvasContext: {
                activeContext: canvas,
                setContextTransform() {}, setBlendMode() {},
            },
        };
        const renderable = {
            context: source,
            groupTransform: new Matrix(),
            groupColorAlpha: 0xFFFFFFFF,
            groupBlendMode: 'normal',
        };

        new CanvasGraphicsAdaptor().execute({ renderer } as unknown as GraphicsPipeLike,
            renderable as unknown as Graphics);
        expect(fills).toBe(1);
        expect(canvas.globalAlpha).toBe(0.5);
        source.destroy();
    });

    it('keeps owned buffers across clones, path retirement and rebuilds', () =>
    {
        const context = new GraphicsContext().translate(20, 30).fillGeometry(geometry, 0x336699);
        const copy = context.clone();

        context.releasePaths();
        expect(context.bounds.minX).toBe(20);
        expect(context.bounds.maxY).toBe(40);
        expect(context.containsPoint({ x: 25, y: 35 })).toBe(true);
        expect(context.containsPoint({ x: 5, y: 5 })).toBe(false);

        for (const source of [context, copy])
        {
            const gpu = new GpuGraphicsContext();

            buildContextBatches(source, gpu);
            expect(Array.from(gpu.geometryData.vertices)).toEqual([20, 30, 30, 30, 30, 40, 20, 40]);
            expect(Array.from(gpu.geometryData.indices)).toEqual([0, 1, 2, 0, 2, 3]);
            expect(gpu.batches[0].baseColor).toBe(0x336699);
            gpu.destroy();
        }
        expect(geometry.vertices[0]).toBe(0);
        context.destroy();
        copy.destroy();
    });

    it('rejects malformed triangle lists and ignores degenerate triangles in hit tests', () =>
    {
        const context = new GraphicsContext();

        expect(() => context.fillGeometry({ ...geometry, indices: new Uint32Array([0, 1, 4]) })).toThrow();
        expect(() => context.fillGeometry({ ...geometry, vertices: new Float64Array([NaN, 0]) })).toThrow();
        context.fillGeometry({
            vertices: new Float64Array([0, 0, 10, 10, 5, 5]),
            indices: new Uint16Array([0, 1, 2]),
        });
        expect(context.containsPoint({ x: 5, y: 5 })).toBe(false);
        context.destroy();
    });

    it('captures the draw transform independently of later context changes', () =>
    {
        const context = new GraphicsContext().setTransform(new Matrix(2, 0, 0, 3, 4, 5));

        context.fillGeometry(geometry).resetTransform();
        expect(context.bounds.maxX).toBe(24);
        expect(context.bounds.maxY).toBe(35);
        context.destroy();
    });

    it('borrows contiguous owned positions and resets without changing the source buffers', () =>
    {
        const positions = new Float64Array([...geometry.vertices, ...geometry.vertices]);
        const context = new GraphicsContext()
            .fillGeometry({ vertices: positions.subarray(0, 8), indices: geometry.indices }, 1)
            .fillGeometry({ vertices: positions.subarray(8), indices: geometry.indices }, 2);
        const gpu = new GpuGraphicsContext();

        buildContextBatches(context, gpu);
        expect((gpu.geometryData.vertices as Float64Array).buffer).toBe(positions.buffer);
        expect(gpu.batches.map((batch) => [batch.attributeOffset, batch.attributeSize])).toEqual([[0, 4], [4, 4]]);
        expect(Array.from(gpu.geometryData.indices)).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
        const saved = Array.from(positions);

        gpu.reset();
        buildContextBatches(context, gpu);
        expect(Array.from(positions)).toEqual(saved);
        expect((gpu.geometryData.vertices as Float64Array).buffer).toBe(positions.buffer);
        gpu.destroy();
        context.destroy();
    });

    it('draws a layer\'s indices counted from its first vertex without copying them', () =>
    {
        const positions = new Float64Array([...geometry.vertices, ...geometry.vertices.map((v) => v + 20)]);
        const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
        const first = { vertices: positions.subarray(0, 8), indices: indices.subarray(0, 6), indexOffset: 0 };
        const second = { vertices: positions.subarray(8), indices: indices.subarray(6), indexOffset: 4 };
        const context = new GraphicsContext().fillGeometry(first, 1).fillGeometry(second, 2);
        const gpu = new GpuGraphicsContext();

        buildContextBatches(context, gpu);
        expect(gpu.geometryData.indices).toBeInstanceOf(Uint16Array);
        expect((gpu.geometryData.indices as Uint16Array).buffer).toBe(indices.buffer);
        expect(Array.from(gpu.geometryData.indices)).toEqual(Array.from(indices));
        expect(gpu.batches.map((batch) => [batch.attributeOffset, batch.attributeSize,
            batch.indexOffset, batch.indexSize])).toEqual([[0, 4, 0, 6], [4, 4, 6, 6]]);
        expect(context.bounds.minX).toBe(0);
        expect(context.bounds.maxX).toBe(30);
        expect(context.containsPoint({ x: 25, y: 25 })).toBe(true);
        expect(context.containsPoint({ x: 15, y: 15 })).toBe(false);
        gpu.destroy();

        // Alone, or moved, a fill's indices are counted from its own first vertex.
        for (const alone of [
            new GraphicsContext().fillGeometry(second),
            new GraphicsContext().fillGeometry(geometry).translate(1, 0).fillGeometry(second),
        ])
        {
            const built = new GpuGraphicsContext();

            buildContextBatches(alone, built);
            const count = built.geometryData.vertices.length / 2;

            expect(Array.from(built.geometryData.indices).slice(-6))
                .toEqual([0, 1, 2, 0, 2, 3].map((i) => i + count - 4));
            built.destroy();
            alone.destroy();
        }

        expect(() => new GraphicsContext().fillGeometry({ ...second, indexOffset: 5 })).toThrow();
        expect(Array.from(indices)).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
        context.destroy();
    });

    it('builds typed indices for fills whose indices count from their own vertices', () =>
    {
        const vertices = new Float64Array(70000 * 2);
        const indices = new Uint16Array([0, 1, 34999]);
        const context = new GraphicsContext()
            .fillGeometry({ vertices: vertices.subarray(0, 70000), indices }, 1)
            .fillGeometry({ vertices: vertices.subarray(70000), indices }, 2);
        const gpu = new GpuGraphicsContext();

        buildContextBatches(context, gpu);
        expect(gpu.geometryData.indices).toBeInstanceOf(Uint32Array);
        expect(Array.from(gpu.geometryData.indices)).toEqual([0, 1, 34999, 35000, 35001, 69999]);
        gpu.destroy();
        context.destroy();
    });

    it('shares immutable colour-copy positions and records standalone float rounding', () =>
    {
        const contexts = new GraphicsContextSystem({
            uid: 1, gc: { now: 0, addResourceHash() {} }, limits: { maxBatchableTextures: 16 },
        } as never);
        const vertices = new Float64Array(80).map((_, i) => i + 0.123456789);
        const source = new GraphicsContext().fillGeometry({ vertices, indices: new Uint16Array([0, 1, 2]) });

        source.batchMode = 'no-batch';
        contexts.updateGpuContext(source);
        const copies = [source.clone(), source.clone()];
        const data = copies.map((copy) =>
        {
            copy.batchMode = 'batch';
            copy.tessellationOf = source;

            return contexts.updateGpuContext(copy).geometryData;
        });

        expect(data[0].vertices).toBe(data[1].vertices);
        expect(data[0].vertices).toBeInstanceOf(Float64Array);
        expect(data[0].roundToFloat32).toBe(true);
        expect(Array.from(data[0].vertices)).toEqual(Array.from(vertices));
        source.unload();
        contexts.updateGpuContext(source);
        expect(data[0].vertices).toBeInstanceOf(Float64Array);
        expect(data[0].roundToFloat32).toBe(true);
        expect(Array.from(data[0].vertices)).toEqual(Array.from(vertices));
        copies.forEach((copy) => copy.destroy());
        source.destroy();
    });
});
