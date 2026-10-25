import { GraphicsContext } from '../GraphicsContext';
import { GpuGraphicsContext, GraphicsContextSystem } from '../GraphicsContextSystem';
import { buildContextBatches } from '../utils/buildContextBatches';
import { Texture } from '~/rendering';

describe('stroke geometry', () =>
{
    it('shares zero UV storage across untextured stroke contexts', () =>
    {
        const source = new GraphicsContext()
            .moveTo(0, 0)
            .lineTo(10, 0)
            .stroke({ width: 2, cap: 'butt' });
        const copy = source.clone();
        const first = new GpuGraphicsContext();
        const second = new GpuGraphicsContext();

        buildContextBatches(source, first);
        buildContextBatches(copy, second);
        const uvs = first.geometryData.uvs as Float32Array;

        expect(uvs).toBeInstanceOf(Float32Array);
        expect(uvs.buffer).toBe((second.geometryData.uvs as Float32Array).buffer);
        expect(uvs.length).toBe(first.geometryData.vertices.length);
        expect(Array.from(uvs)).toEqual(Array(uvs.length).fill(0));
        first.destroy();
        second.destroy();
        source.destroy();
        copy.destroy();
    });

    it('rebuilds a short stroke without changing a retained colour copy', () =>
    {
        const system = new GraphicsContextSystem({
            uid: 1, gc: { now: 0, addResourceHash: jest.fn() }, limits: { maxBatchableTextures: 16 },
        } as never);
        const source = new GraphicsContext()
            .moveTo(0, 0)
            .lineTo(10, 0)
            .stroke({ width: 2, cap: 'butt' });
        const built = system.updateGpuContext(source);

        expect(Array.isArray(built.geometryData.vertices)).toBe(true);
        expect(built.geometryData.vertices.length).toBeLessThan(64);
        const copy = source.clone();

        copy.tessellationOf = source;
        const kept = system.updateGpuContext(copy).geometryData;
        const positions = Array.from(kept.vertices);
        const uvs = Array.from(kept.uvs);

        source.clear().circle(0, 0, 20).stroke({ width: 4 });
        expect(() => system.updateGpuContext(source)).not.toThrow();
        expect(Array.from(kept.vertices)).toEqual(positions);
        expect(Array.from(kept.uvs)).toEqual(uvs);
        expect(Array.from(built.geometryData.uvs).every((v) => v === 0)).toBe(true);
        copy.destroy();
        source.destroy();
        system.destroy();
    });

    it('keeps textured UVs aligned after an untextured stroke in the same context', () =>
    {
        const source = new GraphicsContext()
            .moveTo(0, 0)
            .lineTo(10, 0)
            .stroke({ width: 2, cap: 'butt' })
            .moveTo(0, 20)
            .lineTo(10, 20)
            .stroke({ width: 2, cap: 'butt', texture: Texture.EMPTY });
        const built = new GpuGraphicsContext();

        buildContextBatches(source, built);
        const uvs = Array.from(built.geometryData.uvs);
        const split = built.batches[0].attributeSize * 2;

        expect(uvs.length).toBe(built.geometryData.vertices.length);
        expect(uvs.slice(0, split)).toEqual(Array(split).fill(0));
        expect(uvs.slice(split).some((value) => value !== 0)).toBe(true);
        built.destroy();
        source.destroy();
    });
});
