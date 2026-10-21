import { RenderTexture } from '../shared/texture/RenderTexture';
import { getWebGLRenderer } from '@test-utils';
import { Container } from '~/scene';

import type { WebGLRenderer } from '../gl/WebGLRenderer';

describe('GlBackBufferSystem', () =>
{
    it('should release its shader binding before quality changes or shutdown destroy the back buffer', async () =>
    {
        const renderer = await getWebGLRenderer({ useBackBuffer: true }) as WebGLRenderer;
        const container = new Container();
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* collected below */ });

        try
        {
            for (let i = 0; i < 6; i++)
            {
                renderer.render({ container, clearColor: [1, 0, 0, 1] });
                const retired = renderer.backBuffer['_backBufferTexture'].source;

                renderer.backBuffer.antialias = !renderer.backBuffer.antialias;
                expect(retired.destroyed).toBe(true);
                expect(renderer.backBuffer['_bigTriangleShader'].resources.uTexture).not.toBe(retired);
            }

            renderer.render({ container, clearColor: [0, 1, 0, 1] });
            const pixel = new Uint8Array(4);
            const gl = renderer.gl;

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            expect(Array.from(pixel)).toEqual([0, 255, 0, 255]);
        }
        finally
        {
            renderer.destroy();
            container.destroy();
            const warnings = warn.mock.calls.filter((args) => args.join(' ').includes('destroyed while still bound'));

            warn.mockRestore();
            expect(warnings).toHaveLength(0);
        }
    });

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
