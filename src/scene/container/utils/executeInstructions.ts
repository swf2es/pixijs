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

    for (let i = 0; i < instructionSet.instructionSize; i++)
    {
        const instruction = instructions[i];
        const pipe = renderer[instruction.renderPipeId as keyof RenderPipes] as InstructionPipe<any>;
        const next = (pipe.execute as (instruction: unknown, set: unknown) => number | void)
            .call(pipe, instruction, instructionSet);

        // a filter that reused its kept output: on from its pop, past the object it did not draw
        if (typeof next === 'number') i = next - 1;
    }
}
