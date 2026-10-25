import { extensions, ExtensionType } from '../../../../extensions/Extensions';
import { Matrix } from '../../../../maths/matrix/Matrix';
import { Rectangle } from '../../../../maths/shapes/Rectangle';
import { buildSimpleUvs, buildUvs, getZeroUvs } from '../../../../rendering/renderers/shared/geometry/utils/buildUvs';
import { transformVertices } from '../../../../rendering/renderers/shared/geometry/utils/transformVertices';
import { Texture } from '../../../../rendering/renderers/shared/texture/Texture';
import { BigPool } from '../../../../utils/pool/PoolGroup';
import { BatchableGraphics } from '../BatchableGraphics';
import { buildCircle, buildEllipse, buildRoundedRectangle } from '../buildCommands/buildCircle';
import { buildLine } from '../buildCommands/buildLine';
import { buildPixelLine } from '../buildCommands/buildPixelLine';
import { buildPolygon } from '../buildCommands/buildPolygon';
import { buildRectangle } from '../buildCommands/buildRectangle';
import { buildTriangle } from '../buildCommands/buildTriangle';
import { generateTextureMatrix as generateTextureFillMatrix } from './generateTextureFillMatrix';
import { triangulateWithHoles } from './triangulateWithHoles';

import type { Polygon } from '../../../../maths/shapes/Polygon';
import type { Topology } from '../../../../rendering/renderers/shared/geometry/const';
import type { ShapeBuildCommand } from '../buildCommands/ShapeBuildCommand';
import type { ConvertedFillStyle, ConvertedStrokeStyle } from '../FillTypes';
import type { GeometryInstruction, GraphicsContext, TextureInstruction } from '../GraphicsContext';
import type { GpuGraphicsContext, GraphicsGeometryData } from '../GraphicsContextSystem';
import type { ShapePath, ShapePrimitiveWithHoles } from '../path/ShapePath';

/**
 * A record of shape builders, keyed by shape type.
 * @category scene
 * @advanced
 */
export const shapeBuilders: Record<string, ShapeBuildCommand> = {};

extensions.handleByMap(ExtensionType.ShapeBuilder, shapeBuilders);
extensions.add(buildRectangle, buildPolygon, buildTriangle, buildCircle, buildEllipse, buildRoundedRectangle);

const tempRect = new Rectangle();
const tempTextureMatrix = new Matrix();

/**
 * @param context
 * @param gpuContext
 * @internal
 */
export function buildContextBatches(context: GraphicsContext, gpuContext: GpuGraphicsContext)
{
    const batches = gpuContext.batches;
    // arrays: a context built before is reset first, which gives a compacted tessellation new ones
    const geometryData = gpuContext.geometryData as { vertices: number[]; uvs: number[]; indices: number[]; };

    // reset them..
    batches.length = 0;
    geometryData.indices.length = 0;
    geometryData.vertices.length = 0;
    geometryData.uvs.length = 0;

    if (buildSharedGeometry(context, gpuContext)) return;

    const zeroStrokeUvs = context.instructions.length > 0 && context.instructions.every((instruction) =>
        instruction.action === 'stroke' && instruction.data.style.texture === Texture.WHITE);

    for (let i = 0; i < context.instructions.length; i++)
    {
        const instruction = context.instructions[i];

        if (instruction.action === 'texture')
        {
            // add a quad!
            addTextureToGeometryData(instruction.data, batches, geometryData);
        }
        else if (instruction.action === 'geometry')
        {
            addFinishedGeometry(instruction.data, batches, geometryData);
        }
        else if (instruction.action === 'fill' || instruction.action === 'stroke')
        {
            const isStroke = instruction.action === 'stroke';

            // build path collection of polys and shapes points..
            const shapePath = instruction.data.path.shapePath;

            const style = instruction.data.style;

            const hole = instruction.data.hole;

            if (isStroke && hole)
            {
                addShapePathToGeometryData(hole.shapePath, style, true, batches, geometryData, zeroStrokeUvs);
            }

            if (hole)
            {
                // add the holes to the last shape primitive
                shapePath.shapePrimitives[shapePath.shapePrimitives.length - 1].holes = hole.shapePath.shapePrimitives;
            }

            addShapePathToGeometryData(shapePath, style, isStroke, batches, geometryData, zeroStrokeUvs);
        }
    }

    if (zeroStrokeUvs)
    {
        // Compaction would discard the temporary array in favour of these same zeros.
        gpuContext.geometryData.uvs = getZeroUvs(geometryData.vertices.length);
    }
}

