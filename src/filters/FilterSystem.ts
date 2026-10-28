import { ExtensionType } from '../extensions/Extensions';
import { PassthroughFilter } from '../filters/defaults/passthrough/PassthroughFilter';
import { FilterEffect } from '../filters/FilterEffect';
import { Matrix } from '../maths/matrix/Matrix';
import { type Rectangle } from '../maths/shapes/Rectangle';
import { BindGroup } from '../rendering/renderers/gpu/shader/BindGroup';
import { Geometry } from '../rendering/renderers/shared/geometry/Geometry';
import { UniformGroup } from '../rendering/renderers/shared/shader/UniformGroup';
import { TextureSource } from '../rendering/renderers/shared/texture/sources/TextureSource';
import { Texture } from '../rendering/renderers/shared/texture/Texture';
import { TexturePool } from '../rendering/renderers/shared/texture/TexturePool';
import { RendererType } from '../rendering/renderers/types';
import { Bounds } from '../scene/container/bounds/Bounds';
import { getGlobalRenderableBounds } from '../scene/container/bounds/getRenderableBounds';
import { warn } from '../utils/logging/warn';

import type { WebGLRenderer } from '../rendering/renderers/gl/WebGLRenderer';
import type { WebGPURenderer } from '../rendering/renderers/gpu/WebGPURenderer';
import type { Instruction } from '../rendering/renderers/shared/instructions/Instruction';
import type { Renderable } from '../rendering/renderers/shared/Renderable';
import type { RenderTarget } from '../rendering/renderers/shared/renderTarget/RenderTarget';
import type { RenderSurface } from '../rendering/renderers/shared/renderTarget/RenderTargetSystem';
import type { System } from '../rendering/renderers/shared/system/System';
import type { Container } from '../scene/container/Container';
import type { Sprite } from '../scene/sprite/Sprite';
import type { Filter } from './Filter';

const quadGeometry = new Geometry({
    attributes: {
        aPosition: {
            buffer: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
            format: 'float32x2',
            stride: 2 * 4,
            offset: 0,
        },
    },
    indexBuffer: new Uint32Array([0, 1, 2, 0, 2, 3]),
});

/**
 * The filter pipeline is responsible for applying filters scene items!
 *
 * KNOWN BUGS:
 * 1. Global bounds calculation is incorrect if it is used when flip flopping filters. The maths can be found below
 * eg: filters [noiseFilter, blurFilter] noiseFilter will calculate the global bounds incorrectly.
 *
 * 2. RenderGroups do not work with filters. This is because the renderGroup matrix is not currently taken into account.
 *
 * Implementation notes:
 * 1. Gotcha - nesting filters that require blending will not work correctly. This creates a chicken and egg problem
 * the complexity and performance required to do this is not worth it i feel.. but lets see if others agree!
 *
 * 2. Filters are designed to be changed on the fly, this is means that changing filter information each frame will
 * not trigger an instruction rebuild. If you are constantly turning a filter on and off.. its therefore better to set
 * enabled to true or false on the filter. Or setting an empty array.
 *
 * 3. Need to look at perhaps aliasing when flip flopping filters. Really we should only need to antialias the FIRST
 * Texture we render too. The rest can be non aliased. This might help performance.
 * Currently we flip flop with an antialiased texture if antialiasing is enabled on the filter.
 * @internal
 */
export interface FilterInstruction extends Instruction
{
    renderPipeId: 'filter',
    action: 'pushFilter' | 'popFilter',
    container?: Container,
    renderables?: Renderable[],
    filterEffect: FilterEffect,
    /**
     * A push's matching pop, by its index in the instruction set: where drawing goes on when the
     * push reuses its filter's kept output (FilterPipe).
     * @internal
     */
    popIndex?: number,
    /**
     * A pop's matching push, by its index in the instruction set: where drawing goes back to when the
     * push's object is drawn again over its filter's output (Filter.objectApart).
     * @internal
     */
    pushIndex?: number,
    /**
     * A push's: whether all that is drawn between it and its pop may be drawn twice (FilterPipe).
     * @internal
     */
    plain?: boolean,
    /**
     * A push's: whether its object is being drawn again, over its filter's output, till its pop.
     * @internal
     */
    redrawing?: boolean,
}

/** How far a filter region's edge may be from a texel and still be taken as on it. */
const TEXEL_SNAP = 1e-6;

/**
 * Class representing the data required for applying filters.
 * This class holds various properties that are used during the filter application process.
 * @internal
 */
export class FilterData
{
    /**
     * Indicates whether the filter should be skipped.
     * @type {boolean}
     */
    public skip = false;

    /**
     * The output its filter kept from an earlier run and gave back to draw again (Filter.reusedOutput):
     * the object was not drawn, nor the filter run. Null when drawn as usual.
     * @internal
     */
    public reused: Texture | null = null;

    /**
     * Whether its filter took the input texture to keep (FilterSystem.takeInput), which the pop then
     * does not give back to the pool.
     * @internal
     */
    public inputTaken = false;

    /**
     * Whether its object is drawn again over its filter's output (Filter.objectApart): set as it is
     * pushed, read as it is popped.
     * @internal
     */
    public apart = false;

    /**
     * The texture to which the filter is applied.
     * @type {Texture}
     */
    public inputTexture: Texture = null;

    /**
     * The back texture used for blending, if required.
     * @type {Texture | null}
     */
    public backTexture?: Texture = null;

