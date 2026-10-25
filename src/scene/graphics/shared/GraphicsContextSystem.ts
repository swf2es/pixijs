import { ExtensionType } from '../../../extensions/Extensions';
import { getTextureBatchBindGroup } from '../../../rendering/batcher/gpu/getTextureBatchBindGroup';
import { type BatcherOptions } from '../../../rendering/batcher/shared/Batcher';
import { DefaultBatcher } from '../../../rendering/batcher/shared/DefaultBatcher';
import { getZeroUvs } from '../../../rendering/renderers/shared/geometry/utils/buildUvs';
import { InstructionSet } from '../../../rendering/renderers/shared/instructions/InstructionSet';
import { Texture } from '../../../rendering/renderers/shared/texture/Texture';
import { RendererType } from '../../../rendering/renderers/types';
import { GCManagedHash } from '../../../utils/data/GCManagedHash';
import { ViewableBuffer } from '../../../utils/data/ViewableBuffer';
import { deprecation, v8_3_4 } from '../../../utils/logging/deprecation';
import { BigPool } from '../../../utils/pool/PoolGroup';
import { type GPUData } from '../../view/ViewContainer';
import { BatchableGraphics } from './BatchableGraphics';
import { buildContextBatches } from './utils/buildContextBatches';

import type { GlBuffer } from '../../../rendering/renderers/gl/buffer/GlBuffer';
import type { Buffer } from '../../../rendering/renderers/shared/buffer/Buffer';
import type { System } from '../../../rendering/renderers/shared/system/System';
import type { Renderer } from '../../../rendering/renderers/types';
import type { GraphicsContext } from './GraphicsContext';

/**
 * A context's tessellation: arrays of numbers as it is built, kept as typed arrays once it has been
 * (see compactGeometryData).
 * @internal
 */
export interface GraphicsGeometryData
{
    vertices: number[] | Float32Array | Float64Array;
    uvs: number[] | Float32Array;
    indices: number[] | Uint16Array | Uint32Array;
    /** A standalone context's float precision, applied before a copy's world transform is packed. */
    roundToFloat32?: boolean;
}

/** Shorter tessellations stay as they were built: a typed array costs some 100 bytes more than an array. */
const COMPACT_LEAST = 64;

/**
 * Keeps a context's tessellation, once built, in typed arrays rather than the arrays of numbers it is
 * built into: a crowded scene's heap held some 130 MB of them, half of it UVs, all zero for a fill
 * without a texture. Positions become 32-bit floats for a context drawn alone, which are packed as
 * they are, but 64-bit ones for a batched one, which are packed through its transform; UVs 32-bit
 * floats, or a view of shared zeros for a context without a texture; indices 16-bit integers where
 * the vertices are few enough. Only packing reads them, and a rebuild starts from new arrays (reset).
 * Borrowed double positions retain their buffer and record float rounding for the attribute packer.
 * @param gpuContext - The context's GPU data, just built.
 */
function compactGeometryData(gpuContext: GpuGraphicsContext): void
{
    const data = gpuContext.geometryData;

    if (Array.isArray(data.vertices) && data.vertices.length < COMPACT_LEAST) return;

    const vertices = data.vertices;

    if (Array.isArray(vertices))
    {
        data.vertices = gpuContext.isBatchable ? new Float64Array(vertices) : new Float32Array(vertices);
    }
    else if (!gpuContext.isBatchable && vertices instanceof Float64Array && vertices.length >= COMPACT_LEAST)
    {
        data.roundToFloat32 = true;
    }

    let white = true;

    for (let i = 0; i < gpuContext.batches.length; i++)
    {
        white &&= gpuContext.batches[i].texture === Texture.WHITE;
    }

    const uvs = data.uvs.length;

    if (Array.isArray(data.uvs))
    {
        data.uvs = white ? getZeroUvs(uvs) : new Float32Array(data.uvs);
    }
    if (Array.isArray(data.indices))
    {
        data.indices = vertices.length / 2 <= 0x10000 ? new Uint16Array(data.indices) : new Uint32Array(data.indices);
    }
}

/**
 * Gives `gpuContext` the tessellation `built` holds, as buildContextBatches would build it again from
 * the same shapes, and a batch for each of its batches over it. A compacted tessellation's indices and
 * UVs are shared, as nothing changes them once built (a rebuild starts from new arrays, reset); its
 * positions are shared too, with standalone float rounding recorded for the attribute packer. One
 * left as built is copied, to be compacted as a build's is.
 * @param built - The GPU data of the context whose tessellation is taken, built.
 * @param gpuContext - The GPU data to give it to, reset.
 */