/** Finished fills can share one immutable position buffer, including contiguous views of a layer. */
function buildSharedGeometry(context: GraphicsContext, gpuContext: GpuGraphicsContext): boolean
{
    let first: Float32Array | Float64Array = null;
    let length = 0;
    let fills = 0;
    let white = true;

    for (const instruction of context.instructions)
    {
        if (instruction.action !== 'geometry' || !instruction.data.transform.isIdentity()) return false;

        const { vertices, indices } = instruction.data.geometry;

        if (indices.length === 0)
        {
            if (vertices.length !== 0) return false;

            continue;
        }

        first ??= vertices;
        if (vertices.constructor !== first.constructor
            || vertices.buffer !== first.buffer
            || vertices.byteOffset !== first.byteOffset + length * first.BYTES_PER_ELEMENT) return false;

        white &&= instruction.data.style.texture === Texture.WHITE;
        length += vertices.length;
        fills++;
    }

    if (!first) return false;

    const data: GraphicsGeometryData = {
        vertices: first instanceof Float64Array
            ? new Float64Array(first.buffer, first.byteOffset, length)
            : new Float32Array(first.buffer, first.byteOffset, length),
        indices: [],
        uvs: white ? getZeroUvs(length) : [],
    };

    gpuContext.geometryData = data;
    let offset = 0;

    for (const instruction of context.instructions)
    {
        const { geometry, style, transform } = (instruction as GeometryInstruction).data;

        if (geometry.indices.length === 0) continue;

        const points = geometry.vertices;
        const count = points.length / 2;
        const indexOffset = fills === 1 ? 0 : data.indices.length;

        if (fills === 1)
        {
            data.indices = geometry.indices;
        }
        else
        {
            for (let i = 0; i < geometry.indices.length; i++)
            {
                (data.indices as number[]).push(offset + geometry.indices[i]);
            }
        }

        if (!white && style.texture !== Texture.WHITE)
        {
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;

            for (let i = 0; i < points.length; i += 2)
            {
                minX = Math.min(minX, points[i]);
                minY = Math.min(minY, points[i + 1]);
                maxX = Math.max(maxX, points[i]);
                maxY = Math.max(maxY, points[i + 1]);
            }

            tempRect.set(minX, minY, maxX - minX, maxY - minY);
            const matrix = generateTextureFillMatrix(tempTextureMatrix, style, tempRect, transform);

            buildUvs(data.vertices, 2, offset, data.uvs as number[], offset, 2, count, matrix);
        }
        else if (!white)
        {
            buildSimpleUvs(data.uvs as number[], offset, 2, count);
        }

        appendBatch(gpuContext.batches, data, indexOffset, offset, style.texture,
            style.color, style.alpha, 'triangle-list', offset + count);
        offset += count;
    }

    return true;
}

