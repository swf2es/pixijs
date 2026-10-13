import { getWebGLRenderer } from '@test-utils';
import { TextureSource } from '~/rendering/renderers/shared/texture/sources/TextureSource';
import { Texture } from '~/rendering/renderers/shared/texture/Texture';

describe('GlTextureSystem', () =>
{
    it('should bind for an upload to the active unit, with premultiplied alpha unpacking off', async () =>
    {
        const renderer = await getWebGLRenderer();
        const textures = renderer.texture;
        const gl = renderer.gl;
        const texture = new Texture({ source: new TextureSource({ width: 4, height: 4 }) });
        const other = new Texture({
            source: new TextureSource({ width: 4, height: 4, alphaMode: 'premultiply-alpha-on-upload' }),
        });

        textures.bind(texture, 0);
        // another unit made active, and premultiplication on, as a later bind leaves them
        textures.bind(other, 3);

        textures.bindForUpload(texture, 0);

        expect(gl.getParameter(gl.ACTIVE_TEXTURE)).toBe(gl.TEXTURE0);
        expect(gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toBe(false);

        renderer.destroy();
    });
});