    /**
     * The list of filters to be applied.
     * @type {Filter[]}
     */
    public filters: Filter[] = null;

    /**
     * The bounds of the filter area.
     * @type {Bounds}
     */
    public bounds = new Bounds();

    /**
     * The container to which the filter is applied.
     * @type {Container}
     */
    public container: Container = null;

    /**
     * Indicates whether blending is required for the filter.
     * @type {boolean}
     */
    public blendRequired: boolean = false;

    /**
     * The render surface where the output of the filter is rendered.
     * @type {RenderSurface}
     */
    public outputRenderSurface: RenderSurface = null;

    /**
     * Indicates whether antialiasing is enabled for the filter.
     * @type {boolean}
     */
    public antialias: boolean;

    /**
     * The resolution of the filter.
     * @type {number}
     */
    public resolution: number;

    /** The first enabled filter index in the current filter list. */
    public firstEnabledIndex = -1;

    /** The last enabled filter index in the current filter list. */
    public lastEnabledIndex = -1;
}

/**
 * Whether every filter of a list is disabled, an empty list too: by index, as every filtered object
 * asks it as it is pushed and popped, each frame.
 * @param filters - The filters.
 */
function allDisabled(filters: readonly Filter[]): boolean
{
    for (let i = 0; i < filters.length; i++)
    {
        if (filters[i].enabled) return false;
    }

    return true;
}

/**
 * System that manages the filter pipeline
 * @category rendering
 * @advanced
 */
export class FilterSystem implements System
{
    /** @ignore */
    /**
     * The pipes whose instructions may be executed twice in a frame, drawing the same again: an object
     * drawn by these alone may be drawn again over its filter's output (Filter.objectApart). Not
     * filters, masks or render groups, whose state each push and pop moves on.
     */
    public static readonly redrawablePipes = new Set<string>(['batch', 'graphics', 'mesh']);

    public static extension = {
        type: [
            ExtensionType.WebGLSystem,
            ExtensionType.WebGPUSystem,
        ],
        name: 'filter',
    } as const;

    public readonly renderer: WebGLRenderer | WebGPURenderer;
    /**
     * Measures a filter instruction's area in place of the system's own measure, which it may call
     * (measureFilterArea): for a renderer that keeps an area once measured to give it again, as swf2es
     * keeps a filtered object's while only its place changes, or that measures some otherwise.
     */
    public filterAreaHook: ((instruction: FilterInstruction, bounds: Bounds, system: FilterSystem) => void) | null
        = null;

    /**
     * How deep in setting up a filter's textures the system is, and in applying a filter: a WebGL
     * renderer defers resolving a multisampled target meanwhile, the back buffer's until it is presented
     * (GlRenderTargetAdaptor.finishRenderPass).
     * @internal
     */
    public _preparing = 0;
    /** @internal */
    public _applying = 0;

    private _filterStackIndex = 0;
    private _filterStack: FilterData[] = [];

    private readonly _filterGlobalUniforms = new UniformGroup({
        uInputSize: { value: new Float32Array(4), type: 'vec4<f32>' },
        uInputPixel: { value: new Float32Array(4), type: 'vec4<f32>' },
        uInputClamp: { value: new Float32Array(4), type: 'vec4<f32>' },
        uOutputFrame: { value: new Float32Array(4), type: 'vec4<f32>' },
        uGlobalFrame: { value: new Float32Array(4), type: 'vec4<f32>' },
        uOutputTexture: { value: new Float32Array(4), type: 'vec4<f32>' },
    });

    // The texture/sampler slots are pass-local: rebound before drawing and cleared before pool
    // evictions. Only the uniform slot needs change listeners between draws.
    private readonly _globalFilterBindGroup: BindGroup = new BindGroup({});
    private _activeFilterData: FilterData;
    private _passthroughFilter: Filter;
    /**
     * Bound as the back texture of a filter that reads none, in place of Texture.EMPTY: every
     * Graphics batch's bind group fills its unused slots with EMPTY, whose source then has so many
     * listeners that the bind group's change of resource scanned them all, each time a filter
     * that reads the back texture followed one that does not.
     */
    private _emptyBackTexture: Texture = null;
    /**
     * The back texture of the filter list being applied, bound again before each pass: a texture
     * returned to the pool mid-list (a filter giving back an output it kept, whose bucket a resize
     * pruned) makes the pool evict, which unbinds the pass textures, the back texture too.
     */
    private _activeBackSource: TextureSource | null = null;

    constructor(renderer: WebGLRenderer | WebGPURenderer)
    {
        this.renderer = renderer;
    }

    /** @internal */
    public init(): void
    {
        TexturePool.on('evict', this._unbindPassTextures, this);
    }

    /**
     * The back texture of the currently active filter. Requires the filter to have `blendRequired` set to true.
     * @readonly
     */
    public get activeBackTexture(): Texture | undefined
    {
        return this._activeFilterData?.backTexture;
    }

    /**
     * The bounds of the currently active filter, in the space of the render surface it is drawn to: where
     * its input texture's corner lies.
     * @readonly
     */
    public get activeBounds(): Bounds | undefined
    {
        return this._activeFilterData?.bounds;
    }

