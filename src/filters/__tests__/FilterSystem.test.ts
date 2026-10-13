import { AlphaFilter } from '../defaults/alpha/AlphaFilter';
import { getWebGLRenderer } from '@test-utils';
import { Rectangle } from '~/maths/shapes/Rectangle';
import { TextureSource } from '~/rendering/renderers/shared/texture/sources/TextureSource';
import { Texture } from '~/rendering/renderers/shared/texture/Texture';
import { TexturePool } from '~/rendering/renderers/shared/texture/TexturePool';
import { Container } from '~/scene/container/Container';
import { Graphics } from '~/scene/graphics/shared/Graphics';

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
});
