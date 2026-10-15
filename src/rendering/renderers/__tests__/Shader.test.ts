import { GpuProgram } from '../gpu/shader/GpuProgram';
import { Shader } from '../shared/shader/Shader';
import { getGlProgram } from '@test-utils';

import type { ShaderWithResources } from '../shared/shader/Shader';

describe('Shader', () =>
{
    it('should create correctly', () =>
    {
        const shader = new Shader({
            glProgram: getGlProgram(),
            resources: {}
        });

        expect(shader).toBeInstanceOf(Shader);
    });

    it('should destroyed', () =>
    {
        const shader = new Shader({
            glProgram: getGlProgram(),
            resources: {}
        });

        shader.destroy();

        expect(shader.glProgram).toBeNull();
    });

    it('should destroy programs if specified', () =>
    {
        const shader = new Shader({
            glProgram: getGlProgram(),
            resources: {}
        });

        const glProgram = shader.glProgram;

        shader.destroy(true);

        expect(glProgram._attributeData).toBeNull();
    });

    it('should keep GL-only resources in the group past the systems\' groups', () =>
    {
        const shader = new Shader({
            glProgram: getGlProgram(),
            resources: {
                uniforms: { uScale: { value: 2, type: 'f32' } },
                extra: { uOffset: { value: 1, type: 'f32' } },
            }
        });

        shader.groups[0] = shader.groups[4];

        expect(Object.keys(shader.groups)).toEqual(['0', '4']);
        expect(Object.keys(shader._uniformBindMap)).toEqual(['4']);
        expect(shader._uniformBindMap[4]).toEqual({ 0: 'uniforms', 1: 'extra' });
        expect(shader.resources.uniforms.uniforms.uScale).toBe(2);
        expect(shader.groups[4].resources[1]).toBe(shader.resources.extra);
    });

    it('should keep GL-only resources past the GPU program\'s groups', () =>
    {
        const source = `
            struct U { value: vec4<f32> };
            @group(0) @binding(0) var<uniform> first: U;
            @group(5) @binding(0) var<uniform> last: U;
            @vertex fn mainVertex() -> @builtin(position) vec4<f32> { return first.value + last.value; }
            @fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
        `;
        const shader = new Shader({
            glProgram: getGlProgram(),
            gpuProgram: GpuProgram.from({
                vertex: { source, entryPoint: 'mainVertex' },
                fragment: { source, entryPoint: 'mainFragment' },
            }),
            resources: {
                first: { value: { value: [0, 0, 0, 0], type: 'vec4<f32>' } },
                last: { value: { value: [0, 0, 0, 0], type: 'vec4<f32>' } },
                glOnly: { uOffset: { value: 1, type: 'f32' } },
            }
        });

        expect(Object.keys(shader.groups)).toEqual(['0', '5', '6']);
        expect(shader._uniformBindMap[6]).toEqual({ 0: 'glOnly' });
    });

    it('should keep GL-only resources past the groups a group map names', () =>
    {
        // the group map is the descriptor's, which the typed overloads leave out
        const shader = new Shader({
            glProgram: getGlProgram(),
            groupMap: { 4: { 0: 'mapped' } },
            resources: {
                mapped: { uScale: { value: 2, type: 'f32' } },
                glOnly: { uOffset: { value: 1, type: 'f32' } },
            }
        } as ShaderWithResources);

        expect(Object.keys(shader.groups)).toEqual(['4', '5']);
        expect(shader._uniformBindMap[4]).toEqual({ 0: 'mapped' });
        expect(shader._uniformBindMap[5]).toEqual({ 0: 'glOnly' });
        expect(shader.resources.mapped.uniforms.uScale).toBe(2);
        expect(shader.resources.glOnly.uniforms.uOffset).toBe(1);
    });
});
