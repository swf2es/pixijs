import { ExtensionType } from '../../extensions/Extensions';
import { Matrix } from '../../maths/matrix/Matrix';
import { TexturePool } from '../../rendering/renderers/shared/texture/TexturePool';
import { Bounds } from './bounds/Bounds';
import { clearList } from './utils/clearList';
import { executeInstructions } from './utils/executeInstructions';
import { updateRenderGroupTransforms } from './utils/updateRenderGroupTransforms';
import { validateRenderables } from './utils/validateRenderables';

import type { WebGPURenderer } from '../../rendering/renderers/gpu/WebGPURenderer';
import type { System } from '../../rendering/renderers/shared/system/System';
import type { Renderer, RenderPipes } from '../../rendering/renderers/types';
import type { ViewContainer } from '../view/ViewContainer';
import type { Container } from './Container';
import type { RenderGroup } from './RenderGroup';

const tempMatrix = new Matrix();

/**
 * The view system manages the main canvas that is attached to the DOM.
 * This main role is to deal with how the holding the view reference and dealing with how it is resized.
 * @category rendering
 * @internal
 */
export class RenderGroupSystem implements System
{
    /** @ignore */
    public static extension = {
        type: [
            ExtensionType.WebGLSystem,
            ExtensionType.WebGPUSystem,
            ExtensionType.CanvasSystem,
        ],
        name: 'renderGroup',
    } as const;

    /**
     * Called as a render group's instructions are about to be built again, its structure having changed:
     * for a renderer that times how long a group goes unchanged, as swf2es batches the Graphics of a
     * group that has not been rebuilt for a while. `forced` is true where the build is only for a new
     * context or another renderer, the group's structure as it was: no change of the group's own. A
     * change found while its transforms are updated, in the same frame, is not told apart from it.
     */
    public onBuildInstructions: ((renderGroup: RenderGroup, forced: boolean) => void) | null = null;

    /**
     * Opts a group into deferring dirty instructions while invisible. Its owner must guarantee
     * that no mask or render layer outside the group draws any of its contents. Transforms and
     * onRender callbacks still run; obsolete instructions and batchers are released until reveal.
     * Render roots and cached textures are never deferred.
     */
    public canDeferInvisibleGroup: ((renderGroup: RenderGroup) => boolean) | null = null;

    private readonly _renderer: Renderer;

    /** Counts the contexts the renderer has had: a group built for an earlier one is built again. */
    private _context = 0;

    constructor(renderer: Renderer)
    {
        this._renderer = renderer;
    }

    /**
     * A new context, as the renderer starts or a lost one is given back: every render group is to build
     * its instructions again as it is next rendered, so that its batches are packed and uploaded anew
     * from the scene, rather than from copies kept of what was uploaded to the context lost.
     */
    protected contextChange(): void
    {
        this._context++;
    }

    /**
     * Whether the renderer's batch pipe keeps batches on the GPU alone (BatcherPipe.gpuResident), or it
     * is destroyed, its batchers with it.
     * @internal
     */
    public _keepsBatchesOnGpu(): boolean
    {
        const batch = this._renderer?.renderPipes?.batch as { gpuResident?: boolean } | undefined;

        return !this._renderer || !!batch?.gpuResident;
    }

    protected render({ container, transform }: {container: Container, transform: Matrix}): void
    {
        // we need to save the parent and renderGroupParent, so we can restore them later
        const parent = container.parent;
        const renderGroupParent = container.renderGroup.renderGroupParent;

        // we set the transforms and parents to null, so we can render the container without any transforms
        container.parent = null;
        container.renderGroup.renderGroupParent = null;

        const renderer = this._renderer;

        // collect all the renderGroups in the scene and then render them one by one..
        const originalLocalTransform: Matrix = tempMatrix;

        if (transform)
        {
            originalLocalTransform.copyFrom(container.renderGroup.localTransform);
            container.renderGroup.localTransform.copyFrom(transform);
        }

        //  this._assignTop(container.renderGroup, null);
        const renderPipes = (renderer as WebGPURenderer).renderPipes;

        this._updateCachedRenderGroups(container.renderGroup, null);

        this._updateRenderGroups(container.renderGroup);

        renderer.globalUniforms.start({
            worldTransformMatrix: transform ? container.renderGroup.localTransform : container.renderGroup.worldTransform,
            worldColor: container.renderGroup.worldColorAlpha,
        });

        executeInstructions(container.renderGroup, renderPipes);

        // TODO need to add some events / runners for things like this to hook up to
        if (renderPipes.uniformBatch)
        {
            renderPipes.uniformBatch.renderEnd();
        }

        // now return the transforms back to normal..
        if (transform)
        {
            container.renderGroup.localTransform.copyFrom(originalLocalTransform);
        }

        container.parent = parent;
        container.renderGroup.renderGroupParent = renderGroupParent;
    }

