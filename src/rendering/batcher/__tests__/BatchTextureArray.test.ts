import { BatchTextureArray } from '../shared/BatchTextureArray';
import { TextureSource } from '~/rendering';

describe('BatchTextureArray', () =>
{
    it('should leave no locations behind once cleared', () =>
    {
        const array = new BatchTextureArray();

        for (let round = 0; round < 3; round++)
        {
            for (let i = 0; i < 4; i++)
            {
                const source = new TextureSource();

                array.ids[source.uid] = array.count;
                array.textures[array.count++] = source;
            }

            array.clear();

            expect(Object.keys(array.ids)).toHaveLength(0);
            expect(array.count).toBe(0);
        }
    });
});
