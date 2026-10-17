import { Geometry } from '../../../shared/geometry/Geometry';
import { GlProgram } from '../../shader/GlProgram';
import { getWebGLRenderer } from '@test-utils';

import type { WebGLRenderer } from '../../WebGLRenderer';
import type { GlGeometryGpuData } from '../GlGeometrySystem';

const fragment = 'void main() { gl_FragColor = vec4(1.0); }';

/**
 * A program reading the quad's positions, made distinct by its scale.
 * @param scale - what positions are multiplied by
 */
function program(scale: string): GlProgram
{
    return GlProgram.from({
        vertex: `attribute vec2 aPosition; void main() { gl_Position = vec4(aPosition * ${scale}, 0.0, 1.0); }`,
        fragment,
    });
}

describe('GlGeometrySystem', () =>
{
    it('should give each program its own VAO as programs alternate, the last one kept', async () =>
    {
        const renderer = (await getWebGLRenderer()) as WebGLRenderer;
        const geometry = new Geometry({
            attributes: { aPosition: [0, 0, 1, 0, 1, 1, 0, 1] },
            indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
        });
        const a = program('1.0');
        const b = program('0.5');
        const vao = (p: GlProgram) =>
        {
            renderer.geometry.bind(geometry, p);

            return (renderer.geometry as unknown as { _activeVao: WebGLVertexArrayObject })._activeVao;
        };

        renderer.shader['_getProgramData'](a);
        renderer.shader['_getProgramData'](b);

        const first = vao(a);
        const other = vao(b);

        expect(vao(a)).toBe(first);
        expect(vao(b)).toBe(other);

        const gpuData = geometry._gpuData[renderer.uid] as GlGeometryGpuData;

        expect(gpuData.lastProgram).toBe(b);
        expect(gpuData.lastVao).toBe(other);

        // unloaded, as Pixi's collection does: the kept VAO goes with the rest, and a new one is made
        geometry.unload();
        expect(vao(a)).not.toBe(first);

        renderer.destroy();
    });
});
