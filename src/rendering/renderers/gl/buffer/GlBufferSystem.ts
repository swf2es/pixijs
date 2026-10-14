import { ExtensionType } from '../../../../extensions/Extensions';
import { GCManagedHash } from '../../../../utils/data/GCManagedHash';
import { BufferUsage } from '../../shared/buffer/const';
import { BUFFER_TYPE } from './const';
import { GlBuffer } from './GlBuffer';

import type { Buffer } from '../../shared/buffer/Buffer';
import type { System } from '../../shared/system/System';
import type { GlRenderingContext } from '../context/GlRenderingContext';
import type { WebGLRenderer } from '../WebGLRenderer';

/**
 * System plugin to the renderer to manage buffers.
 *
 * WebGL uses Buffers as a way to store objects to the GPU.
 * This system makes working with them a lot easier.
 *
 * Buffers are used in three main places in WebGL
 * - geometry information
 * - Uniform information (via uniform buffer objects - a WebGL 2 only feature)
 * - Transform feedback information. (WebGL 2 only feature)
 *
 * This system will handle the binding of buffers to the GPU as well as uploading
 * them. With this system, you never need to work directly with GPU buffers, but instead work with
 * the Buffer class.
 * @class
 * @category rendering
 * @advanced
 */
export class GlBufferSystem implements System
{
    /** @ignore */
    public static extension = {
        type: [
            ExtensionType.WebGLSystem,
        ],
        name: 'buffer',
    } as const;

    /** @internal */
    public _gl: GlRenderingContext;
    protected _managedBuffers: GCManagedHash<Buffer>;

    /** Cache keeping track of the base bound buffer bases */
    private _boundBufferBases: {[key: number]: GlBuffer} = Object.create(null);

    private _renderer: WebGLRenderer;

    private _minBaseLocation = 0;
    private _maxBindings: number;
    private _nextBindBaseIndex = this._minBaseLocation;
    private _bindCallId = 0;

    /**
     * @param {Renderer} renderer - The renderer this System works for.
     */
    constructor(renderer: WebGLRenderer)
    {
        this._renderer = renderer;
        this._managedBuffers = new GCManagedHash({
            renderer,
            type: 'resource',
            onUnload: this.onBufferUnload.bind(this),
            name: 'glBuffer'
        });
    }

    /** @ignore */
    public destroy(): void
    {
        this._managedBuffers.destroy();
        this._renderer = null;
        this._gl = null;
        this._boundBufferBases = {};
    }

    /** Sets up the renderer context and necessary buffers. */
    protected contextChange(): void
    {
        this._gl = this._renderer.gl;

        this.destroyAll(true);
        this._maxBindings = this._renderer.limits.maxUniformBindings;
    }

    /**
     * Has the buffer's GL copy made again at the size of the data it is next given. Uploading smaller
     * data otherwise writes it into the larger copy, which is kept: for a buffer cut back on the CPU,
     * whose GPU copy should be cut back too.
     * @param buffer - The buffer to resize on the GPU.
     */
    public resizeOnNextUpload(buffer: Buffer): void
    {
        const glBuffer = buffer._gpuData[this._renderer.uid] as GlBuffer;

        if (glBuffer)
        {
            glBuffer.byteLength = -1;
        }
    }

    /**
     * Makes the buffer's GPU copy `byteLength` bytes long, keeping its first `keep` bytes, for a buffer
     * whose contents live on the GPU alone and are written there with writeOnGpu: `buffer.data` is
     * neither read nor uploaded, so the CPU need keep no copy of what it sent. The GPU copies what is
     * kept, through a buffer of its own, and the GL buffer stays the same object, so that the vertex
     * arrays that read it need not be made again. A lost context takes what it held; its owner is to
     * write it again as it learns of the loss (runners.contextChange). WebGL 2 only.
     * @param buffer - The buffer, which should not be garbage collected (`autoGarbageCollect` false), as
     * its contents could not be uploaded again.
     * @param byteLength - The bytes the GPU's copy is to hold.
     * @param keep - The bytes from its start to keep, at most what it held and `byteLength`.
     */
    public resizeOnGpu(buffer: Buffer, byteLength: number, keep = 0): void
    {
        const gl = this._gl as WebGL2RenderingContext;
        const glBuffer = this.getGlBuffer(buffer);
        const drawType = (buffer.descriptor.usage & BufferUsage.STATIC) ? gl.STATIC_DRAW : gl.DYNAMIC_DRAW;

        keep = Math.min(keep, Math.max(glBuffer.byteLength, 0), byteLength);
        // an index buffer bound while a vertex array is would become that array's
        this._renderer.geometry.resetState();

        let held: WebGLBuffer = null;

        if (keep > 0)
        {
            // bound first to the buffer's own type: WebGL 2 copies index data only into index buffers
            held = gl.createBuffer();
            gl.bindBuffer(glBuffer.type, held);
            gl.bufferData(glBuffer.type, keep, gl.STREAM_COPY);
            gl.bindBuffer(gl.COPY_READ_BUFFER, glBuffer.buffer);
            gl.copyBufferSubData(gl.COPY_READ_BUFFER, glBuffer.type, 0, 0, keep);
        }

        gl.bindBuffer(glBuffer.type, glBuffer.buffer);
        gl.bufferData(glBuffer.type, byteLength, drawType);

        if (held)
        {
            gl.bindBuffer(gl.COPY_READ_BUFFER, held);
            gl.copyBufferSubData(gl.COPY_READ_BUFFER, glBuffer.type, 0, 0, keep);
            gl.deleteBuffer(held);
        }

        gl.bindBuffer(gl.COPY_READ_BUFFER, null);
        glBuffer.byteLength = byteLength;
        // nothing of buffer.data is to go up over what is written
        glBuffer.updateID = buffer._updateID;
    }