    /**
     * Pushes a filter instruction onto the filter stack.
     * @param instruction - The instruction containing the filter effect and container.
     * @param mayReuse - Whether the caller can go on from the matching pop: then a lone filter's kept
     * output may be drawn again in place of the object (Filter.reusedOutput).
     * @returns Whether it reuses the kept output, the object not to be drawn.
     * @internal
     */
    public push(instruction: FilterInstruction, mayReuse = false): boolean
    {
        const renderer = this.renderer;

        const filters = instruction.filterEffect.filters;

        // get a filter data from the stack. They can be reused multiple times each frame,
        // so we don't need to worry about overwriting them in a single pass.
        const filterData = this._pushFilterData();

        filterData.skip = false;
        filterData.reused = null;
        filterData.inputTaken = false;
        filterData.apart = false;

        filterData.filters = filters as Filter[];
        filterData.container = instruction.container;
        filterData.outputRenderSurface = renderer.renderTarget.renderSurface;

        const colorTextureSource = renderer.renderTarget.renderTarget.colorTexture.source;

        const rootResolution = colorTextureSource.resolution;
        const rootAntialias = colorTextureSource.antialias;

        // if there are no filters, or all of them disabled, we skip the pass
        if (allDisabled(filters))
        {
            filterData.skip = true;

            return false;
        }

        const bounds = filterData.bounds;

        this._calculateFilterArea(instruction, bounds);

        this._calculateFilterBounds(filterData, renderer.renderTarget.rootViewPort, rootAntialias, rootResolution, 1);

        if (filterData.skip)
        {
            return false;
        }

        filterData.apart = !!instruction.plain && !filterData.blendRequired
            && filterData.firstEnabledIndex === filterData.lastEnabledIndex
            && filters[filterData.firstEnabledIndex].objectApart;

        const previousFilterData = this._getPreviousFilterData();

        // A first filter that kept its output from an unchanged object gives it back: nothing is drawn
        // into an input, nor run, and the caller goes on from the matching pop (FilterPipe), which
        // draws the output again, through the filters after it. Not where that filter blends with what
        // is behind, which changes; one after it that does reads what is behind now, copied here as
        // the object would have been drawn over it.
        const first = filterData.firstEnabledIndex;

        if (mayReuse && !filters[first].blendRequired)
        {
            const reused = filters[first].reusedOutput(this, filterData);

            if (reused)
            {
                filterData.reused = reused;
                filterData.backTexture = Texture.EMPTY;

                if (filterData.blendRequired)
                {
                    // as _setupFilterTextures copies it: the copy resolves what it copies of a
                    // multisampled target, not the whole target before it
                    this._preparing++;

                    try
                    {
                        renderer.renderTarget.finishRenderPass();
                        const renderTarget = renderer.renderTarget.getRenderTarget(filterData.outputRenderSurface);

                        filterData.backTexture = this.getBackTexture(renderTarget, bounds, previousFilterData?.bounds);
                    }
                    finally
                    {
                        this._preparing--;
                    }
                }

                return true;
            }
        }

        // set all the filter data

        this._setupFilterTextures(filterData, bounds, renderer, previousFilterData);

        return false;
    }

    /**
     * Applies filters to a texture.
     *
     * This method takes a texture and a list of filters, applies the filters to the texture,
     * and returns the resulting texture.
     * @param {object} params - The parameters for applying filters.
     * @param {Texture} params.texture - The texture to apply filters to.
     * @param {Filter[]} params.filters - The filters to apply.
     * @returns {Texture} The resulting texture after all filters have been applied.
     * @example
     *
     * ```ts
     * // Create a texture and a list of filters
     * const texture = new Texture(...);
     * const filters = [new BlurFilter(), new ColorMatrixFilter()];
     *
     * // Apply the filters to the texture
     * const resultTexture = renderer.filter.generateFilteredTexture({ texture, filters });
     *
     * // Use the resulting texture
     * sprite.texture = resultTexture;
     * ```
     *
     * Key Points:
     * 1. padding is not currently supported here - so clipping may occur with filters that use padding.
     * 2. If all filters are disabled or skipped, the original texture is returned.
     */
    public generateFilteredTexture({ texture, filters }: {texture: Texture, filters: Filter[]}): Texture
    {
        // with no enabled filter there is nothing to apply, so return before taking a stack entry
        if (allDisabled(filters))
        {
            return texture;
        }

        // get a filter data from the stack. They can be reused multiple times each frame,
        // so we don't need to worry about overwriting them in a single pass.
        const filterData = this._pushFilterData();

        this._activeFilterData = filterData;
        filterData.skip = false;

        filterData.filters = filters;

        const colorTextureSource = texture.source;

        const rootResolution = colorTextureSource.resolution;
        const rootAntialias = colorTextureSource.antialias;

        const bounds = filterData.bounds;

        // this path is used by the blend modes mostly!
        // they collect all renderables and push them into a list.
        // this list is then used to calculate the bounds of the filter area

        bounds.clear();
        bounds.addRect(texture.frame);

        this._calculateFilterBounds(filterData, bounds.rectangle, rootAntialias, rootResolution, 0);

        if (filterData.skip)
        {
            this._popFilterData();

            return texture;
        }

        /// /////////

        // set all the filter data
        // get a power of two or screen sized texture from our pool...
        filterData.outputRenderSurface = TexturePool.getOptimalTexture({
            width: bounds.width,
            height: bounds.height,
            resolution: filterData.resolution,
            antialias: filterData.antialias,
        });

        filterData.backTexture = Texture.EMPTY;

        /// ///
        // bind...
        // TODO this might need looking at for padding!
        filterData.inputTexture = texture;

        /// ////////////// PART 2 POP //////////////////////

        const renderer = this.renderer;

        // required: resolves the bound target's MSAA content (GL blits to the resolve
        // framebuffer; WebGPU ends the pass) so the filter can sample what was just rendered
        renderer.renderTarget.finishRenderPass();

        // get a BufferResource from the uniformBatch.
        // this will batch the shader uniform data and give us a buffer resource we can
        // set on our globalUniform Bind Group
        this._applyFiltersToTexture(filterData, true);

        const outputTexture = filterData.outputRenderSurface as Texture;

        outputTexture.source.alphaMode = 'premultiplied-alpha';

        this._popFilterData();

        return outputTexture;
    }

