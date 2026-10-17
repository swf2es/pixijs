import { ExtensionType } from '../extensions/Extensions';

import type { InstructionSet } from '../rendering/renderers/shared/instructions/InstructionSet';
import type { InstructionPipe } from '../rendering/renderers/shared/instructions/RenderPipe';
import type { Renderer } from '../rendering/renderers/types';
import type { Container } from '../scene/container/Container';
import type { Effect } from '../scene/container/Effect';
import type { FilterInstruction } from './FilterSystem';

/** @internal */
export class FilterPipe implements InstructionPipe<FilterInstruction>
{
    public static extension = {
        type: [
            ExtensionType.WebGLPipes,
            ExtensionType.WebGPUPipes,
            ExtensionType.CanvasPipes,
        ],
        name: 'filter',
    } as const;

    private _renderer: Renderer;
    /** The pushes whose pops are still to be added, as instructions are built. */
    private readonly _open: { instruction: FilterInstruction; set: InstructionSet }[] = [];

    constructor(renderer: Renderer)
    {
        this._renderer = renderer;
    }

    public push(filterEffect: Effect, container: Container, instructionSet: InstructionSet): void
    {
        const renderPipes = this._renderer.renderPipes;

        renderPipes.batch.break(instructionSet);

        const instruction = {
            renderPipeId: 'filter',
            canBundle: false,
            action: 'pushFilter',
            container,
            filterEffect,
            popIndex: undefined,
        } as FilterInstruction;

        instructionSet.add(instruction);
        this._open.push({ instruction, set: instructionSet });
    }

    public pop(_filterEffect: Effect, _container: Container, instructionSet: InstructionSet): void
    {
        this._renderer.renderPipes.batch.break(instructionSet);

        const open = this._open.pop();

        if (open)
        {
            open.instruction.popIndex = open.set === instructionSet ? instructionSet.instructionSize : undefined;
        }

        instructionSet.add({
            renderPipeId: 'filter',
            action: 'popFilter',
            canBundle: false,
        });
    }

    /**
     * Pushes or pops a filter. A push that reuses its filter's kept output returns the index of its
     * matching pop, for the caller to go on from (executeInstructions): what lies between, the
     * object's drawing, is not needed.
     * @param instruction - The instruction.
     * @param instructionSet - The set it is in, by which its pop is checked.
     */
    public execute(instruction: FilterInstruction, instructionSet?: InstructionSet): number | undefined
    {
        if (instruction.action === 'pushFilter')
        {
            const popIndex = instruction.popIndex;
            const pop = popIndex === undefined ? undefined : instructionSet?.instructions[popIndex] as FilterInstruction;
            const mayReuse = pop?.renderPipeId === 'filter' && pop.action === 'popFilter';

            return this._renderer.filter.push(instruction, mayReuse) ? popIndex : undefined;
        }

        if (instruction.action === 'popFilter')
        {
            this._renderer.filter.pop();
        }

        return undefined;
    }

    public destroy(): void
    {
        this._renderer = null;
    }
}
