import type { InstructionPipe } from '../../../rendering/renderers/shared/instructions/RenderPipe';
import type { RenderPipes } from '../../../rendering/renderers/types';
import type { RenderGroup } from '../RenderGroup';

/**
 * @param renderGroup
 * @param renderer
 * @internal
 */
export function executeInstructions(renderGroup: RenderGroup, renderer: RenderPipes)
{
    const instructionSet = renderGroup.instructionSet;
    const instructions = instructionSet.instructions;
    const filter = renderer.filter;

    for (let i = 0; i < instructionSet.instructionSize; i++)
    {
        const instruction = instructions[i];

        // kept filter outputs gathered from the pops before it are drawn before anything else is
        if (instruction.renderPipeId !== 'filter') filter?.flush();

        const pipe = renderer[instruction.renderPipeId as keyof RenderPipes] as InstructionPipe<any>;
        const next = (pipe.execute as (instruction: unknown, set: unknown) => number | void)
            .call(pipe, instruction, instructionSet);

        // a filter that reused its kept output: on from its pop, past the object it did not draw
        if (typeof next === 'number') i = next - 1;
    }

    filter?.flush();
}
