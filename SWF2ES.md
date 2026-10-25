# The swf2es fork of PixiJS

This fork is the renderer under [swf2es](https://github.com/swf2es/swf2es),
which plays SWF files in the browser. It started from PixiJS **v8.21.0**,
on the `swf2es` branch, and has since merged upstream's `dev` up to
**v8.22.0** and the fixes after it. The `dev` branch
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
   descendant's padding counts in its ancestors' filter areas; the
   filter system binds
   an empty back texture of its own; pass-local filter textures and samplers
   are rebound without change listeners, their resource keys refreshed on
   each bind; a filter region stays on the
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
   `RenderGroupSystem.onBuildInstructions` and `canDeferInvisibleGroup`
   (opted-in dirty hidden groups release obsolete instructions and batchers until
   reveal; their owner guarantees no external mask or render-layer consumers);
   `FilterSystem.filterAreaHook`, `measureFilterArea` and `activeBounds`;
   `fastGlobalBoundsHooks.onMask`; `GraphicsOptions.observeContext`;
   `getContextRenderDataOnCpu`, `GlTextureSystem.bindForUpload`,
   `GlBufferSystem.resizeOnNextUpload` and `Container.colorRoot`, which
   keeps every colour, a render group's too, from what a filtered
   container draws, for its filter to apply to the output as Flash does.
   `Container.visibilityRoot` keeps ancestor visibility, renderability and
   culling from externally consumed mask geometry while retaining its transforms;
   swf2es pairs it with `colorRoot` for Flash's masks.
   swf2es's `patches.ts` is gone,
   and so are the overwritten methods and the private-field casts.
3. **Strip what swf2es does not use** (done, by leaving it out of the
   bundle rather than out of this repository). swf2es reaches more of Pixi
   than first thought: it draws device text with Pixi's `Text`, takes the
   pointer through Pixi's event system, and its renderer code has WebGPU
   branches for a browser without WebGL. What it does not reach is
   accessibility, `DOMContainer`, the Assets loaders and spritesheets,
   bitmap and HTML text, tiling, nine-slice and particle containers.

   So nothing is deleted here, and upstream merges stay as they are; `lib/`
   is still the whole library. swf2es's `tools/pixijs.ts` builds the
   bundle its pages load in place of `dist/pixi.mjs`: the plugins of this
   repository's rollup configuration over an entry that exports only the
   names swf2es imports and runs only the inits it needs (events,
   rendering, filters, Graphics, Mesh and Text, and the WebGL renderer, in
   the order Pixi's bundle runs them, so that a renderer's systems and
   pipes keep theirs), tree-shaken under `package.json`'s `sideEffects`.
   The WebGPU and Canvas renderers stay behind `autoDetectRenderer`'s
   `import()`s, in chunks loaded only without WebGL. `unsafe-eval` is a
   second entry beside it, sharing its modules.

   `dist/pixi.mjs` went from 2,210 kB (473 kB gzipped) to 1,350 kB
   (293 kB), and from 861 to 498 kB minified; the renderers' chunks are
   another 149 kB not loaded with WebGL. The player cases draw the same.
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
- batchers that never shrink;
- geometry kept in JS arrays.

Fixes like those are kept in commits of their own, with a test, so that
they can be offered to pixijs/pixijs. The maintainers of swf2es open
those pull requests themselves.

The candidates from step 2, and what to take with them:

- `ea897df18` a Graphics drawn alone keeps its group's build;
  `5bf63284d` `BatchTextureArray.clear`; `2118d1e1f` nested render
  group bounds;
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
- `6c2293cf0` with its test fix `aa07d490c`: the back buffer presented
  in place of what the canvas holds, not blended over it
  (`GlBackBufferSystem`); with a preserved drawing buffer, a frame's
  clear pixels showed the frame before. Stands alone.
- `40e34efcb`: a `TextureSource` resized to the same pixels at another
  resolution now emits `resize`, so the textures over it update their
  frames (the back buffer's was cut off at the old size). That reallocates,
  and so clears, GL render textures, and uploads resource-backed ones
  again. Stands alone.
- The tests several commits add to `src/filters/__tests__/FilterSystem.test.ts`
  conflict with each other, trivially, when a commit is applied alone.

The candidates from step 4, measured in swf2es's bench (memory held after
a full collection, RX 7900 XTX):

- `554cd835b` buffers whose contents live on the GPU alone, grown there
  by a GPU-side copy that keeps the buffer object, and so the vertex
  arrays, valid. Stands alone, but uses WebGL 2 calls without a guard;
  upstream would want one, or a warning.
- `7806b3598` every render group built again for a context given back
  after a loss. Stands alone, and is worth offering by itself: any app
  that keeps no CPU copies needs it.
- `3e156b6bd` a built `GraphicsContext` letting go of its paths' shapes
  (`releasePaths`). In swf2es it took 8.7 MB of a 196 MB heap in a busy
  scene; a drawing built once and then only moved gains most.
- `14bf6458e` with `98a4a5f27` and `1e88a603c`: batches kept on the GPU
  alone in one shared arena (`BatcherPipe.gpuResident`), the rebuild for
  a group that moves to another renderer, and the arena's trim. Array
  buffers went from 170 to 41 MB and from 55 to 7 MB in the two benches,
  frame times the same or better, GPU buffers up 21% in one bench for
  sizing at 1.5×. It changes how batching owns its memory, so upstream it
  is a design discussion rather than a plain pull request.

`10980f636` (`Container.colorRoot`) is swf2es's own: Flash applies a
filtered object's colour to its filters' output. So is the global
`uWorldOffset` uniform: swf2es's advanced text places its glyphs on the
stage's pixel grid, inside a filter's input too.

## Merged from upstream

v8.22.0 and the fixes after it (pixijs/pixijs `dev` at `65552017d`) came in
by a merge. Upstream had fixed some of what this fork had too, and its fixes
were taken in place of ours:

- `87589b246`, a filter's resolution found after a resize destroyed a
  pooled texture: upstream's #12257 and #12259 find the enclosing filter
  only as a filter is applied, while its input is held, and pass
  textures are unbound from the filter system's bind group before the
  pool destroys them.
- The guard `6d8a811ac` added to `BindGroup.onResourceChange`, for a group
  destroyed by an earlier listener of the same change: upstream's #12288
  has it.
- The check in `GpuEncoderSystem` that skipped groups parked past a
  program's layout (`49798b715`): upstream's #12229 loops over the layout.

What stays this fork's in the merged files: the filter output reuse in
`FilterSystem.push`, deferred resolves while filters are set up and
applied, the empty back texture of the filter system's own (now also
bound when the pool evicts pass textures), the texel snap of a filter
region, and the samples of each multisampled target (`msaaSamples`,
`backBufferSamples`), which upstream's depth renderbuffer of a matching
format now takes too.

## Working on the fork

- `swf2es` only moves forward; it is never rebased, since swf2es pins
  commits of it. Bringing in
  a newer upstream release is a deliberate merge, checked against
  swf2es's player cases like any other step.
- Commit messages explain why. They carry no attribution trailers, as in
  swf2es.
- A change that affects drawing names the swf2es player case or
  measurement that shows it.


Worker-host input can pin `EventSystem.rootTarget` independently of the last
rendered object. A synchronous BitmapData draw on the main renderer must not
redirect the stage's pointer events while a worker renders the visible stage.
The default null retains Pixi's last-rendered-object routing.

`GraphicsContext.fillGeometry` accepts finished, immutable triangle buffers from a
caller-owned tessellator. It uses the existing paint UV generation and batch,
mask and filter pipeline. The buffers remain available after path retirement,
unload and context restoration; clones borrow the same buffers. Canvas and SVG
expand paths lazily. Tessellator selection, fill rules, memory limits and
fallback caching stay with the caller. swf2es's opt-in native fill run passes all
330 existing Flash reference cases; its default remains the JS path.
