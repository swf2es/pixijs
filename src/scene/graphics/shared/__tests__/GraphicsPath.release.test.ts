import { GraphicsContext } from '../GraphicsContext';
import { GraphicsPath } from '../path/GraphicsPath';

import type { Polygon } from '~/maths/shapes/Polygon';

function triangle(): GraphicsPath
{
    return new GraphicsPath().moveTo(0, 0).lineTo(10, 0).lineTo(5, 10)
        .closePath();
}

describe('GraphicsPath.releaseInstructions', () =>
{
    it('should keep its commands until it has been flattened to shapes', () =>
    {
        const path = triangle();

        expect(path.releaseInstructions()).toBe(false);
        expect(path.instructions).toHaveLength(4);
    });

    it('should let go of its commands once flattened, its shapes and bounds the same', () =>
    {
        const path = triangle();
        const bounds = path.bounds.clone();
        const points = [...(path.shapePath.shapePrimitives[0].shape as Polygon).points];

        expect(path.releaseInstructions()).toBe(true);
        expect(path.instructions).toHaveLength(0);
        expect(path.bounds).toEqual(bounds);
        expect((path.shapePath.shapePrimitives[0].shape as Polygon).points).toEqual(points);
    });

    it('should keep the commands of a path changed since it was flattened', () =>
    {
        const path = triangle();

        void path.shapePath;
        path.lineTo(0, 10);

        expect(path.releaseInstructions()).toBe(false);
        expect(path.instructions).toHaveLength(5);
    });
});

describe('GraphicsContext.releasePaths', () =>
{
    it('should let go of its paths\' shapes, its bounds measured first', () =>
    {
        const context = new GraphicsContext()
            .poly([0, 0, 10, 0, 5, 10]).fill(0xff0000)
            .rect(20, 20, 5, 5)
            .stroke({ width: 2, color: 0x00ff00 });
        const bounds = context.bounds.clone();
        const fresh = new GraphicsContext()
            .poly([0, 0, 10, 0, 5, 10]).fill(0xff0000)
            .rect(20, 20, 5, 5)
            .stroke({ width: 2, color: 0x00ff00 });

        context.releasePaths();

        for (const instruction of context.instructions)
        {
            if (instruction.action === 'texture') continue;

            expect(instruction.data.path.instructions).toHaveLength(0);
            expect(instruction.data.path.shapePath.shapePrimitives).toHaveLength(0);
        }

        expect(context.bounds).toEqual(bounds);
        expect(context.bounds.rectangle).toEqual(fresh.bounds.rectangle);
    });
});
