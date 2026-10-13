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
