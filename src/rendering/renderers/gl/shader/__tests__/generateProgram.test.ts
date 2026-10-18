import { GlProgram } from '../GlProgram';
import { getWebGLRenderer } from '@test-utils';

import type { WebGLRenderer } from '../../WebGLRenderer';

const vertex = /* glsl */`#version 300 es
    in vec2 aPosition;
    uniform vec2 uOffset;
    void main() { gl_Position = vec4(aPosition + uOffset, 0.0, 1.0); }
`;

const fragment = /* glsl */`#version 300 es
    precision mediump float;
    out vec4 finalColor;
    void main() { finalColor = vec4(1.0); }
`;

describe('generateProgram', () =>
{
    let kept: WebGLRenderer;
    let losing: WebGLRenderer;

    beforeEach(async () =>
    {
        kept = await getWebGLRenderer({ preferWebGLVersion: 2 });
        losing = await getWebGLRenderer({ preferWebGLVersion: 2 });
    });

    afterEach(() =>
    {
        kept.destroy();
        losing.destroy();
    });

    it('should keep what another renderer found of a shared program when linking it on a lost context', () =>
    {
        const program = new GlProgram({ vertex, fragment, name: 'shared-program-test' });

        kept.shader._getProgramData(program);
        expect(Object.keys(program._uniformData)).toEqual(['uOffset']);
        expect(Object.keys(program._attributeData)).toEqual(['aPosition']);

        // a lost context, as a link on it reads it: lost, and no attributes, uniforms or blocks found
        const gl = losing.gl;
        const counts: number[] = [gl.ACTIVE_ATTRIBUTES, gl.ACTIVE_UNIFORMS, gl.ACTIVE_UNIFORM_BLOCKS];
        const parameter = gl.getProgramParameter.bind(gl);

        gl.isContextLost = () => true;
        gl.getProgramParameter = (p: WebGLProgram, name: number) => (counts.includes(name) ? 0 : parameter(p, name));
        losing.shader._getProgramData(program);

        expect(Object.keys(program._uniformData)).toEqual(['uOffset']);
        expect(Object.keys(program._attributeData)).toEqual(['aPosition']);
        expect(program._uniformBlockData).toEqual({});
    });
});
