import { ExtensionType } from '../../../extensions/Extensions';
import { State } from '../../../rendering/renderers/shared/state/State';
import { type Renderer } from '../../../rendering/renderers/types';
import { GCManagedHash } from '../../../utils/data/GCManagedHash';
import { BigPool } from '../../../utils/pool/PoolGroup';
import { type GPUData } from '../../view/ViewContainer';
import { color32BitToUniform } from '../gpu/colorToUniform';
import { BatchableGraphics } from './BatchableGraphics';

import type { InstructionSet } from '../../../rendering/renderers/shared/instructions/InstructionSet';
import type { RenderPipe } from '../../../rendering/renderers/shared/instructions/RenderPipe';
import type { Shader } from '../../../rendering/renderers/shared/shader/Shader';
import type { PoolItem } from '../../../utils/pool/Pool';
import type { Graphics } from './Graphics';
import type { GpuGraphicsContext, GraphicsContextSystem } from './GraphicsContextSystem';

/** @internal */
export interface GraphicsPipeLike
{
    renderer: Renderer;
    state: State;
}

/** @internal */
export interface GraphicsAdaptor
{
    shader: Shader;
    contextChange(renderer: Renderer): void;
    /** Draws the renderable with `shader`, if given, else its context's customShader or the adaptor's own. */
    execute(graphicsPipe: GraphicsPipeLike, renderable: Graphics, shader?: Shader): void;
    destroy(): void;
}

/** @internal */
export class GraphicsGpuData implements GPUData
{
    public batches: BatchableGraphics[] = [];
    /** Whether the last build batched the Graphics, rather than giving it an instruction of its own. */
    public batched = false;
    public destroy()
    {
        this.batches.forEach((batch) =>
        {
            BigPool.return(batch as PoolItem);
        });

        this.batches.length = 0;
    }
}

/**
 * Draws the Graphics a GraphicsPipe would give an instruction of their own, those of a context that is
 * not batched, in its place while it is active (see GraphicsPipe.aloneDrawer).
 * @internal
 */
export interface GraphicsAloneDrawer
{
    /** Whether it draws them now; otherwise the pipe does. */
    readonly active: boolean;
    /** Adds the Graphics to the instruction set, which the batch has just been broken in. */
    add(graphics: Graphics, instructionSet: InstructionSet): void;
}

/** @internal */
export class GraphicsPipe implements RenderPipe<Graphics>
{
    /** @ignore */
    public static extension = {
        type: [
            ExtensionType.WebGLPipes,
            ExtensionType.WebGPUPipes,
        ],
        name: 'graphics',
    } as const;

    public renderer: Renderer;
    public state: State = State.for2d();
    /**
     * Draws the Graphics this pipe would give an instruction of their own, while it is active: for a
     * renderer that draws them its own way, as swf2es's transform table draws runs of them in a few
     * calls. Each still has its GPU data rebuilt here as it changes.
     */
    public aloneDrawer: GraphicsAloneDrawer | null = null;
    /**
     * Gives the shader a Graphics drawn alone is drawn with, in place of the adaptor's own, or null for
     * that; a context's customShader comes first. Called as each is drawn, which sets the shader's
     * local uniforms after: for a renderer that draws some Graphics with a shader of its own, as
     * swf2es draws one under a Flash colour transform.
     */
    public shaderFor: ((graphics: Graphics) => Shader | null) | null = null;

    private _adaptor: GraphicsAdaptor;
    private readonly _managedGraphics: GCManagedHash<Graphics>;

    constructor(renderer: Renderer, adaptor: GraphicsAdaptor)
    {
        this.renderer = renderer;
        this._adaptor = adaptor;
        this.renderer.runners.contextChange.add(this);
        this._managedGraphics = new GCManagedHash({ renderer, type: 'renderable', priority: -1, name: 'graphics' });
    }

    public contextChange(): void
    {
        this._adaptor.contextChange(this.renderer);
    }

    public validateRenderable(graphics: Graphics): boolean
    {
        // assume context is dirty..
        const context = graphics.context;

        const contextSystem = this.renderer.graphicsContext as GraphicsContextSystem;
        const gpuContext = contextSystem.updateGpuContext(context);

        // A Graphics the last build drew alone, and still to be drawn alone, keeps its instruction,
        // which draws whatever context it has as it runs: its render group needs no rebuild. Asking
        // whether it has GPU data at all, as every Graphics drawn once has, rebuilt the group each
        // time a Graphics drawn alone changed or swapped its context.
        const gpuData = graphics._gpuData[this.renderer.uid];

        return gpuContext.isBatchable || gpuData?.batched !== false;
    }

