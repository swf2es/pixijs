import { Container } from '../../container/Container';
import { Graphics } from '../shared/Graphics';
import { GraphicsContext } from '../shared/GraphicsContext';
import { getWebGLRenderer } from '@test-utils';

import type { GraphicsPipe } from '../shared/GraphicsPipe';

function square(batchMode: 'auto' | 'batch' | 'no-batch', color = 0xff0000): GraphicsContext
{
    const context = new GraphicsContext().rect(0, 0, 10, 10).fill(color);

    context.batchMode = batchMode;

    return context;
}

describe('GraphicsPipe', () =>
{
    it('should not rebuild for a Graphics drawn alone whose context changes', async () =>
    {
        const renderer = await getWebGLRenderer();
        const pipe = renderer.renderPipes.graphics as GraphicsPipe;
        const graphics = new Graphics(square('no-batch'));
        const stage = new Container();

        stage.addChild(graphics);
        renderer.render(stage);

        expect(graphics._gpuData[renderer.uid].batched).toBe(false);
        expect(pipe.validateRenderable(graphics)).toBe(false);

        // Another context still drawn alone needs no rebuild either.
        graphics.context = square('no-batch', 0x00ff00);
        expect(pipe.validateRenderable(graphics)).toBe(false);

        // One that is batched now does.
        graphics.context = square('batch');
        expect(pipe.validateRenderable(graphics)).toBe(true);

        renderer.destroy();
    });

    it('should rebuild for a batched Graphics', async () =>
    {
        const renderer = await getWebGLRenderer();
        const pipe = renderer.renderPipes.graphics as GraphicsPipe;
        const graphics = new Graphics(square('batch'));
        const stage = new Container();

        stage.addChild(graphics);
        renderer.render(stage);

        expect(graphics._gpuData[renderer.uid].batched).toBe(true);
        expect(pipe.validateRenderable(graphics)).toBe(true);

        // Drawn alone from now on, it needs an instruction of its own.
        graphics.context = square('no-batch');
        expect(pipe.validateRenderable(graphics)).toBe(true);

        renderer.destroy();
    });
});