    /**
     * The bytes the buffer's GPU copy holds, as resizeOnGpu last made it: -1 if it has none, as a lost
     * context leaves it, or if its data has changed since and is to be uploaded over it.
     * @param buffer - The buffer.
     * @returns Its GPU copy's length in bytes, or -1.
     */
    public sizeOnGpu(buffer: Buffer): number
    {
        const glBuffer = buffer._gpuData[this._renderer.uid] as GlBuffer;

        return glBuffer && glBuffer.updateID === buffer._updateID ? glBuffer.byteLength : -1;
    }

    /**
     * Writes `data` into the buffer's GPU copy at `byteOffset` without a copy on the CPU, `buffer.data`
     * left as it is: for a buffer resizeOnGpu made, long enough already. Bound to the copy target, so
     * neither the vertex array bound nor the buffer bound for vertices changes. WebGL 2 only.
     * @param buffer - The buffer to write into.
     * @param byteOffset - Where in the GPU's copy to write, in bytes.
     * @param data - What to write from.
     * @param srcOffset - The first element of `data` to write.
     * @param length - How many elements of `data` to write.
     */
    public writeOnGpu(
        buffer: Buffer,
        byteOffset: number,
        data: ArrayBufferView & { length: number },
        srcOffset = 0,
        length = data.length - srcOffset
    ): void
    {
        if (length <= 0) return;

        const gl = this._gl as WebGL2RenderingContext;
        const glBuffer = this.getGlBuffer(buffer);

        gl.bindBuffer(gl.COPY_WRITE_BUFFER, glBuffer.buffer);
        gl.bufferSubData(gl.COPY_WRITE_BUFFER, byteOffset, data, srcOffset, length);
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
    }

    public getGlBuffer(buffer: Buffer): GlBuffer
    {
        buffer._gcLastUsed = this._renderer.gc.now;

        return (buffer._gpuData[this._renderer.uid] as GlBuffer) || this.createGLBuffer(buffer);
    }

    /**
     * This binds specified buffer. On first run, it will create the webGL buffers for the context too
     * @param buffer - the buffer to bind to the renderer
     */
    public bind(buffer: Buffer): void
    {
        const { _gl: gl } = this;

        const glBuffer = this.getGlBuffer(buffer);

        gl.bindBuffer(glBuffer.type, glBuffer.buffer);
    }

    /**
     * Binds an uniform buffer to at the given index.
     *
     * A cache is used so a buffer will not be bound again if already bound.
     * @param glBuffer - the buffer to bind
     * @param index - the base index to bind it to.
     */
    public bindBufferBase(glBuffer: GlBuffer, index: number): void
    {
        const { _gl: gl } = this;

        if (this._boundBufferBases[index] !== glBuffer)
        {
            this._boundBufferBases[index] = glBuffer;
            glBuffer._lastBindBaseLocation = index;

            gl.bindBufferBase(gl.UNIFORM_BUFFER, index, glBuffer.buffer);
        }
    }

    public nextBindBase(hasTransformFeedback: boolean)
    {
        this._bindCallId++;
        this._minBaseLocation = 0;
        if (hasTransformFeedback)
        {
            this._boundBufferBases[0] = null;
            this._minBaseLocation = 1;
            if (this._nextBindBaseIndex < 1)
            {
                this._nextBindBaseIndex = 1;
            }
        }
    }