function addFinishedGeometry(
    data: GeometryInstruction['data'],
    batches: BatchableGraphics[],
    geometryData: { vertices: number[]; uvs: number[]; indices: number[]; }
): void
{
    const { geometry, transform, style } = data;
    if (geometry.indices.length === 0) return;

    const { vertices, indices, uvs } = geometryData;
    const vertOffset = vertices.length / 2;
    const indexOffset = indices.length;
    const points = geometry.vertices;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < points.length; i += 2)
    {
        const x = points[i];
        const y = points[i + 1];

        vertices.push(transform.a * x + transform.c * y + transform.tx,
            transform.b * x + transform.d * y + transform.ty);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }
    for (let i = 0; i < geometry.indices.length; i++)
    {
        indices.push(vertOffset + geometry.indices[i]);
    }

    const count = points.length / 2;
    const uvOffset = uvs.length / 2;
    const texture = style.texture;

    if (texture !== Texture.WHITE)
    {
        tempRect.set(minX, minY, maxX - minX, maxY - minY);
        const matrix = generateTextureFillMatrix(tempTextureMatrix, style, tempRect, transform);

        buildUvs(vertices, 2, vertOffset, uvs, uvOffset, 2, count, matrix);
    }
    else
    {
        buildSimpleUvs(uvs, uvOffset, 2, count);
    }

    appendBatch(batches, geometryData, indexOffset, vertOffset, texture, style.color, style.alpha, 'triangle-list');
}

function addTextureToGeometryData(
    data: TextureInstruction['data'],
    batches: BatchableGraphics[],
    geometryData: {
        vertices: number[];
        uvs: number[];
        indices: number[];
    }
)
{
    const points: number[] = [];

    const build = shapeBuilders.rectangle;

    const rect = tempRect;

    rect.x = data.dx;
    rect.y = data.dy;
    rect.width = data.dw;
    rect.height = data.dh;

    const matrix = data.transform;

    // TODO - this can be cached...
    if (!build.build(rect, points))
    {
        return;
    }

    const { vertices, uvs, indices } = geometryData;

    const indexOffset = indices.length;
    const vertOffset = vertices.length / 2;

    if (matrix)
    {
        transformVertices(points, matrix);
    }

    build.triangulate(points, vertices, 2, vertOffset, indices, indexOffset);

    const texture = data.image;
    const textureUvs = texture.uvs;

    uvs.push(
        textureUvs.x0, textureUvs.y0,
        textureUvs.x1, textureUvs.y1,
        textureUvs.x3, textureUvs.y3,
        textureUvs.x2, textureUvs.y2,
    );

    appendBatch(batches, geometryData, indexOffset, vertOffset, texture, data.style, data.alpha, 'triangle-list');
}

/**
 * Adjacent primitives of identical paint share a record, in their original triangle order. Dense
 * vector fills can have hundreds of thousands of primitives, each of which otherwise gets a batch
 * record and, when batched by a Graphics, another copy of that record.
 * @param batches - The context's batches.
 * @param geometryData - The geometry just appended to.
 * @param indexOffset - The first appended index.
 * @param vertOffset - The first appended vertex.
 * @param texture - The primitive's texture.
 * @param color - The primitive's colour.
 * @param alpha - The primitive's alpha.
 * @param topology - The primitive's topology.
 * @param vertexEnd - The end of the appended span, when later fills already share the position buffer.
 */
function appendBatch(
    batches: BatchableGraphics[],
    geometryData: GraphicsGeometryData,
    indexOffset: number,
    vertOffset: number,
    texture: Texture,
    color: number,
    alpha: number,
    topology: Topology,
    vertexEnd = geometryData.vertices.length / 2,
): void
{
    const previous = batches[batches.length - 1];

    if (previous
        && previous.geometryData === geometryData
        && previous.texture === texture
        && previous.baseColor === color
        && previous.alpha === alpha
        && previous.topology === topology
        && previous.indexOffset + previous.indexSize === indexOffset
        && previous.attributeOffset + previous.attributeSize === vertOffset)
    {
        previous.indexSize = geometryData.indices.length - previous.indexOffset;
        previous.attributeSize = vertexEnd - previous.attributeOffset;

        return;
    }

    const batch = BigPool.get(BatchableGraphics);

    batch.indexOffset = indexOffset;
    batch.indexSize = geometryData.indices.length - indexOffset;
    batch.attributeOffset = vertOffset;
    batch.attributeSize = vertexEnd - vertOffset;
    batch.baseColor = color;
    batch.alpha = alpha;
    batch.texture = texture;
    batch.geometryData = geometryData;
    batch.topology = topology;
    batches.push(batch);
}

