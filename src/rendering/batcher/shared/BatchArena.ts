import { ViewableBuffer } from '../../../utils/data/ViewableBuffer';

import type { Buffer, TypedArray } from '../../renderers/shared/buffer/Buffer';
import type { IndexBufferArray } from '../../renderers/shared/geometry/Geometry';
import type { Batcher } from './Batcher';

/**
 * How a batch arena reaches the GPU's copies of batchers' buffers: a WebGL 2 renderer's buffer system.
 * @category rendering
 * @advanced
 */
export interface BatchArenaGpu
{
    /** The bytes the GPU's copy of `buffer` holds, as resizeOnGpu made it; -1 if it has none. */
    sizeOnGpu(buffer: Buffer): number;
    /** Makes the GPU's copy of `buffer` `byteLength` bytes long, keeping nothing of it. */
    resizeOnGpu(buffer: Buffer, byteLength: number): void;
    /** Writes `length` elements of `data` from `srcOffset` into the GPU's copy at `byteOffset`. */
    writeOnGpu(buffer: Buffer, byteOffset: number, data: TypedArray, srcOffset: number, length: number): void;
}

/** What a batcher packs into as it builds: an attribute buffer and an index buffer. */
interface Packing
{
    attributes: ViewableBuffer;
    indices: IndexBufferArray;
}

/** Floats of updated elements gathered at most before they are written, 1 MB. */
const UPDATES_MOST = 1 << 18;
/** GPU copies smaller than this are not made smaller. */
const SHRINK_FLOOR = 1 << 16;

const EMPTY_FLOATS = new Float32Array(0);
const EMPTY_SHORTS = new Uint16Array(0);
const EMPTY_INTS = new Uint32Array(0);

/**
 * Where batchers pack, shared by every instruction set a batch pipe builds, and from which what they
 * pack goes to the GPU, which alone keeps it.
 *
 * A batcher keeps the buffers it packed into for as long as it lives, to update elements in place and
 * to upload them again, and grows them to the most it ever packed: one per batcher name per render
 * group, so a renderer with many groups held all their vertices on the CPU as well as on the GPU. Here
 * a batcher packs into buffers it is lent for its build, one set per batcher name, which grow to the
 * largest build and pass from group to group. As the build ends, what was packed is written to the
 * batcher's geometry on the GPU, and the batcher is given back buffers of its own that hold nothing.
 *
 * An element updated in place, as a sprite that moved, is packed into a buffer of updates instead,
 * with where it goes; those are written, runs of neighbours together, before the batches draw.
 *
 * A lost context takes the GPU's copies: render groups are built again for the new one
 * (RenderGroupSystem), which packs them anew.
 * @category rendering
 * @advanced
 */
export class BatchArena
{
    /** Updated elements' attributes, packed one after another, for the batchers to write their own into. */
    public updates = new ViewableBuffer(4096);

    private readonly _gpu: BatchArenaGpu;
    private readonly _packing: Record<string, Packing> = Object.create(null);
    /** The buffers of their own the batchers lent packing buffers hold meanwhile. */
    private readonly _own = new Map<Batcher, Packing>();
    /** The floats of updates gathered. */
    private _updateSize = 0;
    /** Each run of updates to write: its batcher, and where it goes, where it lies and its floats. */
    private readonly _runs: Batcher[] = [];
    private readonly _spans: number[] = [];
    /** The most bytes of attributes and of indices each batcher name packed in a build since trim last looked. */
    private _most: Record<string, [number, number]> = Object.create(null);
    /** When each name's packing buffers were first seen holding four times what its builds packed. */
    private readonly _lowSince: Record<string, number> = Object.create(null);

    constructor(gpu: BatchArenaGpu)
    {
        this._gpu = gpu;
    }

    /**
     * Lends `batcher` the packing buffers of its name for a build, unless it has them already: the
     * buffers of its own are kept until end gives them back.
     * @param batcher - the batcher about to build
     */
    public lend(batcher: Batcher): void
    {
        if (this._own.has(batcher)) return;

        const name = batcher.name;
        const own: Packing = { attributes: batcher.attributeBuffer, indices: batcher.indexBuffer };
        // taken out while lent: another batcher of the name building meanwhile packs into its own
        const packing = this._packing[name];

        delete this._packing[name];
        batcher._arena = this;
        this._own.set(batcher, own);

        if (packing)
        {
            batcher.attributeBuffer = packing.attributes;
            batcher.indexBuffer = packing.indices;
        }
        else
        {
            // its own become the name's packing buffers, and it is given empty ones in their place
            own.attributes = new ViewableBuffer(0);
            own.indices = new Uint16Array(0);
        }
    }

    /**
     * Writes what `batcher` packed in its build to its geometry on the GPU, the GPU's copies made
     * larger or smaller to fit, and gives it its own buffers back. Its geometry's buffers are left
     * holding empty arrays, of the type the indices were packed as, which a draw reads the index type
     * from, and are kept from collection, as nothing could upload them again.
     * @param batcher - the batcher whose build has ended
     */
    public end(batcher: Batcher): void
    {
        const own = this._own.get(batcher);

        if (!own) return;

        const geometry = batcher.geometry;
        const attributes = geometry.buffers[0];
        const indexBuffer = geometry.indexBuffer;
        const indices = batcher.indexBuffer;

        attributes.autoGarbageCollect = false;
        indexBuffer.autoGarbageCollect = false;
        this._place(attributes, batcher.attributeBuffer.float32View, batcher.attributeSize);
        this._place(indexBuffer, indices, batcher.indexSize);
        attributes._releaseData(EMPTY_FLOATS);
        indexBuffer._releaseData(indices.BYTES_PER_ELEMENT === 4 ? EMPTY_INTS : EMPTY_SHORTS);

        const most = this._most[batcher.name] ??= [0, 0];

        most[0] = Math.max(most[0], batcher.attributeSize * 4);
        most[1] = Math.max(most[1], batcher.indexSize * indices.BYTES_PER_ELEMENT);

        const packing = this._packing[batcher.name];

        // what the build grew is kept for the next, the larger where two of a name built at once
        if (!packing || packing.attributes.size < batcher.attributeBuffer.size)
        {
            this._packing[batcher.name] = { attributes: batcher.attributeBuffer, indices };
        }

        batcher.attributeBuffer = own.attributes;
        batcher.indexBuffer = own.indices;
        this._own.delete(batcher);
    }

