import { Container } from '../Container';
import { updateRenderGroupTransforms } from '../utils/updateRenderGroupTransforms';

describe('Transform Alpha', () =>
{
    it('should cap render group alpha to between zero and one', async () =>
    {
        const root = new Container({ isRenderGroup: true });

        const parentContainer = new Container();

        const childContainer = new Container();

        root.addChild(parentContainer);
        parentContainer.addChild(childContainer);

        parentContainer.alpha = 20;
        childContainer.alpha = 3;

        updateRenderGroupTransforms(root.renderGroup, false);

        expect(childContainer.groupAlpha).toEqual(1);

        let groupAlpha = (childContainer.groupColorAlpha >>> 24) / 255;

        expect(groupAlpha).toEqual(1);

        parentContainer.alpha = -10;

        updateRenderGroupTransforms(root.renderGroup, false);

        expect(childContainer.groupAlpha).toEqual(0);

        groupAlpha = (childContainer.groupColorAlpha >>> 24) / 255;

        expect(groupAlpha).toEqual(0);
    });

    it('should draw a colour root and all below it uncoloured, a nested group too', async () =>
    {
        const root = new Container({ isRenderGroup: true });
        const parent = new Container();
        const colorRoot = new Container();
        const child = new Container();
        const group = new Container({ isRenderGroup: true });
        const inGroup = new Container();

        root.addChild(parent);
        parent.addChild(colorRoot);
        colorRoot.addChild(child);
        child.addChild(group);
        group.addChild(inGroup);

        root.alpha = 0.5;
        parent.alpha = 0.5;
        parent.tint = 0xff0000;
        colorRoot.alpha = 0.5;
        child.alpha = 0.5;
        colorRoot.colorRoot = true;

        updateRenderGroupTransforms(root.renderGroup, true);

        expect(colorRoot.groupAlpha).toEqual(1);
        expect(colorRoot.groupColor).toEqual(0xffffff);
        expect(child.groupAlpha).toEqual(0.5);
        expect(child.groupColor).toEqual(0xffffff);
        expect(group.renderGroup.worldAlpha).toEqual(0.5);
        expect(group.renderGroup.worldColor).toEqual(0xffffff);

        colorRoot.colorRoot = false;

        updateRenderGroupTransforms(root.renderGroup, true);

        expect(child.groupAlpha).toEqual(0.125);
        expect(group.renderGroup.worldAlpha).toEqual(0.0625);
    });
});

// Test to cover
