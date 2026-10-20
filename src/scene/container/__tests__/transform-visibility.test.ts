import { Container } from '../Container';
import { updateRenderGroupTransforms } from '../utils/updateRenderGroupTransforms';

describe('Transform Visibility', () =>
{
    it('should isolate a visibility root without losing ancestor transforms or its own flags', () =>
    {
        const root = new Container({ isRenderGroup: true });
        const parent = root.addChild(new Container());
        const mask = parent.addChild(new Container());
        const part = mask.addChild(new Container());

        parent.position.set(20, 30);
        parent.visible = false;
        parent.renderable = false;
        parent.culled = true;
        updateRenderGroupTransforms(root.renderGroup, true);
        expect(part.globalDisplayStatus).toBe(0);

        root.renderGroup.structureDidChange = false;
        mask.visibilityRoot = true;
        expect(root.renderGroup.structureDidChange).toBeTrue();
        updateRenderGroupTransforms(root.renderGroup, true);
        expect(part.globalDisplayStatus).toBe(0b111);
        expect(part.relativeGroupTransform.tx).toBe(20);
        expect(part.relativeGroupTransform.ty).toBe(30);
        expect(parent.globalDisplayStatus).toBe(0);

        mask.visible = false;
        updateRenderGroupTransforms(root.renderGroup, true);
        expect(part.globalDisplayStatus).toBe(0b101);
        mask.visible = true;
        part.renderable = false;
        updateRenderGroupTransforms(root.renderGroup, true);
        expect(part.globalDisplayStatus).toBe(0b110);
        part.renderable = true;

        mask.visibilityRoot = false;
        updateRenderGroupTransforms(root.renderGroup, true);
        expect(part.globalDisplayStatus).toBe(0);
        root.destroy({ children: true });
    });

    it('should not cause a rebuild if visibility is changed on a layer', async () =>
    {
        const root = new Container({ isRenderGroup: true });

        root.renderGroup.structureDidChange = false;

        root.visible = false;

        expect(root.visible).toEqual(false);
        expect(root.renderGroup.structureDidChange).toEqual(false);
    });

    it('should cause a rebuild if visibility is changed on a child', async () =>
    {
        const root = new Container({ isRenderGroup: true });

        root.renderGroup.structureDidChange = false;

        const child = new Container();

        root.addChild(child);

        child.visible = false;

        expect(root.renderGroup.structureDidChange).toEqual(true);
    });

    it('should inherit visibility on the scene graph', async () =>
    {
        const root = new Container({ isRenderGroup: true, label: 'root' });

        const container = new Container({ label: 'container' });

        const child = new Container({ label: 'child' });

        root.addChild(container);

        container.addChild(child);

        container.visible = false;

        updateRenderGroupTransforms(root.renderGroup, true);

        expect(child.globalDisplayStatus).toEqual(0b101);

        container.visible = true;

        updateRenderGroupTransforms(root.renderGroup, true);

        expect(child.globalDisplayStatus).toEqual(0b111);
    });

    it('should inherit visibility when children swapped around on the scene graph', async () =>
    {
        const root = new Container({ isRenderGroup: true, label: 'root' });

        const container = new Container({ label: 'container' });
        const containerHidden = new Container({ label: 'containerAdd' });

        const child = new Container({ label: 'child' });

        root.addChild(container);
        root.addChild(containerHidden);

        container.addChild(child);

        containerHidden.visible = false;

        updateRenderGroupTransforms(root.renderGroup, true);

        expect(child.globalDisplayStatus).toEqual(0b111);

        containerHidden.addChild(child);

        updateRenderGroupTransforms(root.renderGroup, true);

        expect(child.globalDisplayStatus).toEqual(0b101);
    });

    it('should not cause a rebuild if renderable is changed on a layer', async () =>
    {
        const root = new Container({ isRenderGroup: true });

        root.renderGroup.structureDidChange = false;

        root.renderable = false;

        expect(root.renderable).toEqual(false);

        expect(root.renderGroup.structureDidChange).toEqual(false);
    });

    it('should set both renderable and visible correctly in layerVisibleRenderable prop', async () =>
    {
        const root = new Container({ isRenderGroup: true, label: 'root' });

        const container = new Container({ label: 'container' });

        const child = new Container({ label: 'child' });

        root.addChild(container);

        container.addChild(child);

        container.visible = false;
        container.renderable = false;
        container.culled = true;

        updateRenderGroupTransforms(root.renderGroup, true);

        expect(child.globalDisplayStatus).toEqual(0b000);

        container.visible = true;
        container.renderable = true;
        container.culled = false;

        updateRenderGroupTransforms(root.renderGroup, true);

        expect(child.globalDisplayStatus).toEqual(0b111);
    });

    it('should cause a rebuild if visibility is changed on a child before it is added', async () =>
    {
        const root = new Container({ isRenderGroup: true });
        const container = new Container();

        root.renderGroup.structureDidChange = false;

        const child = new Container();

        child.visible = false;
        container.visible = false;

        root.addChild(container);
        container.addChild(child);

        updateRenderGroupTransforms(root.renderGroup, true);

        expect(root.renderGroup.structureDidChange).toEqual(true);

        root.renderGroup.structureDidChange = false;

        container.visible = true;

        expect(root.renderGroup.structureDidChange).toEqual(true);
    });
});

// Test to cover