    public addRenderable(graphics: Graphics, instructionSet: InstructionSet)
    {
        const contextSystem = this.renderer.graphicsContext as GraphicsContextSystem;
        const gpuContext = contextSystem.updateGpuContext(graphics.context);

        // need to get batches here.. as we need to know if we can batch or not..
        // this also overrides the current batches..
        // also rebuild when this renderer has no batches yet, e.g. the graphics was first rendered elsewhere
        if (graphics.didViewUpdate || !graphics._gpuData[this.renderer.uid])
        {
            this._rebuild(graphics);
        }

        if (gpuContext.isBatchable)
        {
            this._addToBatcher(graphics, instructionSet);
        }
        else
        {
            this.renderer.renderPipes.batch.break(instructionSet);

            if (this.aloneDrawer?.active)
            {
                this.aloneDrawer.add(graphics, instructionSet);
            }
            else
            {
                instructionSet.add(graphics);
            }
        }

        const gpuData = graphics._gpuData[this.renderer.uid];

        if (gpuData)
        {
            gpuData.batched = gpuContext.isBatchable;
        }
    }

    public updateRenderable(graphics: Graphics)
    {
        const gpuData = this._getGpuDataForRenderable(graphics);

        const batches = gpuData.batches;

        for (let i = 0; i < batches.length; i++)
        {
            const batch = batches[i];

            batch._batcher.updateElement(batch);
        }
    }

    public execute(graphics: Graphics)
    {
        if (!graphics.isRenderable) return;

        const renderer = this.renderer;
        const context = graphics.context;
        const contextSystem = renderer.graphicsContext as GraphicsContextSystem;

        // early out if there is no actual visual stuff...
        if (!contextSystem.getGpuContext(context).batches.length)
        { return; }

        const shader = context.customShader || this.shaderFor?.(graphics) || this._adaptor.shader;

        this.state.blendMode = graphics.groupBlendMode;

        const localUniforms = shader.resources.localUniforms.uniforms;

        localUniforms.uTransformMatrix = graphics.groupTransform;
        localUniforms.uRound = renderer._roundPixels | graphics._roundPixels;

        color32BitToUniform(
            graphics.groupColorAlpha,
            localUniforms.uColor,
            0,
        );

        this._adaptor.execute(this, graphics, shader);
    }

    private _rebuild(graphics: Graphics)
    {
        const gpuData = this._getGpuDataForRenderable(graphics);

        const contextSystem = this.renderer.graphicsContext as GraphicsContextSystem;
        const gpuContext = contextSystem.updateGpuContext(graphics.context);

        // free up the batches..
        gpuData.destroy();

        if (gpuContext.isBatchable)
        {
            this._updateBatchesForRenderable(graphics, gpuData);
        }
    }

    private _addToBatcher(graphics: Graphics, instructionSet: InstructionSet)
    {
        const batchPipe = this.renderer.renderPipes.batch;

        const batches = this._getGpuDataForRenderable(graphics).batches;

        for (let i = 0; i < batches.length; i++)
        {
            const batch = batches[i];

            batchPipe.addToBatch(batch, instructionSet);
        }
    }

    private _getGpuDataForRenderable(graphics: Graphics): GraphicsGpuData
    {
        return graphics._gpuData[this.renderer.uid] || this._initGpuDataForRenderable(graphics);
    }

    private _initGpuDataForRenderable(graphics: Graphics): GraphicsGpuData
    {
        const gpuData = new GraphicsGpuData();

        graphics._gpuData[this.renderer.uid] = gpuData;

        this._managedGraphics.add(graphics);

        return gpuData;
    }

    private _updateBatchesForRenderable(graphics: Graphics, gpuData: GraphicsGpuData)
    {
        const context = graphics.context;
        const contextSystem = this.renderer.graphicsContext as GraphicsContextSystem;
        const gpuContext: GpuGraphicsContext = contextSystem.getGpuContext(context);

        const roundPixels = (this.renderer._roundPixels | graphics._roundPixels) as 0 | 1;

        gpuData.batches = gpuContext.batches.map((batch) =>
        {
            const batchClone = BigPool.get(BatchableGraphics);

            batch.copyTo(batchClone);

            batchClone.renderable = graphics;

            batchClone.roundPixels = roundPixels;

            return batchClone;
        });
    }

    public destroy()
    {
        this._managedGraphics.destroy();
        this.renderer = null;

        this._adaptor.destroy();
        this._adaptor = null;
        this.state = null;
    }
}
