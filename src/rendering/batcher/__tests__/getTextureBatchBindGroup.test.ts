import { getTextureBatchBindGroup } from '../gpu/getTextureBatchBindGroup';
import { TextureSource } from '~/rendering';

describe('getTextureBatchBindGroup', () =>
{
    it('should drop the groups of a destroyed source, without a warning', () =>
    {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* empty */ });
        const a = new TextureSource({ width: 1, height: 1 });
        const b = new TextureSource({ width: 1, height: 1 });
        const both = getTextureBatchBindGroup([a, b], 2, 4);
        const alone = getTextureBatchBindGroup([b], 1, 4);

        expect(getTextureBatchBindGroup([a, b], 2, 4)).toBe(both);

        a.destroy();

        expect(warn).not.toHaveBeenCalled();
        expect(both.resources).toBeNull();
        expect(getTextureBatchBindGroup([b], 1, 4)).toBe(alone);
        expect(alone.resources).not.toBeNull();

        const c = new TextureSource({ width: 1, height: 1 });
        const again = getTextureBatchBindGroup([c, b], 2, 4);

        expect(again).not.toBe(both);
        expect(again.resources[0]).toBe(c);

        warn.mockRestore();
    });
});
