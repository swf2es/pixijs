import { AlphaFilter } from '../defaults/alpha/AlphaFilter';
import { getWebGLRenderer } from '@test-utils';
import { Rectangle } from '~/maths/shapes/Rectangle';
import { RenderTarget } from '~/rendering/renderers/shared/renderTarget/RenderTarget';
import { TextureSource } from '~/rendering/renderers/shared/texture/sources/TextureSource';
import { Texture } from '~/rendering/renderers/shared/texture/Texture';
import { TexturePool } from '~/rendering/renderers/shared/texture/TexturePool';
import { Bounds } from '~/scene/container/bounds/Bounds';
import { Container } from '~/scene/container/Container';
import { Graphics } from '~/scene/graphics/shared/Graphics';

import type { FilterEffect } from '../FilterEffect';
import type { BindGroup } from '~/rendering/renderers/gpu/shader/BindGroup';

function filtered(): Container
{
    const outer = new Container();
    const inner = new Container();

    inner.addChild(new Graphics().rect(10, 10, 20, 20).fill(0xff0000));
    inner.filters = [new AlphaFilter({ alpha: 0.5 })];
    outer.addChild(inner);
    outer.filters = [new AlphaFilter({ alpha: 0.5 })];

    return outer;
}

describe('FilterSystem', () =>
{
    it('should render a filter inside a filter after the pool destroyed its textures', async () =>
    {
        const renderer = await getWebGLRenderer();
        const stage = new Container();

        stage.addChild(filtered());
        renderer.render(stage);

        // as a resize does, which leaves the stack's last input textures without a source
        TexturePool.clear(true);

        expect(() => renderer.render(stage)).not.toThrow();

        renderer.destroy();
    });

    it('should bind an empty back texture of its own for a filter that reads none', async () =>
    {
        const renderer = await getWebGLRenderer();
        const stage = new Container();

        stage.addChild(filtered());
        renderer.render(stage);

        const group = renderer.filter['_globalFilterBindGroup'] as BindGroup;
        const back = group.resources[3];

        expect(back).toBeInstanceOf(TextureSource);
        expect(back).not.toBe(Texture.EMPTY.source);

        renderer.destroy();

        expect((back as TextureSource).destroyed).toBe(true);
    });

    it('should keep a padded filter region on the texels at a fractional resolution', async () =>
    {
        const renderer = await getWebGLRenderer({ resolution: 1.5 });
        const filter = new AlphaFilter();

        filter.padding = 1;
        filter.resolution = 'inherit';

        const filterData = renderer.filter['_pushFilterData']();

        filterData.bounds.set(0.3, 0.3, 10.2, 10.2);
        filterData.filters = [filter];
        filterData.skip = false;

        renderer.filter['_calculateFilterBounds'](filterData, new Rectangle(0, 0, 150, 150), false, 1.5, 1);

        const { minX, minY, maxX, maxY } = filterData.bounds;
        const texel = (v: number) => Math.round(v * 1.5 * 1e6) / 1e6;
        const texels = [texel(minX), texel(minY), texel(maxX), texel(maxY)];

        expect(filterData.skip).toBe(false);
        expect(texels).toEqual([-2, -2, 18, 18]);

        renderer.destroy();
    });

    it('should copy what is behind from the pixels the bounds are on', async () =>
    {
        const renderer = await getWebGLRenderer();
        const resolution = 1.62;
        const target = new RenderTarget({
            colorTextures: [new TextureSource({ width: 100, height: 100, resolution })],
        });
        // 27 / 1.62 * 1.62 is a hair short of 27
        const bounds = new Bounds(27 / resolution, 54 / resolution, 61 / resolution, 108 / resolution);
        const spy = jest.spyOn(renderer.renderTarget, 'copyToTexture');

        renderer.filter.getBackTexture(target, bounds);

        const [, , origin, size, to] = spy.mock.calls[0];

        expect([origin, size, to]).toEqual([
            { x: 27, y: 54 },
            { width: 34, height: 54 },
            { x: 0, y: 0 },
        ]);

        spy.mockRestore();
        renderer.destroy();
    });

    it('should measure a filtered child by what its filters draw past its shapes', async () =>
    {
        const renderer = await getWebGLRenderer();
        const stage = new Container();
        const outer = filtered();
        const inner = outer.children[0];

        outer.filters[0].padding = 4;
        inner.filters[0].padding = 8;
        stage.addChild(outer);
        renderer.render(stage);

        const bounds = new Bounds();

        renderer.filter['_calculateFilterArea']({
            renderPipeId: 'filter',
            action: 'pushFilter',
            canBundle: false,
            container: outer,
            filterEffect: outer.effects[0] as FilterEffect,
        }, bounds);

        // the child's shapes, padded by its filter, but not by the outer filter, which push pads by
        expect(bounds).toMatchObject({ minX: 2, minY: 2, maxX: 38, maxY: 38 });

        renderer.destroy();
    });

    it('should measure a filter\'s area with filterAreaHook, which may ask for its own measure', async () =>
    {
        const renderer = await getWebGLRenderer();
        const stage = new Container();
        const outer = filtered();
        const measured: Bounds[] = [];

        stage.addChild(outer);
        renderer.filter.filterAreaHook = (instruction, bounds, system) =>
        {
            expect(instruction.filterEffect._measuring).toBe(true);
            system.measureFilterArea(instruction, bounds);
            measured.push(bounds.clone());
        };
        renderer.render(stage);

        // the outer filter's, then the inner's, by their shapes
        expect(measured.map(({ minX, minY, maxX, maxY }) => [minX, minY, maxX, maxY]))
            .toEqual([[10, 10, 30, 30], [10, 10, 30, 30]]);

        renderer.destroy();
    });

    it('should give the active filter\'s bounds as it applies', async () =>
    {
        const renderer = await getWebGLRenderer();
        const stage = new Container();
        const outer = filtered();
        const filter = outer.filters[0];
        const seen: number[][] = [];

        filter.apply = (system, input, output, clear) =>
        {
            const { minX, minY, maxX, maxY } = system.activeBounds;

            seen.push([minX, minY, maxX, maxY]);
            system.applyFilter(filter, input, output, clear);
        };
        stage.addChild(outer);
        renderer.render(stage);

        expect(seen).toEqual([[10, 10, 30, 30]]);

        renderer.destroy();
    });
});
