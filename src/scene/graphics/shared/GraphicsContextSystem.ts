import { ExtensionType } from '../../../extensions/Extensions';
import { getTextureBatchBindGroup } from '../../../rendering/batcher/gpu/getTextureBatchBindGroup';
import { type BatcherOptions } from '../../../rendering/batcher/shared/Batcher';
import { DefaultBatcher } from '../../../rendering/batcher/shared/DefaultBatcher';
import { InstructionSet } from '../../../rendering/renderers/shared/instructions/InstructionSet';
import { Texture } from '../../../rendering/renderers/shared/texture/Texture';
import { GCManagedHash } from '../../../utils/data/GCManagedHash';
import { deprecation, v8_3_4 } from '../../../utils/logging/deprecation';
import { BigPool } from '../../../utils/pool/PoolGroup';
import { type GPUData } from '../../view/ViewContainer';
import { buildContextBatches } from './utils/buildContextBatches';

import type { System } from '../../../rendering/renderers/shared/system/System';
import type { Renderer } from '../../../rendering/renderers/types';
import type { BatchableGraphics } from './BatchableGraphics';
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
}

/** Shorter tessellations stay as they were built: a typed array costs some 100 bytes more than an array. */
const COMPACT_LEAST = 64;
/** Zeros, the UVs of every compacted context without a texture, grown to the largest's. */
let zeros = new Float32Array(1024);

/**
 * Keeps a context's tessellation, once built, in typed arrays rather than the arrays of numbers it is
 * built into: a crowded scene's heap held some 130 MB of them, half of it UVs, all zero for a fill
 * without a texture. Positions become 32-bit floats for a context drawn alone, which are packed as
 * they are, but 64-bit ones for a batched one, which are packed through its transform; UVs 32-bit
 * floats, or a view of shared zeros for a context without a texture; indices 16-bit integers where
 * the vertices are few enough. Only packing reads them, and a rebuild starts from new arrays (reset).
 * @param gpuContext - The context's GPU data, just built.
 */
function compactGeometryData(gpuContext: GpuGraphicsContext): void
{
    const data = gpuContext.geometryData;

    if (!Array.isArray(data.vertices) || data.vertices.length < COMPACT_LEAST) return;

    const vertices = data.vertices;

    data.vertices = gpuContext.isBatchable ? new Float64Array(vertices) : new Float32Array(vertices);

    let white = true;

    for (let i = 0; i < gpuContext.batches.length; i++)
    {
        white &&= gpuContext.batches[i].texture === Texture.WHITE;
    }

    const uvs = data.uvs.length;

    if (white && zeros.length < uvs)
    {
        zeros = new Float32Array(Math.max(uvs, zeros.length * 2));
    }

    data.uvs = white ? zeros.subarray(0, uvs) : new Float32Array(data.uvs);
    data.indices = vertices.length / 2 <= 0x10000 ? new Uint16Array(data.indices) : new Uint32Array(data.indices);
}

/**
 * A class that holds batchable graphics data for a GraphicsContext.
 * @category rendering
 * @ignore
 */
export class GpuGraphicsContext implements GPUData
{
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

        // a compacted tessellation is given new arrays to be built into again
        if (Array.isArray(geometryData.vertices))
        {
            (geometryData.indices as number[]).length = 0;
            geometryData.vertices.length = 0;
            (geometryData.uvs as number[]).length = 0;
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
        return context._gpuData[this._renderer.uid].graphicsData || this._initContextRenderData(context);
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

            buildContextBatches(context, gpuContext);

            const batchMode = context.batchMode;

            if (context.customShader || batchMode === 'no-batch')
            {
                gpuContext.isBatchable = false;
            }
            else if (batchMode === 'auto')
            {
                gpuContext.isBatchable = (gpuContext.geometryData.vertices.length < 400);
            }
            else
            {
                gpuContext.isBatchable = true;
            }

            compactGeometryData(gpuContext);

            context.dirty = false;
        }

        return gpuContext;
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