function copyTessellation(built: GpuGraphicsContext, gpuContext: GpuGraphicsContext): void
{
    const from = built.geometryData;
    const to: GraphicsGeometryData = Array.isArray(from.vertices)
        ? {
            vertices: from.vertices.slice(),
            uvs: (from.uvs as number[]).slice(),
            indices: (from.indices as number[]).slice(),
        }
        : {
            vertices: from.vertices,
            uvs: from.uvs,
            indices: from.indices,
            roundToFloat32: from.roundToFloat32,
        };

    gpuContext.geometryData = to;

    const batches = gpuContext.batches;

    batches.length = 0;

    for (let i = 0; i < built.batches.length; i++)
    {
        const batch = BigPool.get(BatchableGraphics);

        built.batches[i].copyTo(batch);
        batch.geometryData = to;
        batches.push(batch);
    }
}

/**
 * A class that holds batchable graphics data for a GraphicsContext.
 * @category rendering
 * @ignore
 */
export class GpuGraphicsContext implements GPUData
{
    /**
     * Called as any GpuGraphicsContext is reset, as its context is built again or destroyed, before it
     * lets go of anything: for a renderer that keeps something of each context's geometry elsewhere, as
     * swf2es's transform table keeps it in an atlas.
     */
    public static onReset: ((gpuContext: GpuGraphicsContext) => void) | null = null;

    public isBatchable: boolean;
    public context: GraphicsContext;

    public batches: BatchableGraphics[] = [];
    public geometryData: GraphicsGeometryData = {
        vertices: [],
        uvs: [],
        indices: [],
    };
    public graphicsData: GraphicsContextRenderData;

    public reset()
    {
        GpuGraphicsContext.onReset?.(this);

        if (this.batches)
        {
            this.batches.forEach((batch) =>
            {
                BigPool.return(batch);
            });
        }
        if (this.graphicsData)
        {
            BigPool.return(this.graphicsData);
        }

        this.isBatchable = false;
        this.context = null;

        this.batches.length = 0;

        const geometryData = this.geometryData;
        geometryData.roundToFloat32 = false;

        // a compacted tessellation is given new arrays to be built into again
        if (Array.isArray(geometryData.vertices))
        {
            (geometryData.indices as number[]).length = 0;
            geometryData.vertices.length = 0;
            if (Array.isArray(geometryData.uvs))
            {
                geometryData.uvs.length = 0;
            }
            else
            {
                geometryData.uvs = [];
            }
        }
        else
        {
            geometryData.vertices = [];
            geometryData.uvs = [];
            geometryData.indices = [];
        }

        this.graphicsData = null;
    }

    public destroy()
    {
        this.reset();
        this.batches = null;
        this.geometryData = null;
    }
}

/**
 * A class that holds the render data for a GraphicsContext.
 * @category rendering
 * @ignore
 */
export class GraphicsContextRenderData
{
    public batcher: DefaultBatcher;
    public instructions = new InstructionSet();
    /**
     * Whether the batcher's arrays were let go of once uploaded, the GPU's buffers alone holding what
     * it packed (see GraphicsContextSystem.postrender).
     * @internal
     */
    public _dropped = false;
    /**
     * The renderer's count of buffer losses (GlBufferSystem.losses) when the GPU was last found to
     * hold what it packed, or -1: while the count stands, it still does.
     * @internal
     */
    public _residentAt = -1;

    public init(options: BatcherOptions)
    {
        const maxTextures = options.maxTextures;

        this.batcher ? this.batcher._updateMaxTextures(maxTextures) : this.batcher = new DefaultBatcher({ maxTextures });
        this.instructions.reset();
    }

    /**
     * @deprecated since version 8.0.0
     * Use `batcher.geometry` instead.
     * @see {Batcher#geometry}
     */
    get geometry()
    {
        // #if _DEBUG
        deprecation(v8_3_4, 'GraphicsContextRenderData#geometry is deprecated, please use batcher.geometry instead.');
        // #endif

        return this.batcher.geometry;
    }

    public destroy()
    {
        this.batcher.destroy();
        this.instructions.destroy();

        this.batcher = null;
        this.instructions = null;
    }
}

/**
 * Options for the GraphicsContextSystem.
 * @category rendering
 * @advanced
 */
export interface GraphicsContextSystemOptions
{
    /** A value from 0 to 1 that controls the smoothness of bezier curves (the higher the smoother) */
    bezierSmoothness?: number;
}

/**
 * A system that manages the rendering of GraphicsContexts.
 * @category rendering
 * @advanced
 */
export class GraphicsContextSystem implements System<GraphicsContextSystemOptions>
{
    /** @ignore */
    public static extension = {
        type: [
            ExtensionType.WebGLSystem,
            ExtensionType.WebGPUSystem,
        ],
        name: 'graphicsContext'
    } as const;

