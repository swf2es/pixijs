# The swf2es fork of PixiJS

This fork is the renderer under [swf2es](https://github.com/swf2es/swf2es),
which plays SWF files in the browser. It starts from PixiJS **v8.21.0**,
the version swf2es pins today, on the `swf2es` branch. The `dev` branch
mirrors upstream and is where fixes meant for
[pixijs/pixijs](https://github.com/pixijs/pixijs) are prepared.

PixiJS is MIT-licensed; its `LICENSE` stays as it is, and so do the
notices in its files.

## Why a fork

swf2es must draw what Flash Player draws, and does so at a scale Pixi is
not usually asked for: crowded scenes with ten thousand display objects,
hundreds of filters and thousands of shapes that animate every frame.
To get there swf2es patches Pixi's internals at run time
(`packages/player/src/render/patches.ts` and parts of `blend.ts`,
`color.ts` and `table.ts`), and those patches depend on private fields
and the order of Pixi's shader sections. Each new memory or speed fix
added more of them. In a fork the same changes are ordinary edits.

What measurements showed (October 2026), and what the fork is meant to fix:

- **Memory held after a full collection, about 1.45 GB in a crowded scene:**
  - about 370 MB of vertex data Pixi keeps on the CPU after uploading it;
  - render-pipe batchers that only ever grow: about 187 MB held, 34 MB in use;
  - tessellated geometry kept as plain JS arrays (about 131 MB), plus
    the source paths of shapes long since tessellated (about 170 MB).
- **Allocation, a sawtooth of garbage collections:** geometry rebuilt into
  new arrays, and filter passes creating listeners, textures and shaders.
- **GPU work:** about 4,700 draw calls and 4,400 framebuffer binds a frame
  on a busy benchmark, many from the filter pipeline. Examples are a
  blend-mode filter where plain GL blending would do, and passes that run
  for empty content.

## Plan

Each step is its own set of commits on `swf2es`. swf2es checks every
step against its 150+ player cases, whose references were drawn in
Adobe's Flash Player; a step that changes a drawn pixel is not taken.

1. **Use the fork unchanged.** swf2es takes this repository as a git
   submodule pinned to `swf2es` and builds it as a workspace package in
   place of the npm `pixi.js` 8.21.0. All swf2es tests must pass with no
   change in output.
2. **Fold the run-time patches into the source** (done). What was
   Pixi's own behaviour is now changed here, each in a commit of its own
   with a test: a Graphics drawn alone no longer rebuilds its render
   group; `BatchTextureArray.clear` deletes; a nested filtered render
   group's fast bounds are placed in its parent's; a filtered
   descendant's padding counts in its ancestors' filter areas;
   `_findFilterResolution` survives a resize; the filter system binds
   an empty back texture of its own; a filter region stays on the
   texels; `copyToTexture` is held to its texture and source;
   `getBackTexture` rounds; multisampled targets resolve only where and
   when read; tessellations kept as typed arrays; packed arrays of
   contexts drawn alone let go of once uploaded; batchers and pools cut
   back (`BatcherPipe.trim`, `Pool.trim`).

   What is swf2es's policy stays in swf2es and runs through extension
   points added here, which `render/hooks.ts` sets there:
   `GraphicsPipe.aloneDrawer` and `shaderFor`;
   `BatcherPipe.batcherNameFor`, `batchersFor` and `takeBatchers`;
   `GraphicsContextSystem.onContextBuilt`, `GpuGraphicsContext.onReset`
   and `GraphicsPath.releaseInstructions`;
   `RenderGroupSystem.onBuildInstructions`;
   `FilterSystem.filterAreaHook`, `measureFilterArea` and `activeBounds`;
   `fastGlobalBoundsHooks.onMask`; `GraphicsOptions.observeContext`;
   `getContextRenderDataOnCpu`, `GlTextureSystem.bindForUpload` and
   `GlBufferSystem.resizeOnNextUpload`. swf2es's `patches.ts` is gone,
   and so are the overwritten methods and the private-field casts.
3. **Strip what swf2es does not use.** Likely candidates are the WebGPU
   renderer, Pixi's text, its event system, accessibility and perhaps
   the Canvas renderer. Each one goes only after checking that nothing in
   swf2es reaches it. The aim is a smaller bundle and less code to keep
   correct.
4. **Memory, the arena way** (done but for the tessellations):
   - one arena for batch vertices and indices instead of a growing
     batcher per instruction set (`BatcherPipe.gpuResident`,
     `BatchArena`): batchers pack into buffers lent for each build,
     shared by every render group, grown to the largest and cut back by
     `BatcherPipe.trim` once builds long use little of them, and what they
     pack goes to the GPU, which alone keeps it; elements updated in place
     are packed apart and written in runs. Not reset each frame: a group
     not rebuilt draws what it packed before, as it did;
   - retained geometry in shared buffers with no CPU copy after upload:
     `GlBufferSystem.resizeOnGpu`, `writeOnGpu` and `sizeOnGpu` keep a
     buffer's contents on the GPU alone, written in ranges and grown by
     the GPU's own copy. swf2es's transform table keeps its atlas, every
     drawn-alone context's vertices at an offset and length, that way.
     Each context's tessellation stays on the CPU, in typed arrays: it is
     what batched copies are packed from, and what the atlas and a
     context drawn alone are packed again from;
   - paths let go of once tessellated (`GraphicsContext.releasePaths`),
     for contexts kept from collection whose owner can make them again;
     swf2es's bounds and hit tests read its own shape data, not Pixi's;
   - context loss handled by rebuilding: every render group is built
     again for a restored context (`RenderGroupSystem`), so batches are
     packed anew from the scene, not from kept copies; and for a renderer
     it moves to, where either renderer keeps its batches on the GPU.

   Measured in swf2es's `bench.ts`, after a full collection: `--town 200`
   held 170 MB of array buffers and 196 MB of JS heap, now 41 and 187;
   `--branches 64` 55 MB of array buffers, now 7. Frame times are the
   same, or shorter where groups batch (`--branches 64`, 5.0 to 4.4 ms).
   Not done: sub-allocating the tessellations in shared buffers, which
   would save their typed arrays' headers, some 5 MB in `--town 200`.
5. **The filter pipeline:**
   - no pass for empty content;
   - plain GL blending for additive and similar modes over an opaque
     backdrop, checked against Flash first (done for add, subtract,
     multiply and screen: swf2es chooses them, and `subtract` maps to
     WebGL's reverse subtraction here);
   - a filter's output reused when its content only moved;
   - filter objects, listeners and textures pooled rather than rebuilt.
6. **Then whatever the profiles show next.** By this point much of the
   drawing path will be swf2es's own. The fork is the way there one piece
   at a time, each checked against Flash, rather than one large switch to
   a new renderer.

## Upstream

Some of these are plain Pixi bugs or costs that any user would meet:

- the render-group bounds placement;
- the null `_findFilterResolution` after a resize;
- batchers that never shrink;
- geometry kept in JS arrays.

Fixes like those are kept in commits of their own, with a test, so that
they can be offered to pixijs/pixijs. The maintainers of swf2es open
those pull requests themselves.

The candidates from step 2, and what to take with them:

- `ea897df18` a Graphics drawn alone keeps its group's build;
  `5bf63284d` `BatchTextureArray.clear`; `87589b246`
  `_findFilterResolution`; `2118d1e1f` nested render group bounds;
  `077e25003` the filter system's own empty back texture;
  `5f4a9436f` `copyToTexture`'s clamp; `3da417e92` batcher trim;
  `36cf27b76` `Pool.trim`. Each stands alone.
- `1712961d9` (`getBackTexture` rounding) goes with `67101e417`
  (the region on the texels): each fixes half of the same drift.
- `36456dae8` (typed tessellations) goes with `63648551c`, which adds the
  import its test needs when run alone; `ecee5cb81` (packed arrays let
  go of) goes after both.
- `2d2f3a656` (a filtered child's padding in an ancestor's filter area)
  goes only with `65bdc2ded`, which keeps it to the filter system's
  measure; on its own it changes every filtered container's bounds.
  The behaviour is Flash Player's layer, so offer it as an option, if
  at all.
- `81e1ceadb` (multisampled targets resolved only where and when read)
  is the riskiest: it changes when every WebGL renderer resolves, and
  relies on nothing reading the back buffer before it is presented but
  copies out of it.
- The back buffer presented in place of what the canvas holds, not
  blended over it (`GlBackBufferSystem`): with a preserved drawing
  buffer, a frame's clear pixels showed the frame before. Stands alone.
- The tests several commits add to `src/filters/__tests__/FilterSystem.test.ts`
  conflict with each other, trivially, when a commit is applied alone.

## Working on the fork

- `swf2es` only moves forward; it is never rebased, since swf2es pins
  commits of it. Bringing in
  a newer upstream release is a deliberate merge, checked against
  swf2es's player cases like any other step.
- Commit messages explain why. They carry no attribution trailers, as in
  swf2es.
- A change that affects drawing names the swf2es player case or
  measurement that shows it.
