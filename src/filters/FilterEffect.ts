import type { Rectangle } from '../maths/shapes/Rectangle';
import type { Bounds } from '../scene/container/bounds/Bounds';
import type { Effect } from '../scene/container/Effect';
import type { Filter } from './Filter';

/**
 * A filter effect is an effect that can be applied to a container that involves applying special pixel effects
 * to that container as it is rendered. Used internally when the filters property is modified on a container.
 * @internal
 */
export class FilterEffect implements Effect
{
    /** read only filters array - to modify, set it again! */
    public filters: readonly Filter[];
    /**
     * If specified, rather than calculating the bounds of the container that the filter
     * will apply to, we use this rect instead. This is a local rect - so will have the containers transform
     * applied to it
     */
    public filterArea?: Rectangle;

    /** the pipe that knows how to handle this effect */
    public pipe = 'filter';
    /** the priority of this effect */
    public priority = 1;
    /**
     * Set while the filter system measures the area of the container this effect filters, which it
     * pads by these filters itself.
     * @internal
     */
    public _measuring = false;

    /**
     * Grows the bounds of the container this effect filters by its enabled filters' padding, in the
     * world's pixels as the filter system pads: what a filtered descendant draws past its shapes, a
     * blur's or a glow's spread, is then inside an ancestor's filter area rather than cut off at the
     * descendant's shapes.
     * @param bounds - The bounds to grow, in world space.
     */
    public addBounds(bounds: Bounds): void
    {
        if (this._measuring || !this.filters) return;

        let padding = 0;

        for (let i = 0; i < this.filters.length; i++)
        {
            const filter = this.filters[i];

            if (filter.enabled)
            {
                padding += filter.padding;
            }
        }

        bounds.pad(padding | 0);
    }

    public destroy(): void
    {
        for (let i = 0; i < this.filters.length; i++)
        {
            this.filters[i].destroy();
        }

        this.filters = null;
        this.filterArea = null;
    }
}
