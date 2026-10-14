import { extensions, ExtensionType } from '../../../extensions/Extensions';
import { ViewableBuffer } from '../../../utils/data/ViewableBuffer';
import { State } from '../../renderers/shared/state/State';
import { RendererType } from '../../renderers/types';
import { BatchArena } from './BatchArena';
import { DefaultBatcher } from './DefaultBatcher';

import type { WebGLRenderer } from '../../renderers/gl/WebGLRenderer';
import type { Buffer } from '../../renderers/shared/buffer/Buffer';
import type { Geometry } from '../../renderers/shared/geometry/Geometry';
import type { InstructionSet } from '../../renderers/shared/instructions/InstructionSet';
import type { BatchPipe, InstructionPipe } from '../../renderers/shared/instructions/RenderPipe';
import type { Shader } from '../../renderers/shared/shader/Shader';
import type { Renderer } from '../../renderers/types';
import type { Batch, BatchableElement, Batcher, BatcherOptions } from './Batcher';

/** @internal */
export interface BatcherAdaptor
{
    start(batchPipe: BatcherPipe, geometry: Geometry, shader: Shader): void
    init?(batchPipe: BatcherPipe): void;
    execute(batchPipe: BatcherPipe, batch: Batch): void
    contextChange?(): void;
}

/** Buffers smaller than this, attributes and indices together, are never cut back: not worth a copy. */
const TRIM_FLOOR = 1 << 16;
/**
 * How long a batcher may use under a quarter of its buffers before trim cuts them back. Long enough
 * that one whose use swings comes back to its peak first.
 */
const TRIM_MS = 3000;

/**
 * A pipe that batches elements into batches and sends them to the renderer.
 *
 * You can install new Batchers using ExtensionType.Batcher. Each render group will
 * have a default batcher and any required ones will be created on demand.
 * @category rendering
 * @advanced
 */
export class BatcherPipe implements InstructionPipe<Batch>, BatchPipe
{
    /** @ignore */
    public static extension = {
        type: [
            ExtensionType.WebGLPipes,
            ExtensionType.WebGPUPipes,
            ExtensionType.CanvasPipes,
        ],
        name: 'batch',
    } as const;

    public state: State = State.for2d();
    public renderer: Renderer;

    private readonly _batchersByInstructionSet: Record<number, Record<string, Batcher>> = Object.create(null);

    private _adaptor: BatcherAdaptor;

    /** A record of all active batchers, keyed by their names */
    private _activeBatches: Record<string, Batcher> = Object.create(null);

    /** The currently active batcher being used to batch elements */
    private _activeBatch: Batcher;

    public static _availableBatchers: Record<string, new (options: BatcherOptions) => Batcher> = Object.create(null);

    /**
     * Called as a build starts for an instruction set that has no batchers yet, to give it some, as
     * taken from a set that went (takeBatchers), rather than have new ones made; none from undefined.
     */
    public batchersFor: ((instructionSet: InstructionSet) => Record<string, Batcher> | undefined) | null = null;

    /**
     * Names the batcher an element is added to, in place of its own batcherName: for a renderer that
     * picks a batcher by what draws the element rather than by its kind.
     */
    public batcherNameFor: ((element: BatchableElement) => string) | null = null;

    /** When each batcher was first seen using under a quarter of its buffers, since it last used more. */
    private readonly _lowSince = new WeakMap<Batcher, number>();

    /** Where batchers pack and update while batches are kept on the GPU alone (gpuResident). */
    private _arena: BatchArena | null = null;

    public static getBatcher(name: string, maxTextures: number): Batcher
    {
        return new this._availableBatchers[name as keyof typeof this._availableBatchers]({ maxTextures });
    }

    constructor(renderer: Renderer, adaptor: BatcherAdaptor)
    {
        this.renderer = renderer;
        this._adaptor = adaptor;

        this._adaptor.init?.(this);
        renderer.runners.contextChange.add(this);
    }

    /**
     * Whether batches are kept on the GPU alone: batchers pack into buffers shared by every instruction
     * set, lent for each build and grown to the largest, and what they pack goes to the GPU as the build
     * ends; elements updated in place are written there apart (BatchArena). Otherwise each batcher keeps
     * what it packed for as long as it lives, to upload it again, which for a renderer of many render
     * groups is all their vertices held twice. WebGL 2 alone; set before anything is built with it,
     * since batchers built before keep their own. A lost context has every render group built again.
     */
    public get gpuResident(): boolean
    {
        return this._arena !== null;
    }

