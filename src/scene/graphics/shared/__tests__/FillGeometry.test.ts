import { Matrix } from '../../../../maths/matrix/Matrix';
import { CanvasGraphicsAdaptor } from '../../canvas/CanvasGraphicsAdaptor';
import { GraphicsContext } from '../GraphicsContext';
import { GpuGraphicsContext } from '../GraphicsContextSystem';
import { buildContextBatches } from '../utils/buildContextBatches';
import type { Graphics } from '../Graphics';
import type { GraphicsPipeLike } from '../GraphicsPipe';

const geometry = {
    vertices: new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

describe('finished fill geometry', () =>
{
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
});
