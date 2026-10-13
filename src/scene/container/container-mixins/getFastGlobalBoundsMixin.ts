import { FilterEffect } from '../../../filters/FilterEffect';
import { Matrix } from '../../../maths/matrix/Matrix';
import { type Renderable } from '../../../rendering/renderers/shared/Renderable';
import { type RenderLayer } from '../../layers/RenderLayer';
import { Bounds } from '../bounds/Bounds';
import { boundsPool } from '../bounds/utils/matrixAndBoundsPool';

import type { Container } from '../Container';

const tempMatrix = new Matrix();

/**
 * Interface for the GetFastGlobalBoundsMixin, which provides methods to compute
 * an approximate global bounding box for a container and its children.
 * @category scene
 * @advanced
 */
export interface GetFastGlobalBoundsMixin
{
    /**
     * Computes an approximate global bounding box for the container and its children.
     * This method is optimized for speed by using axis-aligned bounding boxes (AABBs),
     * and uses the last render results from when it updated the transforms. This function does not update them.
     * which may result in slightly larger bounds but never smaller than the actual bounds.
     *
     * for accurate (but less performant) results use `container.getGlobalBounds`
     * @param {boolean} [factorRenderLayers] - A flag indicating whether to consider render layers in the calculation.
     * @param {Bounds} [bounds] - The output bounds object to store the result. If not provided, a new one is created.
     * @returns {Bounds} The computed bounds.
     * @advanced
     */
    getFastGlobalBounds(factorRenderLayers?: boolean, bounds?: Bounds): Bounds;

    /**
     * Recursively calculates the global bounds for the container and its children.
     * This method is used internally by getFastGlobalBounds to traverse the scene graph.
     * @param {boolean} factorRenderLayers - A flag indicating whether to consider render layers in the calculation.
     * @param {Bounds} bounds - The bounds object to update with the calculated values.
     * @param {RenderLayer} currentLayer - The current render layer being processed.
     * @param {boolean} [nested] - Whether this is below the container measured, rather than it.
     * @internal
     */
    _getGlobalBoundsRecursive(
        factorRenderLayers: boolean,
        bounds: Bounds,
        currentLayer: RenderLayer,
        nested?: boolean,
    ): void;
}

/**
 * Extension points of the fast bounds walk (getFastGlobalBounds), for every container.
 * @category scene
 * @advanced
 */
export const fastGlobalBoundsHooks: {
    /**
     * Called for each container the walk measures that has a mask, which the walk does not bound its
     * bounds by: for a renderer that keeps an area it measured, as swf2es keeps a filter's, and so must
     * know when a mask may bound it as no change of what it measured tells.
     */
    onMask: ((container: Container) => void) | null;
} = { onMask: null };

/**
 * Mixin providing the implementation of the GetFastGlobalBoundsMixin interface.
 * It includes methods to compute and recursively calculate global bounds for containers.
 * @internal
 */
export const getFastGlobalBoundsMixin: Partial<Container> = {
    getFastGlobalBounds(factorRenderLayers?: boolean, bounds?: Bounds): Bounds
    {
        bounds ||= new Bounds();

        // Initialize the bounds for fresh calculations.
        bounds.clear();

        // Calculate bounds recursively, starting from the current container.
        this._getGlobalBoundsRecursive(!!factorRenderLayers, bounds, this.parentRenderLayer);

        // Validate the calculated bounds, resetting if invalid.
        if (!bounds.isValid)
        {
            bounds.set(0, 0, 0, 0);
        }

        // Apply the world transformation to the bounds.
        const renderGroup = this.renderGroup || this.parentRenderGroup;

        bounds.applyMatrix(renderGroup.worldTransform);

        return bounds;
    },

    _getGlobalBoundsRecursive(
        factorRenderLayers: boolean,
        bounds: Bounds,
        currentLayer: RenderLayer,
        nested = false,
    )
    {
        // Skip if the container is not in the current render layer when factoring render layers.
        if (factorRenderLayers && this.parentRenderLayer && this.parentRenderLayer !== currentLayer) return;

        // Skip if the container is not fully visible or not measurable.
        if (this.localDisplayStatus !== 0b111 || (!this.measurable))
        {
            return;
        }

        if (fastGlobalBoundsHooks.onMask && this.mask)
        {
            fastGlobalBoundsHooks.onMask(this);
        }

        // Determine if effects need to be managed, requiring separate bounds handling.
        const manageEffects = !!this.effects.length;

        // A render group below the container measured that has effects of its own gathers its
        // bounds in its own space, as one without effects does, so they must be placed in its
        // parent's by its place there too. The container measured itself is in its own group's
        // space, which getFastGlobalBounds takes to the world.
        const placing = nested && !!this.renderGroup && manageEffects;
        const into = placing ? boundsPool.get().clear() : bounds;

        // Use a temporary bounds object if the container is a render group or has effects.
        const localBounds = (this.renderGroup || manageEffects) ? boundsPool.get().clear() : into;

        // Add the container's own bounds area to the bounds if it exists.
        if (this.boundsArea)
        {
            into.addRect(this.boundsArea, this.worldTransform);
        }
        else
        {
            // If the container is renderable, add its bounds to the local bounds.
            if (this.renderPipeId)
            {
                const viewBounds = (this as Renderable).bounds;

                localBounds.addFrame(
                    viewBounds.minX,
                    viewBounds.minY,
                    viewBounds.maxX,
                    viewBounds.maxY,
                    this.groupTransform
                );
            }

            // Recursively process each child to include their bounds.
            const children = this.children;

            for (let i = 0; i < children.length; i++)
            {
                children[i]._getGlobalBoundsRecursive(factorRenderLayers, localBounds, currentLayer, true);
            }
        }

        // If effects are managed, apply them to the bounds.
        if (manageEffects)
        {
            let advanced = false;
            const renderGroup = this.renderGroup || this.parentRenderGroup;

            // Apply each effect that modifies bounds.
            for (let i = 0; i < this.effects.length; i++)
            {
                const effect = this.effects[i];
                // a filter's padding, only as a filter's area is measured (FilterEffect.padBounds)
                const pads = FilterEffect._measuringArea > 0 && effect instanceof FilterEffect;

                if (effect.addBounds || pads)
                {
                    if (!advanced)
                    {
                        advanced = true;
                        localBounds.applyMatrix(renderGroup.worldTransform);
                    }

                    if (pads)
                    {
                        (effect as FilterEffect).padBounds(localBounds);
                    }
                    else
                    {
                        effect.addBounds(localBounds, true);
                    }
                }
            }

            // Adjust bounds back to the local coordinate space if advanced bounds were calculated.
            if (advanced)
            {
                localBounds.applyMatrix(renderGroup.worldTransform.copyTo(tempMatrix).invert());
            }

            // Add the local bounds to the final bounds and return the temporary bounds object.
            into.addBounds(localBounds);
            boundsPool.return(localBounds);
        }
        else if (this.renderGroup)
        {
            // If the container is a render group, add its local bounds to the final bounds.
            into.addBounds(localBounds, this.relativeGroupTransform);
            boundsPool.return(localBounds);
        }

        if (placing)
        {
            if (into.isValid)
            {
                bounds.addBounds(into, this.relativeGroupTransform);
            }

            boundsPool.return(into);
        }
    }

} as Container;