    /** The default options for the GraphicsContextSystem. */
    public static readonly defaultOptions: GraphicsContextSystemOptions = {
        /**
         * A value from 0 to 1 that controls the smoothness of bezier curves (the higher the smoother)
         * @default 0.5
         */
        bezierSmoothness: 0.5,
    };

    private readonly _renderer: Renderer;
    private readonly _managedContexts: GCManagedHash<GraphicsContext>;
    /**
     * Called as a context has just been built, for a renderer that lets go of what it no longer reads of
     * a context once built: swf2es drops its paths' commands, as its contexts never change after.
     */
    public onContextBuilt: ((context: GraphicsContext, gpuContext: GpuGraphicsContext) => void) | null = null;

    /** The render data packed since the last frame ended, whose arrays are let go of then. */
    private readonly _packed: GpuGraphicsContext[] = [];

    constructor(renderer: Renderer)
    {
        this._renderer = renderer;
        this._managedContexts = new GCManagedHash({ renderer, type: 'resource', name: 'graphicsContext' });
    }

    /**
     * Runner init called, update the default options
     * @ignore
     */
    public init(options?: GraphicsContextSystemOptions)
    {
        GraphicsContextSystem.defaultOptions.bezierSmoothness = options?.bezierSmoothness
            ?? GraphicsContextSystem.defaultOptions.bezierSmoothness;
    }

    /**
     * Returns the render data for a given GraphicsContext.
     * @param context - The GraphicsContext to get the render data for.
     * @internal
     */
    public getContextRenderData(context: GraphicsContext): GraphicsContextRenderData
    {
        const gpuContext = context._gpuData[this._renderer.uid];
        const graphicsData = gpuContext?.graphicsData;

        // packed again from the context's tessellation, as it first was, once the GPU lost its copy
        if (graphicsData?._dropped && !this._isResident(graphicsData))
        {
            this._repack(gpuContext);
        }

        return gpuContext.graphicsData || this._initContextRenderData(context);
    }

    /**
     * Returns the render data for a given GraphicsContext with what it packed on the CPU, packed again
     * if its arrays were let go of: for what reads them rather than drawing from the GPU's copy.
     * @param context - The GraphicsContext to get the render data for.
     * @internal
     */
    public getContextRenderDataOnCpu(context: GraphicsContext): GraphicsContextRenderData
    {
        const gpuContext = context._gpuData[this._renderer.uid];

        if (gpuContext?.graphicsData?._dropped)
        {
            this._repack(gpuContext);
        }

        return this.getContextRenderData(context);
    }

    /**
     * Runner postrender: lets go of the arrays of what this frame packed for contexts drawn alone, on
     * WebGL. The batcher kept them for as long as the context lived, a copy of what the GPU holds, read
     * again only to upload them again once a lost context or the collection of unused buffers took the
     * GPU's copy; that is
     * now packed again from the context's tessellation, which is kept (getContextRenderData).
     * @ignore
     */
    public postrender(): void
    {
        const packed = this._packed;

        for (let i = 0; i < packed.length; i++)
        {
            const graphicsData = packed[i].graphicsData;
            const batcher = graphicsData?.batcher;

            if (!batcher || graphicsData._dropped) continue;

            batcher.attributeBuffer.destroy();
            batcher.attributeBuffer = new ViewableBuffer(0);
            batcher.indexBuffer = new (batcher.indexBuffer.constructor as Uint16ArrayConstructor)(0);
            batcher.geometry.buffers[0]._releaseData(batcher.attributeBuffer.float32View);
            batcher.geometry.indexBuffer._releaseData(batcher.indexBuffer);
            graphicsData._dropped = true;
            graphicsData._residentAt = -1;
        }

        packed.length = 0;
    }

    /**
     * Updates the GPU context for a given GraphicsContext.
     * If the context is dirty, it will rebuild the batches and geometry data.
     * @param context - The GraphicsContext to update.
     * @returns The updated GpuGraphicsContext.
     * @internal
     */
    public updateGpuContext(context: GraphicsContext)
    {
        const hasContext = !!context._gpuData[this._renderer.uid];
        const gpuContext: GpuGraphicsContext = context._gpuData[this._renderer.uid] || this._initContext(context);

        if (context.dirty || !hasContext)
        {
            if (hasContext)
            {
                gpuContext.reset();
            }

            const source = context.tessellationOf;
            const built: GpuGraphicsContext | undefined = source && !source.dirty
                ? source._gpuData[this._renderer.uid]
                : undefined;

            if (built?.geometryData)
            {
                gpuContext.isBatchable = this._batchable(context, built.geometryData.vertices.length);
                copyTessellation(built, gpuContext);
            }
            else
            {
                buildContextBatches(context, gpuContext);
                gpuContext.isBatchable = this._batchable(context, gpuContext.geometryData.vertices.length);
            }

            compactGeometryData(gpuContext);

            context.dirty = false;

            this.onContextBuilt?.(context, gpuContext);
        }

        return gpuContext;
    }