    /**
     * Pops the filter pushed last and draws it.
     * @returns Whether its object is to be drawn again, over what it drew (Filter.objectApart).
     * @internal
     */
    public pop(): boolean
    {
        const renderer = this.renderer;

        const filterData = this._popFilterData();

        // if we are skipping this filter then we just do nothing :D
        if (filterData.skip)
        {
            return false;
        }

        // its kept output, run through the filters after it as though the object had been drawn into
        // it: the kept texture stays its filter's, not the pool's
        if (filterData.reused && filterData.firstEnabledIndex !== filterData.lastEnabledIndex)
        {
            filterData.inputTexture = filterData.reused;
            filterData.inputTaken = true;
            filterData.reused = null;
            this._activeFilterData = filterData;

            try
            {
                this._applyFiltersToTexture(filterData, false);
            }
            finally
            {
                filterData.inputTexture = null;

                if (filterData.blendRequired)
                {
                    TexturePool.returnTexture(filterData.backTexture);
                }
            }

            return false;
        }

        // a lone filter's kept output, drawn again as its filter drew it the time it was kept
        if (filterData.reused)
        {
            const reused = filterData.reused;

            filterData.reused = null;
            const previousBackSource = this._activeBackSource;

            this._activeFilterData = filterData;
            this._activeBackSource = this._getEmptyBackTexture().source;
            this._globalFilterBindGroup.setResourceUnwatched(reused.source.style, 2);
            this._globalFilterBindGroup.setResourceUnwatched(this._activeBackSource, 3);

            try
            {
                this.applyFilter(
                    filterData.filters[filterData.firstEnabledIndex], reused, filterData.outputRenderSurface, false
                );
            }
            finally
            {
                this._activeBackSource = previousBackSource;
            }

            return filterData.apart;
        }

        renderer.globalUniforms.pop();

        renderer.renderTarget.finishRenderPass();

        this._activeFilterData = filterData;

        this._applyFiltersToTexture(filterData, false);

        // if we made a background texture, lets return that also
        if (filterData.blendRequired)
        {
            TexturePool.returnTexture(filterData.backTexture);
        }

        // return the texture to the pool so we can reuse the next frame, unless its filter kept it
        if (!filterData.inputTaken)
        {
            TexturePool.returnTexture(filterData.inputTexture);
        }

        return filterData.apart;
    }

    /**
     * Takes the input the object was drawn into, as the filter being applied would keep it as it is
     * (Filter.passesInput), in place of a copy: the pool does not get it back, and the filter gives it
     * back to the pool itself when it lets go of it. Only the input of a filter popped as usual, which
     * the pool lent; the filter is not to draw into it.
     * @param input - The input it was given, which must be the object's.
     * @returns Whether it was taken.
     * @internal
     */
    public takeInput(input: Texture): boolean
    {
        const filterData = this._activeFilterData;

        if (
            !filterData
            || filterData.inputTaken
            || filterData.inputTexture !== input
            || this._filterStack[this._filterStackIndex] !== filterData
        )
        {
            return false;
        }

        filterData.inputTaken = true;

        return true;
    }

    /**
     * Copies the last render surface to a texture.
     * @param lastRenderSurface - The last render surface to copy from.
     * @param bounds - The bounds of the area to copy.
     * @param previousBounds - The previous bounds to use for offsetting the copy.
     */
    public getBackTexture(lastRenderSurface: RenderTarget, bounds: Bounds, previousBounds?: Bounds)
    {
        const backgroundResolution = lastRenderSurface.colorTexture.source._resolution;

        const backTexture = TexturePool.getOptimalTexture({
            width: bounds.width,
            height: bounds.height,
            resolution: backgroundResolution,
        });

        let x = bounds.minX;
        let y = bounds.minY;

        if (previousBounds)
        {
            x -= previousBounds.minX;
            y -= previousBounds.minY;
        }

        // The bounds are on whole pixels of the target but kept in its units, as k * (1 / r), which
        // at a resolution such as 1.62 can come back a hair short of k: flooring took the pixel
        // before, so what is behind a moving blend was read a pixel off at those positions alone,
        // and shook. Rounded, the corner and the size are the pixels the bounds are on.
        x = Math.round(x * backgroundResolution);
        y = Math.round(y * backgroundResolution);

        const width = Math.round(bounds.width * backgroundResolution);
        const height = Math.round(bounds.height * backgroundResolution);

        this.renderer.renderTarget.copyToTexture(
            lastRenderSurface,
            backTexture,
            { x, y },
            { width, height },
            { x: 0, y: 0 }
        );

        return backTexture;
    }