    public destroy()
    {
        (this._renderer as null) = null;
    }

    private _updateCachedRenderGroups(renderGroup: RenderGroup, closestCacheAsTexture: RenderGroup | null): void
    {
        renderGroup._parentCacheAsTextureRenderGroup = closestCacheAsTexture;

        if (renderGroup.isCachedAsTexture)
        {
            // Early out as nothing further needs to be updated!
            if (!renderGroup.textureNeedsUpdate) return;

            closestCacheAsTexture = renderGroup;
        }

        // Update the closest cache reference for children if this render group is cached as texture
        for (let i = renderGroup.renderGroupChildren.length - 1; i >= 0; i--)
        {
            this._updateCachedRenderGroups(renderGroup.renderGroupChildren[i], closestCacheAsTexture);
        }

        renderGroup.invalidateMatrices();

        if (renderGroup.isCachedAsTexture)
        {
            if (renderGroup.textureNeedsUpdate)
            {
                // lets get the texture ready for rendering
                // but the rendering will not happen until the renderGroup is rendered!
                // We also want to know now, what the bounds of the texture will be.
                // as if the texture changes, we need to invalidate the parent render group!
                const bounds = renderGroup.root.getLocalBounds();
                const renderer = this._renderer;
                const resolution = renderGroup.textureOptions.resolution || renderer.view.resolution;
                const antialias = renderGroup.textureOptions.antialias ?? renderer.view.antialias;
                const scaleMode = renderGroup.textureOptions.scaleMode ?? 'linear';
                const lastTexture = renderGroup.texture;

                bounds.ceil();

                if (renderGroup.texture)
                {
                    TexturePool.returnTexture(renderGroup.texture);
                }

                const texture = TexturePool.getOptimalTexture({
                    width: bounds.width,
                    height: bounds.height,
                    resolution,
                    antialias,
                    scaleMode,
                });

                renderGroup.texture = texture;
                renderGroup._textureBounds ||= new Bounds();
                renderGroup._textureBounds.copyFrom(bounds);

                if (lastTexture !== renderGroup.texture)
                {
                    if (renderGroup.renderGroupParent)
                    {
                        renderGroup.renderGroupParent.structureDidChange = true;
                    }
                }
            }
        }
        else if (renderGroup.texture)
        {
            TexturePool.returnTexture(renderGroup.texture);
            renderGroup.texture = null;
        }
    }

