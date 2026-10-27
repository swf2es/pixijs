import { ExtensionType } from '../extensions/Extensions';

import type { InstructionSet } from '../rendering/renderers/shared/instructions/InstructionSet';
import type { InstructionPipe } from '../rendering/renderers/shared/instructions/RenderPipe';
import type { Renderer } from '../rendering/renderers/types';
import type { Container } from '../scene/container/Container';
import type { Effect } from '../scene/container/Effect';
import { type FilterInstruction, FilterSystem } from './FilterSystem';

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
    /** The pushes whose pops are still to be added, as instructions are built, and their indices. */
    private readonly _open: { instruction: FilterInstruction; set: InstructionSet; index: number }[] = [];

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

        this._open.push({ instruction, set: instructionSet, index: instructionSet.instructionSize });
        instructionSet.add(instruction);
    }

    public pop(_filterEffect: Effect, _container: Container, instructionSet: InstructionSet): void
    {
        this._renderer.renderPipes.batch.break(instructionSet);

        const open = this._open.pop();
        const same = open?.set === instructionSet;

        if (open)
        {
            open.instruction.popIndex = same ? instructionSet.instructionSize : undefined;
            open.instruction.plain = same && this._plain(instructionSet, open.index + 1);
            open.instruction.redrawing = false;
        }

        instructionSet.add({
            renderPipeId: 'filter',
            action: 'popFilter',
            canBundle: false,
            pushIndex: same ? open.index : undefined,
        } as FilterInstruction);
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
            const pushIndex = instruction.pushIndex;
            const push = pushIndex === undefined
                ? undefined
                : instructionSet?.instructions[pushIndex] as FilterInstruction;

            // the end of its object drawn again: the filter was popped the first time
            if (push?.redrawing)
            {
                push.redrawing = false;

                return undefined;
            }

            // its object drawn again over the filter's output, from the instruction after its push
            if (this._renderer.filter.pop() && push?.plain)
            {
                push.redrawing = true;

                return pushIndex + 1;
            }
        }

        return undefined;
    }

    /** Whether all from `from` to the end of `instructionSet` is drawn by FilterSystem.redrawablePipes. */
    private _plain(instructionSet: InstructionSet, from: number): boolean
    {
        const instructions = instructionSet.instructions;

        for (let i = from; i < instructionSet.instructionSize; i++)
        {
            if (!FilterSystem.redrawablePipes.has(instructions[i].renderPipeId)) return false;
        }

        return true;
    }

    public destroy(): void
    {
        this._renderer = null;
    }
}