function addShapePathToGeometryData(
    shapePath: ShapePath,
    style: ConvertedFillStyle | ConvertedStrokeStyle,
    isStroke: boolean,
    batches: BatchableGraphics[],
    geometryData: {
        vertices: number[];
        uvs: number[];
        indices: number[];
    },
    zeroStrokeUvs = false,
)
{
    const { vertices, uvs, indices } = geometryData;

    // indexed loops, not forEach: every shape of every context built comes through here
    const primitives = shapePath.shapePrimitives;

    for (let p = 0; p < primitives.length; p++)
    {
        const { shape, transform: matrix, holes } = primitives[p];
        const points: number[] = [];
        const build = shapeBuilders[shape.type];
        // TODO - this can be cached...
        // TODO - THIS IS DONE TWICE!!!!!!
        // ONCE FOR STROKE AND ONCE FOR FILL
        // move to the ShapePath2D class itself?

        if (!build.build(shape, points))
        {
            continue;
        }

        const indexOffset = indices.length;
        const vertOffset = vertices.length / 2;
        let topology: Topology = 'triangle-list';

        if (matrix)
        {
            transformVertices(points, matrix);
        }

        if (!isStroke)
        {
            if (holes)
            {
                const holeIndices: number[] = [];

                const otherPoints = points.slice();

                const holeArrays = getHoleArrays(holes);

                for (let h = 0; h < holeArrays.length; h++)
                {
                    const holePoints = holeArrays[h];

                    holeIndices.push(otherPoints.length / 2);

                    // appended by index: a spread of a long hole's points is slow, and too many overflow the stack
                    for (let k = 0; k < holePoints.length; k++)
                    {
                        otherPoints.push(holePoints[k]);
                    }
                }

                triangulateWithHoles(otherPoints, holeIndices, vertices, 2, vertOffset, indices, indexOffset);
            }
            else
            {
                build.triangulate(points, vertices, 2, vertOffset, indices, indexOffset);
            }
        }
        else
        {
            const close = (shape as Polygon).closePath ?? true;
            const lineStyle = style as ConvertedStrokeStyle;

            if (!lineStyle.pixelLine)
            {
                buildLine(points, lineStyle, false, close, vertices, indices);
            }
            else
            {
                buildPixelLine(points, close, vertices, indices);
                topology = 'line-list';
            }
        }

        const uvsOffset = uvs.length / 2;

        const texture = style.texture;

        if (texture !== Texture.WHITE)
        {
            const textureMatrix = generateTextureFillMatrix(tempTextureMatrix, style, shape, matrix);

            buildUvs(vertices, 2, vertOffset, uvs, uvsOffset, 2, (vertices.length / 2) - vertOffset, textureMatrix);
        }
        else if (!zeroStrokeUvs)
        {
            buildSimpleUvs(uvs, uvsOffset, 2, (vertices.length / 2) - vertOffset);
        }

        appendBatch(batches, geometryData, indexOffset, vertOffset, texture, style.color, style.alpha, topology);
    }
}

function getHoleArrays(holePrimitives: ShapePrimitiveWithHoles[])
{
    const holeArrays = [];

    for (let k = 0; k < holePrimitives.length; k++)
    {
        const holePrimitive = holePrimitives[k].shape;

        // TODO - need to transform the points via there transform here..
        const holePoints: number[] = [];

        const holeBuilder = shapeBuilders[holePrimitive.type] as ShapeBuildCommand;

        if (holeBuilder.build(holePrimitive, holePoints))
        {
            holeArrays.push(holePoints);
        }
    }

    return holeArrays;
}