    private _updateRenderGroups(renderGroup: RenderGroup): void
    {
        const renderer = this._renderer;
        const renderPipes = renderer.renderPipes;

        renderGroup.runOnRender(renderer);

        if (this._canDeferInvisibleGroup(renderGroup))
        {
            // Retire obsolete scene references and GPU batches, but keep transforms current for
            // bounds and for a child rendered separately. The dirty flag survives until reveal.
            if (renderGroup.instructionSet.renderPipes)
            {
                renderGroup.instructionSet.destroy();
                renderGroup.instructionSet.reset();
            }

            renderGroup._contextOf = null;
            renderGroup._builtForContext = -1;
            renderGroup.structureDidChange = true;
            clearList(renderGroup.childrenRenderablesToUpdate.list, 0);
            updateRenderGroupTransforms(renderGroup);
            renderGroup.childrenRenderablesToUpdate.index = 0;

            for (let i = 0; i < renderGroup.renderGroupChildren.length; i++)
            {
                this._updateRenderGroups(renderGroup.renderGroupChildren[i]);
            }

            return;
        }

        renderGroup.instructionSet.renderPipes = renderPipes;

        const last = renderGroup._contextOf as RenderGroupSystem | null;
        let forced = false;

        if (last !== this || renderGroup._builtForContext !== this._context)
        {
            // built for this renderer's lost context, or by another renderer where either keeps its
            // batches on the GPU alone, with nothing on the CPU for the other to upload or update; a
            // group new to it is built anyway, and one another renderer built is otherwise drawn from
            // what that renderer's batchers keep
            if (last === this || (last && (last._keepsBatchesOnGpu() || this._keepsBatchesOnGpu())))
            {
                forced = !renderGroup.structureDidChange;
                renderGroup.structureDidChange = true;
            }

            renderGroup._contextOf = this;
            renderGroup._builtForContext = this._context;
        }

        if (!renderGroup.structureDidChange)
        {
            // phase 1 - validate all the renderables
            validateRenderables(renderGroup, renderPipes);
        }
        else
        {
            clearList(renderGroup.childrenRenderablesToUpdate.list, 0);
        }

        // phase 2 - update all the transforms
        // including updating the renderables..
        updateRenderGroupTransforms(renderGroup);

        if (renderGroup.structureDidChange)
        {
            renderGroup.structureDidChange = false;

            // build the renderables
            this._buildInstructions(renderGroup, renderer, forced);
        }
        else
        {
            // update remaining renderables
            this._updateRenderables(renderGroup);
        }

        // reset the renderables to update
        renderGroup.childrenRenderablesToUpdate.index = 0;

        // upload all the things!
        renderer.renderPipes.batch.upload(renderGroup.instructionSet);

        // early out if it's a texture and it hasn't changed!
        if (renderGroup.isCachedAsTexture && !renderGroup.textureNeedsUpdate) return;

        for (let i = 0; i < renderGroup.renderGroupChildren.length; i++)
        {
            this._updateRenderGroups(renderGroup.renderGroupChildren[i]);
        }
    }

    private _canDeferInvisibleGroup(group: RenderGroup): boolean
    {
        if (!this.canDeferInvisibleGroup
            || !group.renderGroupParent
            || group.isCachedAsTexture
            || group._parentCacheAsTextureRenderGroup
            || (!group.structureDidChange && !group.childrenRenderablesToUpdate.index
                && group._contextOf === this && group._builtForContext === this._context)
            || !this.canDeferInvisibleGroup(group))
        {
            return false;
        }

        // Walk only to this render's root, whose parent render() temporarily detaches. A direct
        // render of a hidden branch must not inherit visibility from the scene it came from.
        for (let parent = group.root; parent; parent = parent.parent)
        {
            if (!parent.visible)
            {
                return true;
            }
        }

        return false;
    }

    private _updateRenderables(renderGroup: RenderGroup)
    {
        const { list, index } = renderGroup.childrenRenderablesToUpdate;

        for (let i = 0; i < index; i++)
        {
            const container = list[i];

            if (container.didViewUpdate)
            {
                renderGroup.updateRenderable(container as ViewContainer);
            }
        }

        clearList(list, index);
    }

    /**
     * @param renderGroup
     * @param renderPipes
     * @deprecated since 8.3.0
     */
    private _buildInstructions(renderGroup: RenderGroup, renderPipes: RenderPipes, forced?: boolean): void;
    private _buildInstructions(renderGroup: RenderGroup, renderer: Renderer, forced?: boolean): void;
    private _buildInstructions(
        renderGroup: RenderGroup,
        rendererOrPipes: RenderPipes | Renderer,
        forced = false
    ): void
    {
        this.onBuildInstructions?.(renderGroup, forced);

        // rebuild the scene graph based on layers...
        const root = renderGroup.root;
        const instructionSet = renderGroup.instructionSet;

        instructionSet.reset();

        // deprecate the use of renderPipes by finding the renderer attached to the batch pipe as this is always there
        const renderer = (rendererOrPipes as Renderer).renderPipes
            ? (rendererOrPipes as Renderer)
            : (rendererOrPipes as RenderPipes).batch.renderer;
        const renderPipes = renderer.renderPipes;

        // TODO add some events / runners for build start
        renderPipes.batch.buildStart(instructionSet);
        renderPipes.blendMode.buildStart();
        renderPipes.colorMask.buildStart();

        if (root.sortableChildren)
        {
            root.sortChildren();
        }

        root.collectRenderablesWithEffects(instructionSet, renderer, null);

        // TODO add some events / runners for build end
        renderPipes.batch.buildEnd(instructionSet);
        renderPipes.blendMode.buildEnd(instructionSet);
    }
}

