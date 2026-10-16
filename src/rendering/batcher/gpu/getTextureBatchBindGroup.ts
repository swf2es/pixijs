import { BindGroup } from '../../renderers/gpu/shader/BindGroup';
import { Texture } from '../../renderers/shared/texture/Texture';

import type { TextureSource } from '../../renderers/shared/texture/sources/TextureSource';

const cachedGroups: Record<number, BindGroup> = {};

/**
 * The cache keys of the groups each source is in. A destroyed source takes its
 * groups out of the cache and destroys them: they could never be drawn with again,
 * and each would otherwise warn that the source was destroyed while bound and keep
 * the source's shell for good.
 */
const groupsOfSource = new WeakMap<TextureSource, number[]>();

function onSourceChange(source: TextureSource): void
{
    if (!source.destroyed) return;

    const keys = groupsOfSource.get(source);

    groupsOfSource.delete(source);
    source.off('change', onSourceChange);

    for (let i = 0; i < keys.length; i++)
    {
        const bindGroup = cachedGroups[keys[i]];

        if (!bindGroup) continue;

        delete cachedGroups[keys[i]];
        bindGroup.destroy();
    }
}

/**
 * @param textures
 * @param size
 * @param maxTextures
 * @internal
 */
export function getTextureBatchBindGroup(textures: TextureSource[], size: number, maxTextures: number)
{
    let uid = 2166136261; // FNV-1a 32-bit offset basis

    for (let i = 0; i < size; i++)
    {
        uid ^= textures[i].uid;
        uid = Math.imul(uid, 16777619);
        uid >>>= 0;
    }

    return cachedGroups[uid] || generateTextureBatchBindGroup(textures, size, uid, maxTextures);
}

function generateTextureBatchBindGroup(textures: TextureSource[], size: number, key: number, maxTextures: number): BindGroup
{
    const bindGroupResources: Record<string, any> = {};

    let bindIndex = 0;

    for (let i = 0; i < maxTextures; i++)
    {
        const texture = i < size ? textures[i] : Texture.EMPTY.source;

        bindGroupResources[bindIndex++] = texture.source;
        bindGroupResources[bindIndex++] = texture.style;

        if (i >= size) continue;

        // Listened to before the group is made, so the cache hears of a destroy before any group does.
        const keys = groupsOfSource.get(texture);

        if (keys)
        {
            keys.push(key);
        }
        else
        {
            groupsOfSource.set(texture, [key]);
            texture.on('change', onSourceChange);
        }
    }

    // pad out with empty textures
    const bindGroup = new BindGroup(bindGroupResources);

    cachedGroups[key] = bindGroup;

    return bindGroup;
}

