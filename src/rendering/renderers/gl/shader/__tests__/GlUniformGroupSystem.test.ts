import { Shader } from '../../../shared/shader/Shader';
import { UniformGroup } from '../../../shared/shader/UniformGroup';
import { GlProgram } from '../GlProgram';
import { getWebGLRenderer } from '@test-utils';

import type { WebGLRenderer } from '../../WebGLRenderer';

let renderer: WebGLRenderer;

beforeEach(async () =>
{
    renderer = await getWebGLRenderer({ preferWebGLVersion: 2 });
});

afterEach(() =>
{
    renderer.destroy();
    renderer = null;
});

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

/** The gl.uniform* calls made while `run` runs. */
function uniformCalls(run: () => void): string[]
{
    const gl = renderer.gl as unknown as Record<string, (...args: unknown[]) => unknown>;
    const calls: string[] = [];
    const originals: Record<string, (...args: unknown[]) => unknown> = {};

    for (const name of Object.keys(Object.getPrototypeOf(gl)).concat(Object.keys(gl)))
    {
        if (!name.startsWith('uniform') || typeof gl[name] !== 'function' || originals[name]) continue;
        originals[name] = gl[name];
        gl[name] = (...args: unknown[]) =>
        {
            calls.push(name);

            return originals[name].apply(renderer.gl, args);
        };
    }

    try
    {
        run();
    }
    finally
    {
        for (const name in originals) gl[name] = originals[name];
    }

    return calls;
}

describe('GlUniformGroupSystem', () =>
{
    it('should give a program linked again for a new context a sync function of its own again', () =>
    {
        const glProgram = new GlProgram({ vertex, fragment, name: 'uniform-sync-test' });
        const uniforms = new UniformGroup({ uOffset: { value: new Float32Array([0.5, 0.25]), type: 'vec2<f32>' } });
        const shader = new Shader({ glProgram, resources: { uniforms } });

        renderer.shader.bind(shader, true);

        // as a link on a lost context leaves it: no uniforms found, so a sync function that sets none
        const found = glProgram._uniformData;

        glProgram._uniformData = {};
        expect(uniformCalls(() => renderer.shader.updateUniformGroup(uniforms))).toEqual([]);

        // the context given back: the program is linked again, and finds its uniforms
        glProgram._uniformData = found;
        (renderer.uniformGroup as unknown as { contextChange(gl: unknown): void }).contextChange(renderer.gl);
        uniforms.update();

        expect(uniformCalls(() => renderer.shader.updateUniformGroup(uniforms)).length).toBeGreaterThan(0);
    });
});