    public set gpuResident(value: boolean)
    {
        const renderer = this.renderer as WebGLRenderer | undefined;

        if (!value || renderer?.type !== RendererType.WEBGL || renderer.context?.webGLVersion !== 2)
        {
            this._arena?.destroy();
            this._arena = null;

            return;
        }

        if (this._arena) return;

        const buffers = renderer.buffer;

        this._arena = new BatchArena({
            sizeOnGpu: (buffer) => buffers.sizeOnGpu(buffer),
            resizeOnGpu: (buffer, byteLength) => buffers.resizeOnGpu(buffer, byteLength),
            writeOnGpu: (buffer, byteOffset, data, srcOffset, length) =>
                buffers.writeOnGpu(buffer, byteOffset, data, srcOffset, length),
        });
    }

    protected contextChange(): void
    {
        this._arena?.lost();
    }

    public buildStart(instructionSet: InstructionSet)
    {
        let batchers = this._batchersByInstructionSet[instructionSet.uid];

        if (!batchers)
        {
            batchers = this._batchersByInstructionSet[instructionSet.uid] = this.batchersFor?.(instructionSet)
                ?? Object.create(null);
            batchers.default ||= new DefaultBatcher({
                maxTextures: this.renderer.limits.maxBatchableTextures,
            });
        }

        this._activeBatches = batchers;

        this._activeBatch = this._activeBatches.default;

        for (const i in this._activeBatches)
        {
            this._arena?.lend(this._activeBatches[i]);
            this._activeBatches[i].begin();
        }
    }

    public addToBatch(batchableObject: BatchableElement, instructionSet: InstructionSet)
    {
        const batcherName = this.batcherNameFor ? this.batcherNameFor(batchableObject) : batchableObject.batcherName;

        if (this._activeBatch.name !== batcherName)
        {
            this._activeBatch.break(instructionSet);

            let batch = this._activeBatches[batcherName];

            if (!batch)
            {
                batch = this._activeBatches[batcherName]
                    = BatcherPipe.getBatcher(batcherName, this.renderer.limits.maxBatchableTextures);
                this._arena?.lend(batch);
                batch.begin();
            }

            this._activeBatch = batch;
        }

        this._activeBatch.add(batchableObject);
    }

    public break(instructionSet: InstructionSet)
    {
        this._activeBatch.break(instructionSet);
    }

    public buildEnd(instructionSet: InstructionSet)
    {
        this._activeBatch.break(instructionSet);

        const batches = this._activeBatches;

        for (const i in batches)
        {
            const batch = batches[i as keyof typeof batches];

            if (this._arena)
            {
                this._arena.end(batch);
                continue;
            }

            const geometry = batch.geometry;

            geometry.indexBuffer.setDataWithSize(batch.indexBuffer, batch.indexSize, true);

            geometry.buffers[0].setDataWithSize(batch.attributeBuffer.float32View, batch.attributeSize, false);
        }
    }

    public upload(instructionSet: InstructionSet)
    {
        // built ones are on the GPU already; what was updated in place goes there now
        if (this._arena)
        {
            this._arena.flush();

            return;
        }

        const batchers = this._batchersByInstructionSet[instructionSet.uid];

        for (const i in batchers)
        {
            const batcher = batchers[i as keyof typeof batchers];
            const geometry = batcher.geometry;

            if (batcher.dirty)
            {
                batcher.dirty = false;

                geometry.buffers[0].update(batcher.attributeSize * 4);
            }
        }
    }

    public execute(batch: Batch)
    {
        if (batch.action === 'startBatch')
        {
            // updates made since the upload, as a group cached as a texture makes its own
            this._arena?.flush();

            const batcher = batch.batcher;
            const geometry = batcher.geometry;
            const shader = batcher.shader;

            this._adaptor.start(this, geometry, shader);
        }

        this._adaptor.execute(this, batch);
    }

