import { AlphaFilter } from '../defaults/alpha/AlphaFilter';
import { getWebGLRenderer } from '@test-utils';
import { RenderTexture } from '~/rendering/renderers/shared/texture/RenderTexture';
import { Texture } from '~/rendering/renderers/shared/texture/Texture';
import { Container } from '~/scene/container/Container';
import { Graphics } from '~/scene/graphics/shared/Graphics';

import type { FilterData, FilterSystem } from '../FilterSystem';

/** An alpha filter that hands back `kept` once given one, as a filter caching its output would. */
class Reusing extends AlphaFilter
{
    public kept: Texture | null = null;
    public asked = 0;

    public override reusedOutput(_system: FilterSystem, _data: FilterData): Texture | null
    {
        this.asked++;

        return this.kept;
    }
}

describe('Filter reusedOutput', () =>
{
    it('should draw a reused output in place of the object, without drawing the object', async () =>
    {
        const renderer = await getWebGLRenderer();
        const stage = new Container();
        const filtered = new Container();

        filtered.addChild(new Graphics().rect(0, 0, 10, 10).fill(0xff0000));
        stage.addChild(filtered);

        const filter = new Reusing({ alpha: 1 });

        filtered.filters = [filter];

        const target = RenderTexture.create({ width: 10, height: 10 });
        const draws = (): number =>
        {
            const pipes = renderer.renderPipes as unknown as Record<string, { execute?: (...a: unknown[]) => void }>;
            const count = { calls: 0 };

            for (const name of ['batch', 'graphics'])
            {
                const pipe = pipes[name];
                const execute = pipe.execute;

                pipe.execute = (...a: unknown[]) =>
                {
                    count.calls++;
                    execute.apply(pipe, a);
                };
            }

            renderer.render({ container: stage, target, clear: true });

            for (const name of ['batch', 'graphics']) delete pipes[name].execute;

            return count.calls;
        };

        // drawn and run as usual while it keeps nothing
        expect(draws()).toBeGreaterThan(0);
        expect(filter.asked).toBe(1);
        expect(Array.from(renderer.extract.pixels(target).pixels.slice(0, 4))).toEqual([255, 0, 0, 255]);

        // given back, it is drawn in the object's place, and the object is not drawn
        filter.kept = Texture.WHITE;
        expect(draws()).toBe(0);
        expect(filter.asked).toBe(2);
        expect(Array.from(renderer.extract.pixels(target).pixels.slice(0, 4))).toEqual([255, 255, 255, 255]);

        renderer.destroy();
    });
});