    public freeLocationForBufferBase(glBuffer: GlBuffer): number
    {
        let freeIndex = this.getLastBindBaseLocation(glBuffer);

        // check if it is already bound..
        if (freeIndex >= this._minBaseLocation)
        {
            glBuffer._lastBindCallId = this._bindCallId;

            return freeIndex;
        }

        let loop = 0;
        let nextIndex = this._nextBindBaseIndex;

        while (loop < 2)
        {
            if (nextIndex >= this._maxBindings)
            {
                nextIndex = this._minBaseLocation;
                loop++;
            }

            const curBuf = this._boundBufferBases[nextIndex];

            if (curBuf && curBuf._lastBindCallId === this._bindCallId)
            {
                nextIndex++;
                continue;
            }
            break;
        }

        freeIndex = nextIndex;
        this._nextBindBaseIndex = nextIndex + 1;

        if (loop >= 2)
        {
            // TODO: error
            return -1;
        }

        glBuffer._lastBindCallId = this._bindCallId;
        this._boundBufferBases[freeIndex] = null;

        return freeIndex;
    }

    public getLastBindBaseLocation(glBuffer: GlBuffer): number
    {
        const index = glBuffer._lastBindBaseLocation;

        if (this._boundBufferBases[index] === glBuffer)
        {
            return index;
        }

        return -1;
    }

    /**
     * Binds a buffer whilst also binding its range.
     * This will make the buffer start from the offset supplied rather than 0 when it is read.
     * @param glBuffer - the buffer to bind
     * @param index - the base index to bind at, defaults to 0
     * @param offset - the offset to bind at (this is blocks of 256). 0 = 0, 1 = 256, 2 = 512 etc
     * @param size - the size to bind at (this is blocks of 256).
     */
    public bindBufferRange(glBuffer: GlBuffer, index?: number, offset?: number, size?: number): void
    {
        const { _gl: gl } = this;

        offset ||= 0;
        index ||= 0;

        this._boundBufferBases[index] = null;

        gl.bindBufferRange(gl.UNIFORM_BUFFER, index || 0, glBuffer.buffer, offset * 256, size || 256);
    }

    /**
     * Will ensure the data in the buffer is uploaded to the GPU.
     * @param {Buffer} buffer - the buffer to update
     */
    public updateBuffer(buffer: Buffer): GlBuffer
    {
        const { _gl: gl } = this;

        const glBuffer = this.getGlBuffer(buffer);

        if (buffer._updateID === glBuffer.updateID)
        {
            return glBuffer;
        }

        glBuffer.updateID = buffer._updateID;

        gl.bindBuffer(glBuffer.type, glBuffer.buffer);

        const data = buffer.data;

        const drawType = (buffer.descriptor.usage & BufferUsage.STATIC) ? gl.STATIC_DRAW : gl.DYNAMIC_DRAW;

        if (data)
        {
            if (glBuffer.byteLength >= data.byteLength)
            {
                // assuming our buffers are aligned to 4 bits...
                gl.bufferSubData(
                    glBuffer.type,
                    buffer._updateOffset,
                    data,
                    buffer._updateOffset / data.BYTES_PER_ELEMENT,
                    (buffer._updateSize || data.byteLength) / data.BYTES_PER_ELEMENT
                );
            }
            else
            {
                glBuffer.byteLength = data.byteLength;
                // assuming our buffers are aligned to 4 bits...
                gl.bufferData(glBuffer.type, data, drawType);
            }
        }
        else
        {
            glBuffer.byteLength = buffer.descriptor.size;
            gl.bufferData(glBuffer.type, glBuffer.byteLength, drawType);
        }

        return glBuffer;
    }

    /**
     * dispose all WebGL resources of all managed buffers
     * @param contextLost
     */
    public destroyAll(contextLost: boolean = false): void
    {
        this._managedBuffers.removeAll(contextLost);
    }

    protected onBufferUnload(buffer: Buffer, contextLost: boolean = false): void
    {
        const glBuffer = buffer._gpuData[this._renderer.uid] as GlBuffer;

        if (!glBuffer) return;
        if (!contextLost) this._gl.deleteBuffer(glBuffer.buffer);
    }

    /**
     * creates and attaches a GLBuffer object tied to the current context.
     * @param buffer
     * @protected
     */
    protected createGLBuffer(buffer: Buffer): GlBuffer
    {
        const { _gl: gl } = this;

        let type = BUFFER_TYPE.ARRAY_BUFFER;

        if ((buffer.descriptor.usage & BufferUsage.INDEX))
        {
            type = BUFFER_TYPE.ELEMENT_ARRAY_BUFFER;
        }
        else if ((buffer.descriptor.usage & BufferUsage.UNIFORM))
        {
            type = BUFFER_TYPE.UNIFORM_BUFFER;
        }

        const glBuffer = new GlBuffer(gl.createBuffer(), type);

        buffer._gpuData[this._renderer.uid] = glBuffer;
        this._managedBuffers.add(buffer);

        return glBuffer;
    }

    public resetState(): void
    {
        this._boundBufferBases = Object.create(null);
    }
}