    /**
     * Takes the batchers kept for an instruction set out of the pipe, which keeps them by the set's uid
     * until the set is destroyed: for another set to build with (batchersFor), or to destroy.
     * @param instructionSetUid - the uid of the instruction set
     * @returns the batchers, by name, or undefined where the set has none
     */
    public takeBatchers(instructionSetUid: number): Record<string, Batcher> | undefined
    {
        const batchers = this._batchersByInstructionSet[instructionSetUid];

        delete this._batchersByInstructionSet[instructionSetUid];

        return batchers;
    }

    /**
     * Cuts back the buffers of the batchers that have used under a quarter of them since `TRIM_MS`
     * before `now`, to twice what they use. A batcher only grows its buffers, to twice the most a build
     * ever packed, so a render group that once held many elements, or that took a larger group's
     * batchers, kept megabytes for the few vertices it packs since. By time, so that a group that is
     * not rebuilt is cut back too. What the last build packed is kept: a group not rebuilt draws it
     * again, and an element updated in place writes where it was.
     * @param now - the time now, in milliseconds, as performance.now gives it
     */
    public trim(now: number = performance.now()): void
    {
        const sets = this._batchersByInstructionSet;

        for (const uid in sets)
        {
            const batchers = sets[uid];

            for (const name in batchers)
            {
                this._trim(batchers[name], now);
            }
        }
    }

    private _trim(batcher: Batcher, now: number): void
    {
        const attributes = batcher.attributeBuffer;
        const indices = batcher.indexBuffer;

        // destroyed, or yet to build
        if (!attributes || !indices || !batcher.geometry) return;

        const floats = batcher.attributeSize || 0;
        const count = batcher.indexSize || 0;
        const held = attributes.size + indices.byteLength;
        const used = (floats * 4) + (count * indices.BYTES_PER_ELEMENT);

        if (held < TRIM_FLOOR || used * 4 > held)
        {
            this._lowSince.delete(batcher);

            return;
        }

        const since = this._lowSince.get(batcher);

        if (since === undefined)
        {
            this._lowSince.set(batcher, now);

            return;
        }

        if (now - since < TRIM_MS) return;

        this._lowSince.delete(batcher);

        const packed = new ViewableBuffer(Math.max(floats * 2, 4) * 4);

        packed.float32View.set(attributes.float32View.subarray(0, floats));

        const length = Math.max(count * 2, 6);
        const indexed = new (indices.constructor as Uint16ArrayConstructor)(length + (length % 2));

        indexed.set(indices.subarray(0, count));
        attributes.destroy();
        batcher.attributeBuffer = packed;
        batcher.indexBuffer = indexed;

        const geometry = batcher.geometry;

        this._resizeOnGpu(geometry.buffers[0]);
        this._resizeOnGpu(geometry.indexBuffer);
        geometry.buffers[0].setDataWithSize(packed.float32View, floats, true);
        geometry.indexBuffer.setDataWithSize(indexed, count, true);
    }

    private _resizeOnGpu(buffer: Buffer): void
    {
        // WebGPU makes a buffer again as its size changes; a lost context's are made again anyway
        if (this.renderer.type === RendererType.WEBGL)
        {
            (this.renderer as WebGLRenderer).buffer.resizeOnNextUpload(buffer);
        }
    }

    /**
     * Releases all batchers cached for the given InstructionSet. Called from
     * `InstructionSet.destroy()` so that batchers (and their GPU geometry / attribute
     * buffers / referenced textures) do not leak when the owning RenderGroup is destroyed.
     * @param instructionSet - the instruction set being destroyed
     */
    public destroyInstructionSet(instructionSet: InstructionSet)
    {
        const batchers = this._batchersByInstructionSet[instructionSet.uid];

        if (!batchers) return;

        for (const i in batchers)
        {
            batchers[i].destroy();
        }

        delete this._batchersByInstructionSet[instructionSet.uid];

        if (this._activeBatches === batchers)
        {
            this._activeBatches = Object.create(null);
            this._activeBatch = null;
        }
    }

    public destroy()
    {
        this._arena?.destroy();
        this._arena = null;
        this.state = null;
        this.renderer?.runners?.contextChange.remove(this);
        this.renderer = null;

        this._adaptor = null;

        for (const i in this._activeBatches)
        {
            this._activeBatches[i].destroy();
        }

        this._activeBatches = null;
    }
}

extensions.handleByMap(ExtensionType.Batcher, BatcherPipe._availableBatchers);

extensions.add(DefaultBatcher);
