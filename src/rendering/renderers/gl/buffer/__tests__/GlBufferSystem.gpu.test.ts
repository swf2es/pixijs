import { getWebGLRenderer } from '@test-utils';
import { Buffer } from '~/rendering/renderers/shared/buffer/Buffer';
import { BufferUsage } from '~/rendering/renderers/shared/buffer/const';

import type { WebGLRenderer } from '~/rendering/renderers/gl/WebGLRenderer';

/**
 * What the GPU's copy of `buffer` holds, read back.
 * @param renderer - the renderer whose copy to read
 * @param buffer - the buffer to read
 * @param Type - the kind of array to read it as
 * @param count - how many elements to read
 * @returns the elements read
 */
function readBack<T extends Float32Array | Uint32Array>(
    renderer: WebGLRenderer,
    buffer: Buffer,
    Type: new (length: number) => T,
    count: number
): T
{
    const gl = renderer.gl as WebGL2RenderingContext;
    const out = new Type(count);

    gl.bindBuffer(gl.COPY_READ_BUFFER, renderer.buffer.getGlBuffer(buffer).buffer);
    gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, out);
    gl.bindBuffer(gl.COPY_READ_BUFFER, null);

    return out;
}

describe('GlBufferSystem on the GPU alone', () =>
{
    it('should write a vertex buffer and grow it, keeping what it held, with no CPU copy', async () =>
    {
        const renderer = (await getWebGLRenderer()) as WebGLRenderer;
        const placeholder = new Float32Array(0);
        const buffer = new Buffer({ data: placeholder, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });

        buffer.autoGarbageCollect = false;
        renderer.buffer.resizeOnGpu(buffer, 4 * 4);
        renderer.buffer.writeOnGpu(buffer, 0, new Float32Array([1, 2, 3, 4]));
        renderer.buffer.writeOnGpu(buffer, 8, new Float32Array([9, 7, 8, 9]), 1, 2);

        expect(Array.from(readBack(renderer, buffer, Float32Array, 4))).toEqual([1, 2, 7, 8]);

        renderer.buffer.resizeOnGpu(buffer, 8 * 4, 3 * 4);
        renderer.buffer.writeOnGpu(buffer, 3 * 4, new Float32Array([5, 6]));

        expect(renderer.buffer.getGlBuffer(buffer).byteLength).toBe(8 * 4);
        expect(Array.from(readBack(renderer, buffer, Float32Array, 5))).toEqual([1, 2, 7, 5, 6]);
        expect(buffer.data).toBe(placeholder);

        // binding it as Pixi does uploads nothing over what was written
        renderer.buffer.updateBuffer(buffer);
        expect(Array.from(readBack(renderer, buffer, Float32Array, 5))).toEqual([1, 2, 7, 5, 6]);

        renderer.destroy();
    });

    it('should grow an index buffer without touching the vertex array bound', async () =>
    {
        const renderer = (await getWebGLRenderer()) as WebGLRenderer;
        const gl = renderer.gl as WebGL2RenderingContext;
        const buffer = new Buffer({ data: new Uint32Array(0), usage: BufferUsage.INDEX | BufferUsage.COPY_DST });
        const vao = gl.createVertexArray();
        const own = gl.createBuffer();

        buffer.autoGarbageCollect = false;
        renderer.buffer.resizeOnGpu(buffer, 2 * 4);
        renderer.buffer.writeOnGpu(buffer, 0, new Uint32Array([4, 5]));

        // a vertex array of someone else's, bound with its index buffer as it would be to draw
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, own);
        renderer.buffer.writeOnGpu(buffer, 0, new Uint32Array([6]));

        expect(gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING)).toBe(own);

        renderer.buffer.resizeOnGpu(buffer, 6 * 4, 2 * 4);
        gl.bindVertexArray(vao);

        expect(gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING)).toBe(own);
        expect(Array.from(readBack(renderer, buffer, Uint32Array, 2))).toEqual([6, 5]);

        gl.bindVertexArray(null);
        gl.deleteVertexArray(vao);
        gl.deleteBuffer(own);
        renderer.destroy();
    });
});
