import { Container } from '../Container';
import '../../text/init';
import { getWebGLRenderer, loseAndRestoreContext } from '@test-utils';
import { Texture } from '~/rendering/renderers/shared/texture/Texture';
import { Text } from '~/scene';
import { Sprite } from '~/scene/sprite/Sprite';

describe('RenderGroupSystem', () =>
{
    it('should reset childrenRenderablesToUpdate index between renders', async () =>
    {
        const renderer = await getWebGLRenderer();

        const container = new Container({ isRenderGroup: true });
        const text = new Text({ text: 'hello world' });

        container.addChild(text);

        expect(container.renderGroup.childrenRenderablesToUpdate.index).toEqual(0);

        renderer.render(container);

        text.text = 'hello world 2';
        expect(container.renderGroup.childrenRenderablesToUpdate.index).toEqual(1);

        renderer.render(container);

        expect(container.renderGroup.childrenRenderablesToUpdate.index).toEqual(0);
    });

    it('should only call on render once for a render group after conversion', async () =>
    {
        const renderer = await getWebGLRenderer();

        const container = new Container({ isRenderGroup: false, label: 'root' });

        const child = new Container({ isRenderGroup: true, label: 'child' });

        container.addChild(child);

        child.onRender = jest.fn();

        renderer.render(container);

        expect(child.onRender).toHaveBeenCalledTimes(1);
    });

    it('should only call on render once for a render group before conversion', async () =>
    {
        const renderer = await getWebGLRenderer();

        const container = new Container({ isRenderGroup: true, label: 'root' });

        const child = new Container({ isRenderGroup: true, label: 'child' });

        container.addChild(child);

        child.onRender = jest.fn();

        renderer.render(container);

        expect(child.onRender).toHaveBeenCalledTimes(1);
    });

    it('should correctly set scaleMode for render group texture source during rendering', async () =>
    {
        const renderer = await getWebGLRenderer();
        const container = new Container();

        container.cacheAsTexture({ scaleMode: 'nearest' });
        renderer.render(container);

        expect(container.renderGroup.texture._source.scaleMode).toEqual('nearest');
    });

    it('should tell onBuildInstructions of each build of a render group', async () =>
    {
        const renderer = await getWebGLRenderer();
        const container = new Container({ isRenderGroup: true });
        const built: unknown[] = [];

        renderer.renderGroup.onBuildInstructions = (renderGroup) => built.push(renderGroup);
        renderer.render(container);
        expect(built).toEqual([container.renderGroup]);

        renderer.render(container);
        expect(built).toHaveLength(1);

        container.addChild(new Container());
        renderer.render(container);
        expect(built).toEqual([container.renderGroup, container.renderGroup]);

        renderer.destroy();
    });

    it('should build every render group again for a context given back after a loss', async () =>
    {
        const renderer = await getWebGLRenderer();
        const root = new Container({ isRenderGroup: true });
        const child = new Container({ isRenderGroup: true });
        const builds: Container[] = [];

        child.addChild(new Sprite(Texture.WHITE));
        root.addChild(new Sprite(Texture.WHITE), child);
        renderer.renderGroup.onBuildInstructions = (group) => builds.push(group.root);

        renderer.render(root);
        renderer.render(root);
        expect(builds).toEqual([root, child]);

        await loseAndRestoreContext(renderer);
        builds.length = 0;
        renderer.render(root);
        expect(builds).toEqual([root, child]);

        // and only once
        renderer.render(root);
        expect(builds).toHaveLength(2);

        renderer.destroy();
    });

    it('should not build again a group another renderer rendered last', async () =>
    {
        const first = await getWebGLRenderer();
        const second = await getWebGLRenderer();
        const root = new Container({ isRenderGroup: true });
        const builds: Container[] = [];

        root.addChild(new Sprite(Texture.WHITE));
        first.renderGroup.onBuildInstructions = (group) => builds.push(group.root);
        second.renderGroup.onBuildInstructions = (group) => builds.push(group.root);

        first.render(root);
        second.render(root);
        first.render(root);
        expect(builds).toEqual([root]);

        first.destroy();
        second.destroy();
    });
});