    /**
     * Room for `floats` more floats of updates, for an element whose attributes go at `start` in
     * `batcher`'s: where in `updates` to pack them. Updates gathered already are written first if
     * there are too many.
     * @param batcher - the batcher whose element is updated
     * @param start - where the element's attributes lie in the batcher's, in floats
     * @param floats - how many floats the element's attributes take
     * @returns where to pack them in `updates`, in floats
     */
    public reserveUpdate(batcher: Batcher, start: number, floats: number): number
    {
        let at = this._updateSize;

        if (at + floats > this.updates.float32View.length)
        {
            if (at + floats > UPDATES_MOST)
            {
                this.flush();
                at = 0;
            }

            if (at + floats > this.updates.float32View.length)
            {
                const grown = new ViewableBuffer(Math.max((at + floats) * 4, this.updates.size * 2));

                grown.float32View.set(this.updates.float32View.subarray(0, at));
                this.updates = grown;
            }
        }

        const runs = this._runs;
        const spans = this._spans;
        const last = runs.length - 1;

        // the next element of a run that went before, as most updates of a group are
        if (last >= 0 && runs[last] === batcher
            && spans[(last * 3)] + spans[(last * 3) + 2] === start
            && spans[(last * 3) + 1] + spans[(last * 3) + 2] === at)
        {
            spans[(last * 3) + 2] += floats;
        }
        else
        {
            runs.push(batcher);
            spans.push(start, at, floats);
        }

        this._updateSize = at + floats;

        return at;
    }

    /** Writes the updates gathered to their batchers' geometry on the GPU: before anything draws them. */
    public flush(): void
    {
        const runs = this._runs;

        if (runs.length === 0) return;

        const spans = this._spans;
        const floats = this.updates.float32View;

        for (let i = 0; i < runs.length; i++)
        {
            const geometry = runs[i].geometry;

            // destroyed since
            if (!geometry) continue;

            this._gpu.writeOnGpu(geometry.buffers[0], spans[i * 3] * 4, floats, spans[(i * 3) + 1], spans[(i * 3) + 2]);
        }

        runs.length = 0;
        spans.length = 0;
        this._updateSize = 0;
    }

    /**
     * Cuts back the packing buffers of each batcher name whose builds have packed under a quarter of them
     * since `ms` before `now`, to twice the most they packed: they grow to the largest build ever made,
     * so one large group, gone since, would otherwise have them held for as long as the renderer lives.
     * Nothing is copied, as they hold nothing between builds.
     * @param now - the time now, in milliseconds
     * @param floor - the bytes below which they are not cut back
     * @param ms - how long they must have been used that little
     */
    public trim(now: number, floor: number, ms: number): void
    {
        const mosts = this._most;

        this._most = Object.create(null);

        for (const name in this._packing)
        {
            const packing = this._packing[name];
            const most = mosts[name] ?? [0, 0];
            const held = packing.attributes.size + packing.indices.byteLength;

            if (held < floor || (most[0] + most[1]) * 4 > held)
            {
                delete this._lowSince[name];
                continue;
            }

            const since = this._lowSince[name];

            if (since === undefined)
            {
                this._lowSince[name] = now;
                continue;
            }

            if (now - since < ms) continue;

            delete this._lowSince[name];

            const IndexArray = packing.indices.constructor as Uint16ArrayConstructor;
            const length = Math.max(Math.ceil(most[1] * 2 / packing.indices.BYTES_PER_ELEMENT), 6);

            packing.attributes.destroy();
            this._packing[name] = {
                attributes: new ViewableBuffer(Math.max(Math.ceil(most[0] * 2 / 4) * 4, 16)),
                indices: new IndexArray(length + (length % 2)),
            };
        }
    }

    /** The context was lost, and with it what the updates gathered were to be written into. */
    public lost(): void
    {
        this._runs.length = 0;
        this._spans.length = 0;
        this._updateSize = 0;
    }

    public destroy(): void
    {
        for (const [batcher] of this._own)
        {
            this.end(batcher);
        }

        this.lost();
        this.updates = null;
    }

    /**
     * Writes the first `count` of `data` into `buffer`'s GPU copy, made again if too small or far too large.
     * @param buffer - the buffer whose GPU copy to write
     * @param data - what was packed
     * @param count - how many of its elements to write
     */
    private _place(buffer: Buffer, data: TypedArray, count: number): void
    {
        const bytes = count * data.BYTES_PER_ELEMENT;
        const held = this._gpu.sizeOnGpu(buffer);

        if (held < bytes || (held > SHRINK_FLOOR && bytes * 4 < held))
        {
            // room to grow, as a group that grew is likely to again
            this._gpu.resizeOnGpu(buffer, Math.max(Math.ceil(bytes * 1.5 / 4) * 4, 256));
        }

        if (count > 0) this._gpu.writeOnGpu(buffer, 0, data, 0, count);
    }
}