    /**
     * Whether a context of `vertices` positions is batched, by its batch mode.
     * @param context - The context.
     * @param vertices - How many numbers its positions are.
     */
    private _batchable(context: GraphicsContext, vertices: number): boolean
    {
        const batchMode = context.batchMode;

        if (context.customShader || batchMode === 'no-batch') return false;

        return batchMode === 'auto' ? vertices < 400 : true;
    }

    /**
     * Returns the GpuGraphicsContext for a given GraphicsContext.
     * If it does not exist, it will initialize a new one.
     * @param context - The GraphicsContext to get the GpuGraphicsContext for.
     * @returns The GpuGraphicsContext for the given GraphicsContext.
     * @internal
     */
    public getGpuContext(context: GraphicsContext): GpuGraphicsContext
    {
        return context._gpuData[this._renderer.uid] || this._initContext(context);
    }

    private _initContextRenderData(context: GraphicsContext): GraphicsContextRenderData
    {
        const graphicsData: GraphicsContextRenderData = BigPool.get(GraphicsContextRenderData, {
            maxTextures: this._renderer.limits.maxBatchableTextures,
        });

        const gpuContext = context._gpuData[this._renderer.uid];
        const { batches, geometryData } = gpuContext;

        gpuContext.graphicsData = graphicsData;
        graphicsData._dropped = false;

        if (this._renderer.type === RendererType.WEBGL)
        {
            this._packed.push(gpuContext);
        }

        const vertexSize = geometryData.vertices.length;
        const indexSize = geometryData.indices.length;

        for (let i = 0; i < batches.length; i++)
        {
            batches[i].applyTransform = false;
        }

        const batcher = graphicsData.batcher;

        // TODO we can pool buffers here eventually..
        batcher.ensureAttributeBuffer(vertexSize);
        batcher.ensureIndexBuffer(indexSize);

        batcher.begin();

        for (let i = 0; i < batches.length; i++)
        {
            const batch = batches[i];

            batcher.add(batch);
        }

        batcher.finish(graphicsData.instructions);

        const geometry = batcher.geometry;

        // not to self - this works as we are assigning the batchers array buffer
        // once its up loaded - this buffer is then put back in the pool to be reused.
        // this mean we don't have to creating new Batchers for each graphics items
        geometry.indexBuffer.setDataWithSize(batcher.indexBuffer, batcher.indexSize, true);
        geometry.buffers[0].setDataWithSize(batcher.attributeBuffer.float32View, batcher.attributeSize, true);

        const drawBatches = batcher.batches;

        for (let i = 0; i < batcher.batchIndex; i++)
        {
            const batch = drawBatches[i];

            batch.bindGroup = getTextureBatchBindGroup(
                batch.textures.textures,
                batch.textures.count,
                this._renderer.limits.maxBatchableTextures
            );
        }

        return graphicsData;
    }

    /**
     * Whether the GPU holds what the render data packed: its buffers there, and up to date.
     * @param graphicsData - The render data.
     */
    private _isResident(graphicsData: GraphicsContextRenderData): boolean
    {
        // checked once after it is dropped, then trusted while no buffer has lost its GL copy since
        const losses = (this._renderer as { buffer?: { losses?: number } }).buffer?.losses ?? -1;

        if (losses >= 0 && graphicsData._residentAt === losses) return true;

        const geometry = graphicsData.batcher?.geometry;
        const resident = !!geometry
            && this._isUploaded(geometry.buffers[0])
            && this._isUploaded(geometry.indexBuffer);

        if (resident && losses >= 0) graphicsData._residentAt = losses;

        return resident;
    }

    private _isUploaded(buffer: Buffer): boolean
    {
        const glBuffer = buffer._gpuData[this._renderer.uid] as GlBuffer;

        return !!glBuffer?.buffer && glBuffer.updateID === buffer._updateID;
    }

    /**
     * Has the context packed again into new render data, as it was as it first drew.
     * @param gpuContext - The context's GPU data.
     */
    private _repack(gpuContext: GpuGraphicsContext): void
    {
        gpuContext.graphicsData._dropped = false;
        BigPool.return(gpuContext.graphicsData);
        gpuContext.graphicsData = null;
    }

    private _initContext(context: GraphicsContext): GpuGraphicsContext
    {
        const gpuContext = new GpuGraphicsContext();

        gpuContext.context = context;

        context._gpuData[this._renderer.uid] = gpuContext;

        this._managedContexts.add(context);

        return gpuContext;
    }

    public destroy()
    {
        this._managedContexts.destroy();
        (this._renderer as null) = null;
    }
}