    /**
     * Applies a filter to a texture.
     * @param filter - The filter to apply.
     * @param input - The input texture.
     * @param output - The output render surface.
     * @param clear - Whether to clear the output surface before applying the filter.
     */
    public applyFilter(filter: Filter, input: Texture, output: RenderSurface, clear: boolean)
    {
        const renderer = this.renderer;

        const filterData = this._activeFilterData;

        const outputRenderSurface = filterData.outputRenderSurface;

        const isFinalTarget = outputRenderSurface === output;

        const closestFilterData = this._findClosestFilterData();
        const resolution = closestFilterData
            ? closestFilterData.inputTexture.source._resolution
            : renderer.renderTarget.rootRenderTarget.colorTexture.source._resolution;

        // Calculate the offset for both outputFrame and globalFrame
        let offsetX = 0;
        let offsetY = 0;

        if (isFinalTarget && closestFilterData)
        {
            offsetX = closestFilterData.bounds.minX;
            offsetY = closestFilterData.bounds.minY;
        }

        this._updateFilterUniforms(input, output, filterData, offsetX, offsetY, resolution, isFinalTarget, clear);

        // If the filter is disabled, we still need to write something into the output surface.
        // Render a pass-through (copy) so the pipeline remains intact.
        const filterToApply = filter.enabled
            ? filter
            : this._getPassthroughFilter();

        this._setupBindGroupsAndRender(filterToApply, input, renderer);
    }

    /**
     * Multiply _input normalized coordinates_ to this matrix to get _sprite texture normalized coordinates_.
     *
     * Use `outputMatrix * vTextureCoord` in the shader.
     * @param outputMatrix - The matrix to output to.
     * @param {Sprite} sprite - The sprite to map to.
     * @returns The mapped matrix.
     */
    public calculateSpriteMatrix(outputMatrix: Matrix, sprite: Sprite): Matrix
    {
        const data = this._activeFilterData;

        const mappedMatrix = outputMatrix.set(
            data.inputTexture._source.width,
            0, 0,
            data.inputTexture._source.height,
            data.bounds.minX, data.bounds.minY
        );

        const worldTransform = sprite.worldTransform.copyTo(Matrix.shared);

        const renderGroup = sprite.renderGroup || sprite.parentRenderGroup;

        if (renderGroup && renderGroup.cacheToLocalTransform)
        {
            // get the matrix relative to the render group..
            worldTransform.prepend(renderGroup.cacheToLocalTransform);
        }

        worldTransform.invert();
        mappedMatrix.prepend(worldTransform);
        mappedMatrix.scale(
            1.0 / sprite.texture.orig.width,
            1.0 / sprite.texture.orig.height
        );

        mappedMatrix.translate(sprite.anchor.x, sprite.anchor.y);

        return mappedMatrix;
    }

    public destroy(): void
    {
        TexturePool.off('evict', this._unbindPassTextures, this);
        this._globalFilterBindGroup.destroy();

        if (this._emptyBackTexture)
        {
            this._emptyBackTexture.destroy(true);
            this._emptyBackTexture = null;
        }

        this._passthroughFilter?.destroy(true);
        (this._passthroughFilter as null) = null;
    }

    /**
     * Swaps the last pass's textures in the filter bind group for the empty texture before the texture pool
     * destroys idle textures, as a bind group warns when a texture bound to it is destroyed. The system's
     * own empty texture, not Texture.EMPTY, for the reason given at `_emptyBackTexture`.
     */
    private _unbindPassTextures(): void
    {
        const bindGroup = this._globalFilterBindGroup;
        const empty = this._getEmptyBackTexture().source;

        bindGroup.setResourceUnwatched(empty, 1);
        bindGroup.setResourceUnwatched(empty.style, 2);
        bindGroup.setResourceUnwatched(empty, 3);
    }

    private _getEmptyBackTexture(): Texture
    {
        this._emptyBackTexture ??= new Texture({ source: new TextureSource() });

        return this._emptyBackTexture;
    }

    private _getPassthroughFilter(): Filter
    {
        this._passthroughFilter ??= new PassthroughFilter();

        return this._passthroughFilter;
    }

    /**
     * Sets up the bind groups and renders the filter.
     * @param filter - The filter to apply
     * @param input - The input texture
     * @param renderer - The renderer instance
     */
    private _setupBindGroupsAndRender(filter: Filter, input: Texture, renderer: WebGLRenderer | WebGPURenderer): void
    {
        this._applying++;

        try
        {
            // TODO - should prolly use a adaptor...
            if ((renderer as WebGPURenderer).renderPipes.uniformBatch)
            {
                const batchUniforms = (renderer as WebGPURenderer).renderPipes.uniformBatch
                    .getUboResource(this._filterGlobalUniforms);

                this._globalFilterBindGroup.setResource(batchUniforms, 0);
            }
            else
            {
                this._globalFilterBindGroup.setResource(this._filterGlobalUniforms, 0);
            }

            // now lets update the output texture...

            // set bind group..
            this._globalFilterBindGroup.setResourceUnwatched(input.source, 1);
            this._globalFilterBindGroup.setResourceUnwatched(input.source.style, 2);

            if (this._activeBackSource)
            {
                this._globalFilterBindGroup.setResourceUnwatched(this._activeBackSource, 3);
            }

            filter.groups[0] = this._globalFilterBindGroup;

            renderer.encoder.draw({
                geometry: quadGeometry,
                shader: filter,
                state: filter._state,
                topology: 'triangle-list'
            });

            // WebGPU blit's automatically, but WebGL does not!
            if (renderer.type === RendererType.WEBGL)
            {
                renderer.renderTarget.finishRenderPass();
            }
        }
        finally
        {
            this._applying--;
        }
    }

