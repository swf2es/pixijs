import { Container } from '../../container/Container';
import { Graphics } from '../shared/Graphics';
import { GraphicsContext } from '../shared/GraphicsContext';
import { getWebGLRenderer } from '@test-utils';

import type { GraphicsPipe } from '../shared/GraphicsPipe';
import type { InstructionSet } from '~/rendering/renderers/shared/instructions/InstructionSet';

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

    it('should leave a Graphics drawn alone to an active alone drawer', async () =>
    {
        const renderer = await getWebGLRenderer();
        const pipe = renderer.renderPipes.graphics as GraphicsPipe;
        const alone = new Graphics(square('no-batch'));
        const batched = new Graphics(square('batch'));
        const stage = new Container();
        const added: Graphics[] = [];

        pipe.aloneDrawer = {
            active: true,
            add: (graphics: Graphics, _instructionSet: InstructionSet) => added.push(graphics),
        };
        stage.addChild(alone, batched);
        renderer.render(stage);

        expect(added).toEqual([alone]);
        expect(stage.renderGroup.instructionSet.instructions).not.toContain(alone);

        renderer.destroy();
    });

    it('should draw a Graphics alone with the shader shaderFor gives', async () =>
    {
        const renderer = await getWebGLRenderer();
        const pipe = renderer.renderPipes.graphics as GraphicsPipe;
        const adaptor = pipe['_adaptor'];
        const shader = adaptor.shader;
        const graphics = new Graphics(square('no-batch'));
        const stage = new Container();
        const asked: Graphics[] = [];
        const execute = jest.spyOn(adaptor, 'execute');

        pipe.shaderFor = (g) =>
        {
            asked.push(g);

            return shader;
        };
        stage.addChild(graphics);
        renderer.render(stage);

        expect(asked).toEqual([graphics]);
        expect(execute).toHaveBeenCalledWith(pipe, graphics, shader);

        execute.mockRestore();
        renderer.destroy();
    });
});
