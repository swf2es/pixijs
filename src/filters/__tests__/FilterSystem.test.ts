import { AlphaFilter } from '../defaults/alpha/AlphaFilter';
import { getWebGLRenderer } from '@test-utils';
import { TexturePool } from '~/rendering/renderers/shared/texture/TexturePool';
import { Container } from '~/scene/container/Container';
import { Graphics } from '~/scene/graphics/shared/Graphics';

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
});
