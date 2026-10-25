import { Point } from '../../../../maths/point/Point';
import { GraphicsPath } from '../path/GraphicsPath';

import type { Matrix } from '../../../../maths/matrix/Matrix';
import type { PointData } from '../../../../maths/point/PointData';
import type { Bounds } from '../../../container/bounds/Bounds';
import type { FillGeometry } from '../GraphicsContext';

const point = new Point();

/** @internal */
export function validateGeometry({ vertices, indices }: FillGeometry): void
{
    if (vertices.length % 2 || indices.length % 3) throw new RangeError('Invalid fill geometry length');

    for (let i = 0; i < vertices.length; i++)
    {
        if (!Number.isFinite(vertices[i])) throw new RangeError('Invalid fill geometry coordinate');
    }
    for (let i = 0; i < indices.length; i++)
    {
        if (indices[i] >= vertices.length / 2) throw new RangeError('Invalid fill geometry index');
    }
}

/** @internal */
export function geometryBounds(geometry: FillGeometry, matrix: Matrix, bounds: Bounds): void
{
    const { vertices, indices } = geometry;

    if (indices.length === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < indices.length; i++)
    {
        const at = indices[i] * 2;
        const x = vertices[at];
        const y = vertices[at + 1];
        const tx = matrix.a * x + matrix.c * y + matrix.tx;
        const ty = matrix.b * x + matrix.d * y + matrix.ty;

        minX = Math.min(minX, tx);
        minY = Math.min(minY, ty);
        maxX = Math.max(maxX, tx);
        maxY = Math.max(maxY, ty);
    }

    bounds.addFrame(minX, minY, maxX, maxY);
}

/** @internal */
export function geometryContains(geometry: FillGeometry, matrix: Matrix, p: PointData): boolean
{
    if (matrix.a * matrix.d - matrix.b * matrix.c === 0) return false;

    matrix.applyInverse(p, point);
    const { vertices: v, indices } = geometry;
    const x = point.x;
    const y = point.y;

    for (let i = 0; i < indices.length; i += 3)
    {
        const a = indices[i] * 2;
        const b = indices[i + 1] * 2;
        const c = indices[i + 2] * 2;
        const area = (v[b] - v[a]) * (v[c + 1] - v[a + 1]) - (v[b + 1] - v[a + 1]) * (v[c] - v[a]);

        if (area === 0) continue;

        const ab = (v[b] - v[a]) * (y - v[a + 1]) - (v[b + 1] - v[a + 1]) * (x - v[a]);
        const bc = (v[c] - v[b]) * (y - v[b + 1]) - (v[c + 1] - v[b + 1]) * (x - v[b]);
        const ca = (v[a] - v[c]) * (y - v[c + 1]) - (v[a + 1] - v[c + 1]) * (x - v[c]);

        if ((ab >= 0 && bc >= 0 && ca >= 0) || (ab <= 0 && bc <= 0 && ca <= 0)) return true;
    }

    return false;
}

/** @internal */
export function geometryPath({ vertices, indices }: FillGeometry, matrix: Matrix): GraphicsPath
{
    const path = new GraphicsPath();

    for (let i = 0; i < indices.length; i += 3)
    {
        const a = indices[i] * 2;
        const b = indices[i + 1] * 2;
        const c = indices[i + 2] * 2;

        path.poly([vertices[a], vertices[a + 1], vertices[b], vertices[b + 1], vertices[c], vertices[c + 1]], true, matrix);
    }

    return path;
}