    /**
     * Sets up the filter textures including input texture and back texture if needed.
     * @param filterData - The filter data to update
     * @param bounds - The bounds for the texture
     * @param renderer - The renderer instance
     * @param previousFilterData - The previous filter data for back texture calculation
     */
    private _setupFilterTextures(
        filterData: FilterData,
        bounds: Bounds,
        renderer: WebGLRenderer | WebGPURenderer,
        previousFilterData: FilterData | null
    ): void
    {
        this._preparing++;

        try
        {
            // set all the filter data
            filterData.backTexture = Texture.EMPTY;

            /// ///
            // bind...
            // get a power of two or screen sized texture from our pool...
            filterData.inputTexture = TexturePool.getOptimalTexture({
                width: bounds.width,
                height: bounds.height,
                resolution: filterData.resolution,
                antialias: filterData.antialias,
            });

            // Very cryptic, but important(!) moment.
            //
            // If we try to pull texture from the pool for backTexture before inputTexture,
            // it will be unbounded later by startRenderPass. It happens because in such a case - the current backTexture
            // is actually inputTexture from the previous filter application (check `pop` method).
            //
            // So maintaining the order (inputTexture -> backTexture) helps us to prevent unwanted texture unbinding.
            if (filterData.blendRequired)
            {
                renderer.renderTarget.finishRenderPass();
                // this actually forces the current commandQueue to render everything so far.
                // if we don't do this, we won't be able to copy pixels for the background
                const renderTarget = renderer.renderTarget.getRenderTarget(filterData.outputRenderSurface);

                filterData.backTexture = this.getBackTexture(renderTarget, bounds, previousFilterData?.bounds);
            }

            renderer.renderTarget.bind({ target: filterData.inputTexture, clear: true });

            // set the global uniforms to take into account the bounds offset required; a colour
            // root's content is drawn uncoloured by its render group (Container.colorRoot)
            renderer.globalUniforms.push({
                offset: bounds,
                worldColor: filterData.container?.colorRoot ? 0xFFFFFFFF : undefined,
            });
        }
        finally
        {
            this._preparing--;
        }
    }

    /**
     * Updates the filter uniforms with the current filter state.
     * @param input - The input texture
     * @param output - The output render surface
     * @param filterData - The current filter data
     * @param offsetX - The X offset for positioning
     * @param offsetY - The Y offset for positioning
     * @param resolution - The current resolution
     * @param isFinalTarget - Whether this is the final render target
     * @param clear - Whether to clear the output surface
     */
    private _updateFilterUniforms(
        input: Texture,
        output: RenderSurface,
        filterData: FilterData,
        offsetX: number,
        offsetY: number,
        resolution: number,
        isFinalTarget: boolean,
        clear: boolean
    ): void
    {
        const uniforms = this._filterGlobalUniforms.uniforms;
        const outputFrame = uniforms.uOutputFrame;
        const inputSize = uniforms.uInputSize;
        const inputPixel = uniforms.uInputPixel;
        const inputClamp = uniforms.uInputClamp;
        const globalFrame = uniforms.uGlobalFrame;
        const outputTexture = uniforms.uOutputTexture;

        // are we rendering back to the original surface?
        if (isFinalTarget)
        {
            outputFrame[0] = filterData.bounds.minX - offsetX;
            outputFrame[1] = filterData.bounds.minY - offsetY;
        }
        else
        {
            outputFrame[0] = 0;
            outputFrame[1] = 0;
        }

        outputFrame[2] = input.frame.width;
        outputFrame[3] = input.frame.height;

        inputSize[0] = input.source.width;
        inputSize[1] = input.source.height;
        inputSize[2] = 1 / inputSize[0];
        inputSize[3] = 1 / inputSize[1];

        inputPixel[0] = input.source.pixelWidth;
        inputPixel[1] = input.source.pixelHeight;
        inputPixel[2] = 1.0 / inputPixel[0];
        inputPixel[3] = 1.0 / inputPixel[1];

        inputClamp[0] = 0.5 * inputPixel[2];
        inputClamp[1] = 0.5 * inputPixel[3];
        inputClamp[2] = (input.frame.width * inputSize[2]) - (0.5 * inputPixel[2]);
        inputClamp[3] = (input.frame.height * inputSize[3]) - (0.5 * inputPixel[3]);

        const rootTexture = this.renderer.renderTarget.rootRenderTarget.colorTexture;

        globalFrame[0] = offsetX * resolution;
        globalFrame[1] = offsetY * resolution;
        globalFrame[2] = rootTexture.source.width * resolution;
        globalFrame[3] = rootTexture.source.height * resolution;

        // we are going to overwrite resource we can set it to null!
        if (output instanceof Texture) output.source.resource = null;

        // set the output texture - this is where we are going to render to
        const renderTarget = this.renderer.renderTarget.getRenderTarget(output);

        this.renderer.renderTarget.bind({ target: output, clear: !!clear });

        if (output instanceof Texture)
        {
            outputTexture[0] = output.frame.width;
            outputTexture[1] = output.frame.height;
        }
        else
        {
            // this means a renderTarget was passed directly
            outputTexture[0] = renderTarget.width;
            outputTexture[1] = renderTarget.height;
        }

        outputTexture[2] = renderTarget.isRoot ? -1 : 1;

        this._filterGlobalUniforms.update();
    }

