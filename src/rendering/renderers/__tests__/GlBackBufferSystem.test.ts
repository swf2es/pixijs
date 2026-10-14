import { RenderTexture } from '../shared/texture/RenderTexture';
import { getWebGLRenderer } from '@test-utils';
import { Container } from '~/scene';

import type { WebGLRenderer } from '../gl/WebGLRenderer';

describe('GlBackBufferSystem', () =>
{
    it('should activate only when the target is a canvas element (rather than a render texture)', async () =>
    {
        const renderer = await getWebGLRenderer({}) as WebGLRenderer;
        const container = new Container();

        renderer.backBuffer.useBackBuffer = false;

        renderer.backBuffer['renderStart']({
            target: renderer.view.texture,
            container
        });

        expect(renderer.backBuffer['_useBackBufferThisRender']).toEqual(false);

        renderer.backBuffer.useBackBuffer = true;

        renderer.backBuffer['renderStart']({
            target: renderer.view.texture,
            container
        });

        expect(renderer.backBuffer['_useBackBufferThisRender']).toEqual(true);

        const texture = RenderTexture.create({
            width: 100,
            height: 100,
        });

        renderer.backBuffer['renderStart']({
            target: texture,
            container
        });

        expect(renderer.backBuffer['_useBackBufferThisRender']).toEqual(false);
    });

    it('should deactivate antialiasing if active', async () =>
    {
        const renderer = await getWebGLRenderer({ antialias: true, useBackBuffer: true }) as WebGLRenderer;

        const container = new Container();

        const options = {
            target: renderer.view.texture,
            container
        };

        renderer.backBuffer['renderStart']({
            target: renderer.view.texture,
            container
        });

        expect(renderer.gl.getContextAttributes().antialias).toEqual(false);
        expect(options.target.source.antialias).toEqual(true);
    });

    it('should replace the canvas with the back buffer, not blend over it', async () =>
    {
        const renderer = await getWebGLRenderer({ useBackBuffer: true, preserveDrawingBuffer: true }) as WebGLRenderer;
        const gl = renderer.gl;
        const container = new Container();

        // A frame whose pixels are all clear, over a canvas that kept an opaque one. Both are
        // Pixi's: it keeps the clear colour it last set, which a clear of the test's own would change.
        renderer.render({ container, clearColor: [1, 0, 0, 1] });
        renderer.render({ container, clearColor: [0, 0, 0, 0] });

        const pixel = new Uint8Array(4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

        expect(renderer.backBuffer['_state'].blend).toEqual(false);
        expect(pixel[0]).toEqual(0);
    });
});
