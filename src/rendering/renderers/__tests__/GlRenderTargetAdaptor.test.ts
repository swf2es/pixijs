import { RenderTarget } from '../shared/renderTarget/RenderTarget';
import { TextureSource } from '../shared/texture/sources/TextureSource';
import { Texture } from '../shared/texture/Texture';
import { getWebGLRenderer } from '@test-utils';

import type { WebGLRenderer } from '../gl/WebGLRenderer';

describe('GlRenderTargetAdaptor', () =>
{
    let renderer: WebGLRenderer;

    afterEach(() =>
    {
        renderer?.destroy();
        renderer = null;
    });

    it('should make a repeat destroyGpuRenderTarget a no-op', async () =>
    {
        renderer = await getWebGLRenderer({});

        const renderTarget = new RenderTarget({
            colorTextures: [new TextureSource({ width: 64, height: 64, antialias: true })],
            stencil: true,
        });

        renderer.renderTarget.bind({ target: renderTarget });
        renderer.renderTarget.finishRenderPass();

        const gpuRenderTarget = renderer.renderTarget.getGpuRenderTarget(renderTarget);

        // every delete branch needs something to free: the msaa view and resolve framebuffers,
        // one msaa colour renderbuffer and the depth-stencil renderbuffer
        expect(gpuRenderTarget.msaa).toBe(true);
        expect(gpuRenderTarget.msaaRenderBuffer).toHaveLength(1);
        expect(gpuRenderTarget.depthStencilRenderBuffer).toBeTruthy();

        const deleteFramebuffer = jest.spyOn(renderer.gl, 'deleteFramebuffer');
        const deleteRenderbuffer = jest.spyOn(renderer.gl, 'deleteRenderbuffer');
        const { adaptor } = renderer.renderTarget;

        adaptor.destroyGpuRenderTarget(gpuRenderTarget);

        expect(deleteFramebuffer).toHaveBeenCalledTimes(2);
        expect(deleteRenderbuffer).toHaveBeenCalledTimes(2);

        expect(() => adaptor.destroyGpuRenderTarget(gpuRenderTarget)).not.toThrow();

        expect(deleteFramebuffer).toHaveBeenCalledTimes(2);
        expect(deleteRenderbuffer).toHaveBeenCalledTimes(2);
        expect(gpuRenderTarget.framebuffer).toBeNull();
        expect(gpuRenderTarget.resolveTargetFramebuffer).toBeNull();
        expect(gpuRenderTarget.depthStencilRenderBuffer).toBeNull();
        expect(gpuRenderTarget.msaaRenderBuffer).toEqual([]);
    });

    function multisampled(): RenderTarget
    {
        return new RenderTarget({
            colorTextures: [new TextureSource({ width: 64, height: 64, antialias: true })],
        });
    }

    it('should resolve only the region a copy out of a multisampled target reads', async () =>
    {
        renderer = await getWebGLRenderer({});

        const gl = renderer.gl;
        const target = multisampled();
        const destination = new Texture({ source: new TextureSource({ width: 32, height: 32 }) });

        renderer.renderTarget.bind({ target });

        const blit = jest.spyOn(gl, 'blitFramebuffer');

        renderer.renderTarget.copyToTexture(target, destination, { x: 4, y: 8 }, { width: 16, height: 12 }, { x: 2, y: 3 });

        expect(blit.mock.calls).toEqual([[4, 8, 20, 20, 4, 8, 20, 20, gl.COLOR_BUFFER_BIT, gl.NEAREST]]);

        // a resolve otherwise is whole
        blit.mockClear();
        renderer.renderTarget.finishRenderPass();

        expect(blit.mock.calls).toEqual([[0, 0, 64, 64, 0, 0, 64, 64, gl.COLOR_BUFFER_BIT, gl.NEAREST]]);
    });

    it('should defer resolves while a filter\'s textures are set up, and the back buffer\'s while it applies',
        async () =>
        {
            renderer = await getWebGLRenderer({});

            const target = multisampled();
            const filter = renderer.filter;

            renderer.renderTarget.bind({ target });

            const blit = jest.spyOn(renderer.gl, 'blitFramebuffer');

            filter._preparing++;
            renderer.renderTarget.finishRenderPass();
            filter._preparing--;
            expect(blit).not.toHaveBeenCalled();

            // the target taken for the back buffer
            const isBackBufferTarget = jest.spyOn(renderer.backBuffer, 'isBackBufferTarget')
                .mockImplementation((renderTarget) => renderTarget === target);

            filter._applying++;
            renderer.renderTarget.finishRenderPass();
            expect(blit).not.toHaveBeenCalled();

            isBackBufferTarget.mockReturnValue(false);
            renderer.renderTarget.finishRenderPass();
            filter._applying--;
            expect(blit).toHaveBeenCalledTimes(1);
        });

    /** A spy on the multisampled renderbuffers' storage: each call's second argument is its samples. */
    function storedSamples(): jest.SpyInstance
    {
        return jest.spyOn(renderer.gl as WebGL2RenderingContext, 'renderbufferStorageMultisample');
    }

    it('should multisample a target with the samples asked for, up to the most the context allows', async () =>
    {
        renderer = await getWebGLRenderer({});

        const gl = renderer.gl as WebGL2RenderingContext;
        const max = gl.getParameter(gl.MAX_SAMPLES) as number;
        const { adaptor } = renderer.renderTarget;
        const stored = storedSamples();

        adaptor.msaaSamples = 2;
        renderer.renderTarget.bind({ target: multisampled() });
        renderer.renderTarget.finishRenderPass();

        expect(stored.mock.calls.map((call) => call[1])).toEqual([Math.min(2, max)]);

        stored.mockClear();
        adaptor.msaaSamples = max * 4;
        expect(adaptor.msaaSamples).toBe(max);

        renderer.renderTarget.bind({ target: multisampled() });
        renderer.renderTarget.finishRenderPass();

        expect(stored.mock.calls.map((call) => call[1])).toEqual([max]);
    });

    it('should remake a target\'s buffers with new samples the next time it is drawn into', async () =>
    {
        renderer = await getWebGLRenderer({});

        const { adaptor } = renderer.renderTarget;
        const target = new RenderTarget({
            colorTextures: [new TextureSource({ width: 64, height: 64, antialias: true })],
            stencil: true,
        });

        adaptor.msaaSamples = 1;
        renderer.renderTarget.bind({ target });
        renderer.renderTarget.finishRenderPass();

        const stored = storedSamples();

        // as asked again: nothing remade
        renderer.renderTarget.bind({ target });
        renderer.renderTarget.finishRenderPass();
        expect(stored).not.toHaveBeenCalled();

        adaptor.msaaSamples = 2;
        renderer.renderTarget.bind({ target });
        renderer.renderTarget.finishRenderPass();

        // colour and depth-stencil alike, or the framebuffer is incomplete
        const samples = adaptor.msaaSamples;

        expect(stored.mock.calls.map((call) => call[1])).toEqual([samples, samples]);
        expect(renderer.renderTarget.getGpuRenderTarget(target).samples).toBe(samples);
    });

    it('should give the back buffer its own samples', async () =>
    {
        renderer = await getWebGLRenderer({});

        const { adaptor } = renderer.renderTarget;
        const backBuffer = multisampled();
        const layer = multisampled();

        jest.spyOn(renderer.backBuffer, 'isBackBufferTarget')
            .mockImplementation((renderTarget) => renderTarget === backBuffer);

        adaptor.msaaSamples = 1;
        adaptor.backBufferSamples = 2;

        renderer.renderTarget.bind({ target: backBuffer });
        renderer.renderTarget.finishRenderPass();
        renderer.renderTarget.bind({ target: layer });
        renderer.renderTarget.finishRenderPass();

        expect(renderer.renderTarget.getGpuRenderTarget(backBuffer).samples).toBe(adaptor.backBufferSamples);
        expect(renderer.renderTarget.getGpuRenderTarget(layer).samples).toBe(adaptor.msaaSamples);
    });
});