    /**
     * Finds the non-skipped entry closest to the top of the filter stack.
     *
     * `pop()` removes its entry before it applies the filters, so the result is the enclosing filter's entry.
     * `generateFilteredTexture()` applies the filters while its entry is still on the stack, so the result is that entry.
     * @returns The entry, or null if there is none
     */
    private _findClosestFilterData(): FilterData | null
    {
        for (let i = this._filterStackIndex - 1; i >= 0; i--)
        {
            const filterData = this._filterStack[i];

            if (!filterData.skip) return filterData;
        }

        return null;
    }

    /**
     * Calculates the filter area bounds based on the instruction type.
     * @param instruction - The filter instruction
     * @param bounds - The bounds object to populate
     */
    private _calculateFilterArea(instruction: FilterInstruction, bounds: Bounds): void
    {
        const filterEffect = instruction.filterEffect;

        // filtered descendants pad what they draw; the effect itself not, as push pads by it after
        filterEffect._measuring = true;
        FilterEffect._measuringArea++;

        try
        {
            if (this.filterAreaHook)
            {
                this.filterAreaHook(instruction, bounds, this);
            }
            else
            {
                this.measureFilterArea(instruction, bounds);
            }
        }
        finally
        {
            filterEffect._measuring = false;
            FilterEffect._measuringArea--;
        }
    }

    /**
     * Measures the area a filter instruction is applied to: the renderables', its filterArea, or the
     * container's fast global bounds.
     * @param instruction - The filter instruction
     * @param bounds - The bounds object to populate
     * @internal
     */
    public measureFilterArea(instruction: FilterInstruction, bounds: Bounds): void
    {
        // this path is used by the blend modes mostly!
        // they collect all renderables and push them into a list.
        // this list is then used to calculate the bounds of the filter area
        if (instruction.renderables)
        {
            getGlobalRenderableBounds(instruction.renderables, bounds);
        }
        // if a filterArea is provided, we save our selves some measuring and just use that area supplied
        else if (instruction.filterEffect.filterArea)
        {
            bounds.clear();

            // transform the filterArea into global space..
            bounds.addRect(instruction.filterEffect.filterArea);

            // new for v8, we transform the bounds into the space of the container
            bounds.applyMatrix(instruction.container.worldTransform);
        }
        // classic filter path, we get the bounds of the container and use it by recursively
        // measuring.
        else
        {
            // we want to factor render layers to get the real visual bounds of this container.
            // so the last param is true..
            instruction.container.getFastGlobalBounds(true, bounds);
        }

        if (instruction.container)
        {
            // When a container is cached as a texture, its filters need to be applied relative to its
            // cached parent's coordinate space rather than world space. This transform adjustment ensures
            // filters are applied in the correct coordinate system.
            const renderGroup = instruction.container.renderGroup || instruction.container.parentRenderGroup;
            const filterFrameTransform = renderGroup.cacheToLocalTransform;

            if (filterFrameTransform)
            {
                bounds.applyMatrix(filterFrameTransform);
            }
        }
    }

    private _applyFiltersToTexture(filterData: FilterData, clear: boolean)
    {
        const inputTexture = filterData.inputTexture;

        // get a BufferResource from the uniformBatch.
        // this will batch the shader uniform data and give us a buffer resource we can
        // set on our globalUniform Bind Group
        // update the resources on the bind group...
        let backTexture = filterData.backTexture;

        if (backTexture === Texture.EMPTY)
        {
            backTexture = this._getEmptyBackTexture();
        }

        const previousBackSource = this._activeBackSource;

        this._activeBackSource = backTexture.source;
        this._globalFilterBindGroup.setResourceUnwatched(inputTexture.source.style, 2);
        this._globalFilterBindGroup.setResourceUnwatched(backTexture.source, 3);

        try
        {
            this._applyFilterList(filterData, clear);
        }
        finally
        {
            this._activeBackSource = previousBackSource;
        }
    }

    private _applyFilterList(filterData: FilterData, clear: boolean): void
    {
        const inputTexture = filterData.inputTexture;
        const bounds = filterData.bounds;
        const filters = filterData.filters;
        const firstEnabled = filterData.firstEnabledIndex;
        const lastEnabled = filterData.lastEnabledIndex;

        if (firstEnabled === lastEnabled)
        {
            // render a single filter...
            filters[firstEnabled].apply(this, inputTexture, filterData.outputRenderSurface, clear);
        }
        else
        {
            let flip = filterData.inputTexture;

            // another texture that we will render the next filter to, taken as a pass first needs it:
            // a list whose filters before the last all step aside needs none; and a second in place of
            // the input where that is kept (an output given back, or one taken), not to be drawn into
            let tempTexture: Texture | null = null;
            let secondTexture: Texture | null = null;
            let flop: Texture | null = null;

            // loop and apply the filters, omitting the last one as we will render that to the final target
            for (let i = firstEnabled; i < lastEnabled; i++)
            {
                const filter = filters[i];

                if (!filter.enabled) continue;

                // one that would draw its input unchanged leaves it to the next
                if (filter.passesInput(this, flip)) continue;

                if (!flop)
                {
                    tempTexture = TexturePool.getOptimalTexture({
                        width: bounds.width,
                        height: bounds.height,
                        resolution: flip.source._resolution,
                    });
                    flop = tempTexture;
                }

                filter.apply(this, flip, flop, true);
                const t = flip;

                flip = flop;
                flop = t;

                if (flop === filterData.inputTexture && filterData.inputTaken)
                {
                    secondTexture ??= TexturePool.getOptimalTexture({
                        width: bounds.width,
                        height: bounds.height,
                        resolution: flip.source._resolution,
                    });
                    flop = secondTexture;
                }
            }
            // apply the last enabled filter to the output
            filters[lastEnabled].apply(this, flip, filterData.outputRenderSurface, clear);

            // return those textures for later!
            if (tempTexture)
            {
                TexturePool.returnTexture(tempTexture);
            }

            if (secondTexture)
            {
                TexturePool.returnTexture(secondTexture);
            }
        }
    }

    private _calculateFilterBounds(
        filterData: FilterData,
        viewPort: Rectangle,
        rootAntialias: boolean,
        rootResolution: number,
        // a multiplier padding for the bounds calculation
        // this prop is used when applying filters to textures
        // as the should have padding applied to them already (until we fix padding when applying them to textures)
        // set to 0 to remove padding from the bounds calculation
        paddingMultiplier: number
    )
    {
        const renderer = this.renderer;

        const bounds = filterData.bounds;
        const filters = filterData.filters;

        // get GLOBAL bounds of the item we are going to apply the filter to

        // next we get the settings for the filter
        // we need to find the LOWEST resolution for the filter list
        let resolution = Infinity;
        // Padding is additive to add padding to our padding
        let padding = 0;
        // if this is true for all filter, it should be true, and otherwise false
        let antialias = true;
        // true if any filter requires the previous render target
        let blendRequired = false;
        // true if any filter in the list is enabled
        let enabled = false;
        // false if any filter in the list has false
        let clipToViewport = true;
        // cache first/last enabled indices for later passes
        let firstEnabledIndex = -1;
        let lastEnabledIndex = -1;

        for (let i = 0; i < filters.length; i++)
        {
            const filter = filters[i];

            // Only enabled filters should influence pipeline characteristics
            if (!filter.enabled) continue;

            if (firstEnabledIndex === -1) firstEnabledIndex = i;
            lastEnabledIndex = i;
            resolution = Math.min(resolution, filter.resolution === 'inherit'
                ? rootResolution : filter.resolution);
            padding += filter.padding;

            if (filter.antialias === 'off')
            {
                antialias = false;
            }
            else if (filter.antialias === 'inherit')
            {
                antialias &&= rootAntialias;
            }

            if (!filter.clipToViewport)
            {
                clipToViewport = false;
            }

            const isCompatible = !!(filter.compatibleRenderers & renderer.type);

            if (!isCompatible)
            {
                enabled = false;
                break;
            }

            if (filter.blendRequired && !((renderer as WebGLRenderer).backBuffer?.useBackBuffer ?? true))
            {
                // #if _DEBUG
                // eslint-disable-next-line max-len
                warn('Blend filter requires backBuffer on WebGL renderer to be enabled. Set `useBackBuffer: true` in the renderer options.');
                // #endif

                enabled = false;
                break;
            }

            enabled = true;
            blendRequired ||= filter.blendRequired;
        }

        // if no filters are enabled lets skip!
        if (!enabled)
        {
            filterData.skip = true;

            return;
        }

        // here we constrain the bounds to the viewport we will render too
        // this should not take into account the x, y offset of the viewport - as this is
        // handled by the viewport on the gpu.
        if (clipToViewport)
        {
            bounds.fitBounds(0, viewPort.width / rootResolution, 0, viewPort.height / rootResolution);
        }

        // round the bounds to the nearest pixel
        bounds
            .scale(resolution)
            .ceil()
            .scale(1 / resolution)
            .pad((padding | 0) * paddingMultiplier);

        // skip if the bounds are negative or zero as this means they are
        // not visible on the screen
        if (!bounds.isPositive)
        {
            filterData.skip = true;

            return;
        }

        // The padding is whole pixels, which at a resolution that is no whole number (a stage fitted
        // to its window) moved the region off the texels again: the filter read its input between
        // texels, and a blend nested in a layer, its region starting left of or above the layer's,
        // read edge texels of its pooled back texture that the copy of what is behind never reached.
        bounds.minX = Math.floor((bounds.minX * resolution) + TEXEL_SNAP) / resolution;
        bounds.minY = Math.floor((bounds.minY * resolution) + TEXEL_SNAP) / resolution;
        bounds.maxX = Math.ceil((bounds.maxX * resolution) - TEXEL_SNAP) / resolution;
        bounds.maxY = Math.ceil((bounds.maxY * resolution) - TEXEL_SNAP) / resolution;

        // store the values that will be used to apply the filters
        filterData.antialias = antialias;
        filterData.resolution = resolution;
        filterData.blendRequired = blendRequired;
        filterData.firstEnabledIndex = firstEnabledIndex;
        filterData.lastEnabledIndex = lastEnabledIndex;
    }

    private _popFilterData(): FilterData
    {
        this._filterStackIndex--;

        return this._filterStack[this._filterStackIndex];
    }

    /**
     * Finds the closest non-skipped entry that encloses the filter being pushed.
     *
     * `push()` has already added that filter's own entry, so the search starts one entry below it.
     * @returns The entry, or null if there is none
     */
    private _getPreviousFilterData(): FilterData | null
    {
        for (let i = this._filterStackIndex - 2; i >= 0; i--)
        {
            const filterData = this._filterStack[i];

            if (!filterData.skip) return filterData;
        }

        return null;
    }

    private _pushFilterData(): FilterData
    {
        let filterData = this._filterStack[this._filterStackIndex];

        if (!filterData)
        {
            filterData = this._filterStack[this._filterStackIndex] = new FilterData();
        }

        this._filterStackIndex++;

        return filterData;
    }
}
