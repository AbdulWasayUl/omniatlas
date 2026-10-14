# OmniAtlas overhaul plan

> Produced by a nine-agent research workflow (8 recon lenses + architect synthesis) on 2026-10-14.
> This document is the authoritative implementation spec for the overhaul. Where it conflicts with
> `ARCHITECTURE.md`, `RENDERING.md` or `ROADMAP.md`, this document wins until those are rewritten
> in Phase 7.

## Stack verdict

## Verdict: keep the stack, change the architecture

**Decision: React 19 + TypeScript 6 + Vite 8 + Three.js 0.185 + R3F 9 + Zustand 5 + astronomy-engine stays. WebGL2 (`WebGLRenderer`). No renderer swap, no framework swap, no WASM engine.**

Reasoning, one line each:

- **Keep React/R3F.** Space Time — the most feature-complete competitor in existence (2.5M stars, 630k DESI galaxies, zero backend) — ships on this exact stack. The gap between OmniAtlas and it is architecture, not technology. Rewriting the stack spends the entire budget on a non-problem.
- **Keep WebGL2, reject WebGPU.** `@react-three/postprocessing` does not run on `WebGPURenderer` at all; `ShaderMaterial`/`onBeforeCompile` are unsupported on both its backends; R3F v10 is alpha; measured adapter acquisition is 73% on Android and 18% on Linux. The one thing WebGPU buys (compute culling) is unnecessary because we precompute octrees offline. Insurance premium instead: all post-processing confined to one file, all custom shaders behind factory functions.
- **Reject Aladin Lite / Stellarium Web Engine / WWT as the engine.** Aladin is 2D sky-plane only (its own README lists HiPS3D as unsupported); Stellarium Web is AGPL-3.0 with a CLA, which is disqualifying for a hosted product. We borrow their *protocols* (HEALPix, HiPS, hips2fits), not their runtimes.
- **Reject CesiumJS** (which `docs/ARCHITECTURE.md` currently proposes for surface descent). A second globe engine means a second camera model, a second coordinate system, a second bundle and a hand-off bug surface. Baked DEM-derived displacement on our own patch mesh covers Earth/Moon/Mars.

### Dependencies added
| Package | Why |
|---|---|
| `@react-three/postprocessing` + `postprocessing` | Bloom + AgX tone mapping in one HDR pass. The single biggest visual win available. |
| `@hscmap/healpix` | NESTED `ang2pix`/`pix2ang`/corners, TypeScript, tested against healpy. Do not port HEALPix by hand. |
| `@fontsource-variable/inter`, `@fontsource-variable/inter-tight`, `@fontsource/dm-mono` | Kills the render-blocking three-hop Google Fonts `@import` on `src/styles/global.css:1`. |
| `minisearch` | Worker-side fuzzy index over names + designations + catalogue IDs. |
| `vitest` + `@vitest/coverage-v8` | There are currently **zero tests**. Precision and unit-conversion claims are untestable without this. |
| `@playwright/test` | Visual regression via URL state; also generates Discover-panel thumbnails in CI. |
| `ktx-parse` + `toktx` (CLI, dev) | KTX2/Basis transcode pipeline. |

### Dependencies removed
| Package | Why |
|---|---|
| `leva` | Verified: zero imports anywhere in `src/`. Dead weight. |
| `@react-three/drei`'s `<Stars>` and `<Html>` usage | Not the package — the two components. `<Stars count={4000}>` is a random point cloud with no catalogue behind it; `<Html>` creates one DOM node per label with a per-frame transform and will not survive 200 labels, let alone 2000. |

`dexie@4.4.5` is currently unused but **stays** — it becomes the IndexedDB tile cache, which is its obvious job.

### Build config decisions
- **`vite.config.ts` COOP/COEP: keep, and add them to production headers too.** The simulation worker *will* use `SharedArrayBuffer`. But the comment is currently a lie (grep finds zero `Worker`/`SharedArrayBuffer`/`OffscreenCanvas` uses) and `require-corp` would silently block any cross-origin asset. Mitigation: **we fetch no third-party assets at runtime.** Everything is baked at build time or mirrored to our own origin. That single rule makes COEP safe and removes the CDN-CORS failure class entirely.
- **`.oxlintrc.json` enables exactly two rules.** Turn on `correctness` + `react-hooks` rule sets. The code carries three `// eslint-disable-next-line react-hooks/exhaustive-deps` comments for a rule that is not even enabled — `CameraRig.tsx:153` omits `goal` and `coarseEphemeris` and that one actually matters.
- **Code splitting.** `dist/` is currently one 1.35 MB chunk. Split: `three`+R3F vendor, UI, and lazily-imported catalogue modules.


## Architecture

## The core idea

**One float64 SI-metre world model. Six render layers, each with its own unit, origin and camera, composited far-to-near with depth clears. React never touches the scene graph.**

This fuses the two things the researchers converged on from different directions: universesimulator's multi-layer renderer (shipping, legible, ~3 KB of core code) and OpenSpace's Dynamic Scene Graph frame rebasing (Axelsson et al., CGF 2017). They are the same mechanism described twice. Implementing it is the single highest-value change in the overhaul, and everything else depends on it.

### Why this is the blocker, verified

`src/astronomy/ephemeris.ts:104` writes absolute heliocentric coordinates into a `THREE.Vector3` via `multiplyScalar(AU_IN_EARTH_RADII)`. In physical mode Neptune lands at **705,536 render units**. Float32's 24-bit mantissa gives ULP = 705536 × 2⁻²³ ≈ **0.084 units ≈ 535 km** there. Triton's entire radius is 1,353 km = 0.212 units — about 2.5 ULPs. At 1 parsec the error is ~10⁹ km. No star layer can be built on top of this, and no amount of patching the existing scene graph fixes it.

### Layer 1 — `src/core/world.ts`: the float64 world

All canonical state is **Float64, SI metres, no exceptions**. Three frames with fixed transform matrices between them, computed once:
- **ICRF/J2000 equatorial** (the frame astronomy-engine and AT-HYG both use)
- **J2000 ecliptic** (obliquity ε = 23.439291111°) — *this does not exist in the codebase today and is why the four notable asteroids are oriented against the Sun's rotation pole, which is wrong by ~7.25°*
- **Galactic** (α_NGP = 192.85948°, δ_NGP = 27.12825°, l_NCP = 122.93192°) and **supergalactic**

```ts
export type Vec3d = { x: number; y: number; z: number }   // always metres
export const AU_M = 1.495978707e11
export const PC_M = 3.0856775814913673e16
export const LY_M = 9.4607304725808e15
export const MPC_M = 3.0856775814913673e22
```

Nothing below `src/ui/` may hold a position in render units. Enforced by lint rule.

### Layer 2 — `src/core/Layer.ts`: a render layer

```ts
interface Layer {
  id: LayerId
  unitMetres: number           // how many metres one render unit is
  originWorld: Vec3d           // float64 world position of this layer's origin
  frame: FrameId               // orientation
  order: number                // render order, far → near
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  defaultFar: number
}
```

Per frame, for each **active** layer:
```
localCam = (cameraWorld − layer.originWorld) / layer.unitMetres      // computed in float64
layer.camera.position.set(localCam)                                   // only now downcast to f32
d = |localCam|
layer.camera.near = max(1e-9, d * 1e-4)                               // ratio capped at 1e4
layer.camera.far  = max(layer.defaultFar, d * 20)
```

The GPU only ever sees small camera-relative floats. This is the floating origin — and because three.js already computes `modelViewMatrix = matrixWorldInverse × matrixWorld` on the CPU in JS float64 and downcasts only the product, **object origins are camera-relative for free**. We write no shader-side floating origin; doing so would lock us out of every stock material.

**The one rule that follows:** *object origins may be huge, vertex buffers may not.* Every `BufferGeometry`'s coordinates stay within ~1e4 of its own object origin. Orbit curves are generated relative to their central-body group. Star tiles each get a tile-origin `<group>`.

### The six layers

| # | id | unit | origin | frame | band (cam distance) | contents |
|---|---|---|---|---|---|---|
| 5 | `cosmic` | 1 Mpc | observer (comoving) | supergalactic | 0.1 – 2e4 Mpc | CF4 groups, 2MRS, UNGC, CMB shell |
| 4 | `galactic` | 1 kpc | Galactic centre | galactic | 0.05 – 1e3 kpc | MW disk field, Reid arms, globulars, masers, LMC/SMC/M31 |
| 3 | `stellar` | 1 pc | Sol | ICRS equatorial | 0.1 – 3e3 pc | AT-HYG star points, exoplanet hosts, constellation lines, OpenNGC |
| 2 | `helio` | 1 AU | SSB | J2000 ecliptic | 1e-6 – 2e5 AU | Sun, planets, dwarfs, belt, comets, orbit curves, heliopause |
| 1 | `system` | 1000 km | active planet barycentre | ICRF equatorial | 0.5 R_body – 3 R_Hill | focused body, rings, its moons, moon orbits |
| 0 | `surface` | 1 km | active body centre | body-fixed (IAU rotating) | 0 – 3 R_body | terrain patches, surface features |

`system` and `surface` are **dynamically re-origined** on focus change with hysteresis: attach at 0.9× the band edge, detach at 1.1×, so a camera parked at a boundary never thrashes.

### Layer 3 — `src/core/Engine.ts`: the frame

```ts
gl.autoClear = false
gl.clear(true, true, true)
for (const layer of activeLayersFarToNear) {
  gl.clearDepth()                  // colour is NOT cleared — layers composite
  gl.render(layer.scene, layer.camera)
}
```

Depth clears are nearly free on tiled and desktop GPUs. With per-layer near/far ratio ≤ 1e4, a plain 24-bit depth buffer gives ~6e-4 relative resolution — ample.

**`logarithmicDepthBuffer: true` at `SceneManager.tsx:20` is deleted.** It writes `gl_FragDepth`, which disables early-Z on every GPU (a measured three.js case went 65 → 35 fps), disables MSAA on some implementations, and solves only half the problem — it does nothing for *position* precision. Multi-pass solves both. We do **not** adopt reverse-Z either: `EXT_clip_control` is absent in Firefox (88.3% coverage), three.js silently falls back to a plain buffer rather than to log depth, and since r185 enabling it inverts `renderOrder` semantics wholesale (three.js #33944) — which `EarthBody` (2/3), `SunBody` (4) and `EarthDetailLayer` (5/6) all depend on. Multi-pass alone is sufficient and has no compatibility surface.

### Layer 4 — modules with failure isolation

`src/components/scene/*.tsx` becomes `src/modules/*/index.ts`. Each module is a plain object, not a React tree:

```ts
interface AtlasModule {
  id: string
  init(engine: Engine): Promise<void>
  update(ctx: FrameContext): void      // phase 1: move objects (float64 → layer-local)
  preRender(ctx: FrameContext): void   // phase 2: camera-dependent LOD, fades, uniforms
  dispose(): void
}
```

Boot loads them by dynamic `import()` inside a `Promise.allSettled`, so a failure in one never stops the others (`engine.failedModules.push(...)`). Each registers objects into `src/core/registry.ts` keyed by id. `?modules=solar,stars` isolates modules for dev and profiling — a huge debugging accelerant.

**The initial view is applied the moment the focus object registers**, not when all modules finish, so the loading overlay never lifts onto a camera parked next to the Sun.

### Layer 5 — simulation worker

`src/workers/simulation.worker.ts` owns the ephemeris. Today `calculateSolarSystemEphemeris` is called **three times per second from three separate components** (`SolarSystemScene.tsx:50`, `CameraRig.tsx:123`, `Interface.tsx:52`) with identical arguments, each allocating ~45 fresh `Vector3`/`Quaternion`, and each triggering a full React reconciliation of the entire R3F tree. Verified: 0.42 ms/tick × 3, plus a 1 Hz whole-tree re-render.

Replacement: the worker holds `Float64Array` position/orientation SoA buffers, propagates on a `SharedArrayBuffer`, and the main thread reads it in **one** `useFrame`, mutating `object3D.position` directly. Zero React state in the hot path. Scalar readouts (distance, view span, FPS) reach the DOM via `store.subscribe` + `useRef` + rAF-throttled text writes — **never** `set()`.

### Layer 6 — state

Three stores plus one non-reactive context, replacing the single flat 78-line `useExplorerStore` that currently mixes `directoryOpen` with `viewScaleKmPerPixel` (written 6.7×/s from `useFrame`):

| Store | Contents | Write frequency |
|---|---|---|
| `useViewStore` | anchor, aim, containmentPath (derived), layers, panels, quality | user actions only |
| `useTimeStore` | epochMs, rateIndex, paused | ≤1 Hz, UI only |
| `useSelectionStore` | selectedId, resolved entity | user actions only |
| `SimContext` (plain object, not a store) | typed arrays, camera state, frame refs | every frame, React never subscribes |

`focusStack: FocusTarget[]` is replaced by **three separate things**, because users ask three different questions: `containmentPath` (derived from the catalogue hierarchy — stable regardless of how you arrived), `history` (the Back button / Location Log), and `anchor`/`aim` split (OpenSpace's distinction: you orbit Earth while watching the Moon).

### Layer 7 — picking

Raycasting does not survive 1M star sprites. Replace `onPointerMissed` + R3F raycasting with a **scissored ID pass**: render a 3×3 pixel box at the cursor into an RGBA8 target with a flat material writing a 32-bit object id packed across RGBA, then `readRenderTargetPixels` on that region. ~0.2 ms, independent of object count, throttled to pointer-move.

### Layer 8 — labels

One 2D `<canvas>` overlay on top of the WebGL canvas, drawn once per frame from projected world positions. `SurfaceLabelField.tsx` already has the right projection + declutter logic and becomes this engine — but its `items.find(entry => entry.id === id)` at line 202 runs inside an unthrottled `useFrame` over 1,493 entries × 90 labels ≈ **134,000 string comparisons per frame**. Fixed by a precomputed `Map<id, index>` built alongside the anchors.


## Target directory structure

```
src/
├── core/                       # The engine. No React, no JSX, no imports from ui/.
│   ├── world.ts                # Vec3d float64 SI metres; AU_M/PC_M/MPC_M; frame transform matrices
│   │                           #   (ICRF↔ecliptic ε=23.439291111°, ↔galactic, ↔supergalactic)
│   ├── Layer.ts                # {unitMetres, originWorld, frame, order, scene, camera}; per-frame rebase
│   ├── Engine.ts               # ordered far→near multi-pass render with depth clears; module lifecycle
│   ├── registry.ts             # id → SceneNode map; resolves pending ?focus= as objects arrive
│   ├── SceneNode.ts            # one composable node type: Renderable + Translation + Rotation + Scale
│   ├── camera/
│   │   ├── AtlasControls.ts    # replaces drei OrbitControls: log zoom, deltaMode normalisation,
│   │   │                       #   zoom-out chain, select-and-scroll retarget, altitude-above-surface
│   │   ├── cameraPath.ts       # van Wijk–Nuij ρ=√2 geodesic flyTo; constant perceived optical flow
│   │   └── framePolicy.ts      # layer attach/detach bands with 0.9/1.1 hysteresis
│   ├── render/
│   │   ├── StarPoints.ts       # InstancedBufferGeometry star tiles; absmag→apparent in vertex shader
│   │   ├── PointCloud.ts       # generic instanced-quad point layer (galaxies, quasars, belt)
│   │   ├── SphereBody.ts       # data-driven body renderable — replaces PlanetBody + MoonBody + MoonMesh
│   │   ├── OrbitCurve.ts       # orbit polyline, vertices local to the central-body group
│   │   ├── TerrainPatch.ts     # displaced quadtree patch for Moon/Mars/Earth surface layer
│   │   ├── VolumeShell.ts      # heliopause, Local Bubble, CMB shell
│   │   └── PostStack.ts        # THE ONLY post-processing file. Bloom + AgX + SMAA. One-file swap later.
│   ├── labels/
│   │   ├── LabelEngine.ts      # single 2D canvas overlay; projection, greedy AABB declutter, tiering
│   │   └── glyphs.ts           # 11 class glyph paths (disc, ring, diamond, teardrop, spiral, …)
│   ├── picking/IdPass.ts       # 3×3 scissored ID buffer read; packs object id across RGBA8
│   ├── streaming/
│   │   ├── TileStreamer.ts     # worker pool (min(hwConcurrency−1, 4)); transferable ArrayBuffers
│   │   ├── UploadScheduler.ts  # ≤2 MB GPU upload per frame, drained across frames
│   │   └── TileCache.ts        # Dexie-backed IndexedDB cache with an explicit size budget
│   ├── textures/KtxLoader.ts   # KTX2Loader + Basis transcoder in a worker; LRU VRAM eviction
│   └── perf/
│       ├── Governor.ts         # degrade order: dpr → bloom res → star maglimit → tile detail
│       └── Stats.ts            # p50/p95 frame ms, draw calls, tris, points, est. VRAM
│
├── astronomy/                  # Pure float64 SI maths. No THREE imports. 100% unit-tested.
│   ├── orbit.ts                # KEPT AS-IS: keplerianPosition + solveEccentricAnomaly
│   ├── ephemeris.ts            # astronomy-engine wrapper → Vec3d metres. No render units, no Map<BodyState>.
│   ├── frames.ts               # IAU2015 rotation elements; correct tidal-lock basis (Z→parent, Y=pole)
│   ├── cosmology.ts            # frozen Planck 2018; distanceModulusToMpc, comovingDistanceMpc, lookbackGyr
│   ├── photometry.ts           # absmag↔appmag, Ballesteros B−V→T_eff, blackbody→linear sRGB LUT
│   └── eclipse.ts              # analytic umbra/penumbra from occluder (centre, radius) pairs
│
├── modules/                    # Content. Each is init/update/preRender/dispose. Failure-isolated.
│   ├── solar/index.ts          # Sun, 8 planets, dwarfs, rings, orbit curves, heliopause
│   ├── bodies/index.ts         # all moons; per-planet `system` layer creation
│   ├── smallbodies/index.ts    # GPU-propagated belt + named asteroids + comets
│   ├── surface/index.ts        # Earth/Moon/Mars terrain patches, coastlines, craters, cities
│   ├── stars/index.ts          # AT-HYG L0/L1/L2 tiers, constellation lines, exoplanet hosts
│   ├── deepsky/index.ts        # OpenNGC, nebula outline polygons, hips2fits cutouts
│   ├── galaxy/index.ts         # MW disk field, Reid arms, Harris globulars, masers, LMC/SMC/M31
│   └── cosmos/index.ts         # UNGC, CF4 groups, 2MRS, zone of avoidance, CMB shell
│
├── data/
│   ├── types.ts                # AtlasEntity + ObjectClass + Provenance + distanceKind
│   ├── assetUrls.ts            # pinned registry: url, sha256, bytes, licence, frame, retrieved
│   ├── provenance.ts           # six-kind taxonomy + badge rendering helpers
│   ├── scaleLadder.ts          # the 14 rungs: id, metres, label, layer, caption, datasets
│   ├── objectClasses.ts        # 11 classes: colour triple + glyph + label tier
│   ├── planets.ts  moons.ts  sun.ts  smallBodies.ts   # KEPT: curated prose, facts, sources
│   ├── surfaceLayers.ts        # body → [{id, title, textureUrl, maxOrder, attribution}]
│   └── catalog.ts              # Map-based lookup, not Array.find
│
├── state/
│   ├── useViewStore.ts  useTimeStore.ts  useSelectionStore.ts
│   ├── SimContext.ts           # plain mutable refs + typed arrays; React never subscribes
│   └── urlState.ts             # throttled replaceState; parse/serialise; = the tour keyframe format
│
├── ui/                         # React chrome ONLY. Must not import from core/render or modules/.
│   ├── AppChrome.tsx           # zone layout: topbar / breadcrumb / inspector / timebar / hud
│   ├── TopBar.tsx  CosmicAddress.tsx  ScaleLadder.tsx
│   ├── CommandPalette.tsx      # ⌘K / Ctrl+K / `/` — replaces DirectoryPanel as primary entry
│   ├── Inspector.tsx           # tabs: Overview / Data / Evidence / Nearby
│   ├── ProvenanceChips.tsx  RelatedChips.tsx  SizeCompare.tsx
│   ├── TimeBar.tsx             # discrete rate ladder, window presets, now tick
│   ├── Hud.tsx                 # distance, view-span, scale bar, nearest-object chip, FPS
│   ├── Discover.tsx            # category chips over thumbnail cards (replaces DirectoryPanel)
│   ├── LoadingScreen.tsx       # phase text + fact card + credit; lifts on focus-object ready
│   ├── A11yMirror.tsx          # visually-hidden button list mirroring visible objects; aria-live
│   └── KeyboardHelp.tsx
│
├── format/units.ts             # formatDistance(m)→{primary, secondary, unit}; lightTravelTime(m)
├── shaders/                    # .glsl; every one reached via a factory, never inline JSX
└── workers/
    ├── simulation.worker.ts    # float64 SoA ephemeris → SharedArrayBuffer
    ├── catalog.worker.ts       # binary tile parse → transferable typed arrays. Never per-star objects.
    └── search.worker.ts        # MiniSearch index

scripts/                        # Build-time ETL. Everything third-party is ingested HERE, never at runtime.
├── build-earth-countries.mjs  build-earth-coastline.mjs  build-earth-places.mjs  build-moon-craters.mjs   # KEPT
├── bake-body-textures.mjs      # hips2fits → equirect JPEG/PNG → KTX2
├── build-textures-ktx2.mjs     # toktx: UASTC for Earth/Moon/Mars base, ETC1S for the rest
├── build-small-bodies.mjs      # JPL SBDB (no CORS → build time only)
├── build-orbit-paths.mjs       # precomputed orbit polylines (Pluto currently costs 60 ms in a React render)
├── build-stars.mjs             # AT-HYG v4.0 → l0.bin / l1.bin / l2/<pix>.bin / names.json
├── build-constellations.mjs    # Stellarium modern_iau HIP sequences → AT-HYG index pairs
├── build-exoplanets.mjs        # NASA Exoplanet Archive TAP → join on gaia_dr3_id
├── build-deepsky.mjs           # OpenNGC v20260501 + 379 nebula outline polygons
├── build-galaxy-field.mjs      # deterministic seeded MW point cloud from Reid+2019 arms
├── build-universe.mjs          # CF4 table3, 2MRS, UNGC
├── build-search-index.mjs      # MiniSearch prefix index → binary
└── check-contrast.mjs          # WCAG relative-luminance gate over the token file; CI-enforced

tests/
├── unit/                       # vitest: precision, units, frames, cosmology, photometry
└── visual/                     # playwright: URL-state screenshots; also generates Discover thumbnails
```

**Three import rules, lint-enforced:**
1. `src/ui/**` may not import from `src/core/render/**` or `src/modules/**`.
2. `src/astronomy/**` may not import `three`, and may not call `Date.now()`.
3. Nothing outside `src/core/Layer.ts` may convert metres to render units.


## Scale ladder

## Two ladders: one the engine uses, one the user sees

### Engine ladder — 6 render layers (see Architecture for the full table)

`cosmic` (1 Mpc) → `galactic` (1 kpc) → `stellar` (1 pc) → `helio` (1 AU) → `system` (1000 km) → `surface` (1 km).

Rendered **far to near**, depth cleared between passes, colour preserved so they composite. Each layer's camera is placed at `(cameraWorld − originWorld) / unitMetres` computed in float64, with `near = max(1e-9, d·1e-4)` and `far = max(defaultFar, d·20)` — a ratio capped at 1e4, which a plain 24-bit depth buffer handles with headroom.

A layer is **active** when the camera distance from its origin falls in its band *or* it holds the current focus. Typically 2–3 layers are active at once; the rest are skipped entirely (zero draw calls). `system` and `surface` are re-origined on focus change with **0.9/1.1 hysteresis** so a camera parked at a boundary never thrashes.

The user is never told any of this exists. Every product that surfaces discrete levels (level-select screens, loading gates between Solar System and Galaxy) feels like several apps stapled together; every product that hides it — Celestia, OpenSpace, Gaia Sky, SpaceEngine — feels like one universe.

### User ladder — 14 rungs, `src/data/scaleLadder.ts`

A persistent 48px left rail, full viewport height, logarithmic. A thumb tracks **view span** — the width of what is currently on screen — not camera distance, because span is what the user actually perceives. Highlighting is `argmin |log(rung.metres) − log(viewSpan)|`.

| # | Rung | View span | Engine layer | What appears | Provenance |
|---|---|---|---|---|---|
| 1 | **SURFACE** | 1e4 m | surface | terrain, coastlines, craters, cities | MEASURED |
| 2 | **BODY** | 2.2e7 m | surface→system | whole globe, atmosphere, rings | MEASURED |
| 3 | **MOON SYSTEM** | 1.1e9 m | system | moons + their orbits, shadow transits | MEASURED |
| 4 | **INNER SYSTEM** | 6.0e11 m | helio | Mercury–Mars, belt inner edge | MEASURED |
| 5 | **OUTER SYSTEM** | 1.3e13 m | helio | all planets, Kuiper belt, Voyagers | MEASURED |
| 6 | **HELIOSPHERE** | 1.5e14 m | helio | heliopause shell (121 AU, Voyager 1 crossing Aug 2012) | MEASURED |
| 7 | **OORT CLOUD** | 3.0e16 m | helio→stellar | labelled shell only — no catalogue of it exists | **ILLUSTRATION** |
| 8 | **NEAREST STARS** | 5.0e17 m | stellar | AT-HYG L0+L1, 10 pc census, Proxima at 4.2465 ly. **Constellations begin to distort here.** | MEASURED |
| 9 | **LOCAL BUBBLE** | 5.0e18 m | stellar | AT-HYG L2, Edenhofer dust, Hyades 47 pc, Pleiades 136 pc, OpenNGC nebulae + outlines | MEASURED |
| 10 | **MILKY WAY** | 1.5e21 m | galactic | disk field, Reid arms, 157 globulars, ~200 masers, GC at 8.178 kpc | MEASURED + **MODEL** |
| 11 | **LOCAL GROUP** | 5.0e22 m | galactic→cosmic | LMC 50 kpc, SMC 62 kpc, M31 0.78 Mpc, UNGC dwarfs | MEASURED |
| 12 | **LOCAL SUPERCLUSTER** | 1.2e24 m | cosmic | UNGC 11 Mpc, Virgo 53.8 Mly, CF4 groups, Laniakea | MEASURED |
| 13 | **COSMIC WEB** | 6.0e25 m | cosmic | CF4 to 772 Mpc + 2MRS all-sky **with the zone of avoidance drawn** | MEASURED |
| 14 | **OBSERVABLE UNIVERSE** | 8.8e26 m | cosmic | Planck CMB shell at 14,300 Mpc comoving, z = 1089 | MEASURED |

Rungs not yet shipped render greyed with *"coming in this release"* — a stronger product statement than hiding them, and it matches the spec's own commitment to exposing coverage rather than implying completeness.

### Transitions

**There are no mode switches and no loading gates.** Three mechanisms carry the camera:

1. **Multiplicative zoom.** Wheel = ×1.15/notch; **Shift+wheel = ×2.0/notch** (Earth surface → cosmic horizon in ~56 notches rather than 379). `WheelEvent.deltaMode` 0/1/2 differ by ~16× between browsers and **must be normalised explicitly** or macOS users get a camera flying 16× faster than Windows users. `zoomToCursor` stays on.
2. **Ladder drag.** The thumb is draggable — this is the real long-haul control, and clicking a rung is a `flyTo`.
3. **`flyTo`.** van Wijk–Nuij geodesic (IEEE InfoVis 2003) with ρ = √2, their user-study-preferred value, keeping perceived optical flow constant. Duration `clamp(900, 420·log10(ratio)+700, 2600)` ms. The current `camera.position.lerp(goal, 1−exp(−delta·4.4))` is a straight world-space line: Earth→Andromeda would be 99.99% motionless black screen followed by everything in 0.2 s.

**Zoom-out chain:** while zooming out, the pivot blends up the focus's containment chain (Tycho → Moon → Earth → Sun → Galactic centre) and the reference 'up' blends body pole → ecliptic → galactic → supergalactic, parallel-transported frame to frame and rolled toward the reference at a bounded 1.5 rad/s so the horizon never flips. Zooming out always frames the next structure up.

**Select-and-scroll retarget:** click a distant object, then scroll *in* — focus hands over without the camera moving, the view turns over ~0.4 s, zoom continues logarithmically to the object's `minDist`. A `chainFloor` suppresses the zoom-out chain below the handover distance so the pivot never jumps.

### The three clamps that must die

`CameraRig.tsx:199-200` sets `maxDistance = focusRadiusUnits * 12`. Verified consequences: focus Earth in physical mode → `radiusUnits = 1`, `maxDistance = 12`, but **the Moon is at 60.4 units — you cannot zoom out far enough to see the Moon from Earth.** Focus Jupiter → `maxDistance = 131.7` while Callisto sits at 295.5. The app renders a moon system the camera is forbidden from framing. And `maxDistance = goal.systemRadius * 8` on the system view is the literal reason you cannot zoom out of the solar system today.

Replacement: **no hard clamps.** Outward is unbounded. Inward is an **asymptotic soft landing** on the nearest surface — a hard clamp produces a dead wheel, which users read as a bug; an asymptote reads as physics. Near a solid body, zoom is in **altitude above surface**, not distance to centre, which is what makes the final approach to a crater feel right.

### What replaces scale compression

**`explorationDistanceForAu`, `explorationRadiusUnits`, `explorationMoonDistance` and the entire `distanceMode` field are deleted.** Not softened into a slider — deleted. Three reasons:

1. **The laws are provably self-inconsistent.** Computed from the actual code: Venus system outer 11.90 > Earth inner 11.70. Jupiter's Callisto reaches 44.58 units while Saturn orbits at 43.34 — **Jupiter's moon system crosses Saturn's orbit.** Saturn's Iapetus reaches 61.27 while Uranus orbits at 61.35 — they touch. The Sun renders at 6.54 units while Mercury orbits at 8.71, a ratio of 1.33 where the true ratio is 83.2. No fixed power law can ever guarantee non-overlap across six orders of magnitude.
2. **The disclosure is a lie.** `Interface.tsx:182` renders *"Body sizes are true to scale · distances between bodies are compressed"* while `constants.ts:37` applies `trueRadiusUnits ** 0.4` — the Sun shows at 6.5 Earth radii instead of 109.2, a **17× understatement**, and the string sits inside a collapsible panel so the distortion can be active with no visible warning.
3. **It poisons the architecture.** A presentation transform means every position has two truths, which is incompatible with a single float64 world model that the universe layers depend on.

Four honest instruments replace it, and together they are strictly more informative:

- **Constant-screen-size marker glyphs.** When a body's true angular size drops below ~2 px, stop drawing the mesh and draw a point sprite plus a hairline ring of **constant 6 px screen radius** in the class colour. Because the ring is visibly UI chrome — unlit, hairline, HUD-coloured — nobody reads it as the planet. A tick inside the ring shows true angular size once it exceeds 0.3 px, so the glyph itself teaches how small the object really is. Crossfade mesh↔glyph over 2–8 px. **Markers yes, meshes never.**
- **"View spans X" readout**, always on. This is the honest replacement for a compression toggle: it tells you the scale instead of distorting it.
- **A local "Compare sizes" tool** in the inspector (NASA Eyes has one) — explicit, bounded, opt-in, and it answers the actual question the compression was trying to answer.
- **The geometry of empty space is not empty.** Orbits, trajectory trails, the ecliptic plane, the heliopause shell, constellation lines, 1/10/100 pc wireframe shells, the galactic plane, survey footprints. Drawing these is not cheating — it is drawing the thing the atlas is *about*.

Every number in the UI — readout, ruler, inspector, search result — reports the true value. Unit-tested.


## Design system

## Instrument panel over a photographic sky

The current language is a terminal HUD: translucent floating cards with `backdrop-filter: blur(18px)` (`ui.css:30-38`), 9px DM Mono kickers, 8px credit text. Over a lit Blue Marble the text contrast collapses, and `backdrop-filter` forces a composited readback of the WebGL layer **every frame the canvas changes** — which is every frame. NASA Eyes and Space Time both use opaque, edge-docked panels. We follow them.

### Typography

Self-hosted variable fonts, latin + latin-ext subset, preloaded in `index.html` with `<link rel="preload" as="font" type="font/woff2" crossorigin>`. **Delete the `@import` on `src/styles/global.css:1`** — a CSS `@import` of a remote stylesheet is three serialised round trips to two origins before any text paints, on a page already fighting for the main thread.

| Role | Family | Weights |
|---|---|---|
| UI | **Inter Variable** | 400 / 500 / 600 |
| Object names, titles | **Inter Tight Variable** | 600 (200 for the wordmark) |
| Designations, RA/Dec, hashes **only** | **DM Mono** | 400 / 500 |

```css
--t-micro:   11px/1.45; letter-spacing: .02em;   /* UPPERCASE only */
--t-tiny:    12px/1.5;  letter-spacing: 0;
--t-mini:    13px/1.54; letter-spacing: -.01em;
--t-small:   14px/1.5;  letter-spacing: -.013em;
--t-base:    15px/1.6;  letter-spacing: -.011em;
--t-lg:      17px/1.5;  letter-spacing: -.012em;
--t-title:   22px/1.25; letter-spacing: -.02em;   /* Inter Tight 600 */
--t-display: 32px/1.1;  letter-spacing: -.025em;
```

Every number in the UI gets `font-variant-numeric: tabular-nums slashed-zero` on Inter. **Never reach for mono just to align digits** — that is the single biggest reason the current UI reads as a terminal. The 9px kicker becomes 11px Inter 600 uppercase +0.08em; the 8px credit strip becomes 12px.

### Colour — OKLCH ramp at hue 265

```css
:root {
  --bg:          #05070a;   /* page / void */
  --surface-0:   #07090e;
  --surface-1:   #0f1218;   /* panels */
  --surface-2:   #171b22;   /* rows, inputs */
  --surface-3:   #20242d;   /* hover */
  --surface-4:   #2d333e;   /* pressed / selected */
  --line:        #20242d;
  --line-strong: #2d333e;
  --line-hair:   rgba(255,255,255,.06);

  --text-1: #f2f6f9;  /* 17.3:1 on surface-1 */
  --text-2: #bdc5cb;  /* 10.7:1 */
  --text-3: #8a949b;  /*  6.1:1  — body text floor */
  --text-4: #616a71;  /*  3.4:1  — DISABLED / DECORATIVE ONLY */

  --accent:      #60c2ff;   /* 9.5:1 */
  --accent-hi:   #8bdbff;   /* 12.2:1 — focus rings, selection reticle */
  --accent-tint: #0e2036;
  --live:  #5edb81;  --warn: #faab3f;  --danger: #fa6863;

  --r-panel: 8px;  --r-control: 6px;  --r-pill: 999px;
  --sp: 4px;       /* spacing base */
}
```

**`--quiet: #626c73` is deleted.** Measured 3.66:1 on the panel background — it fails WCAG AA (4.5:1) and it currently carries layer descriptions, scale-bar units and the entire credit strip, at `ui.css` lines 171, 194, 289, 377, 405, 451, 626, 646, 745, 752, 828, 841, 851. Global replace → `--text-3`. `scripts/check-contrast.mjs` runs in CI so it cannot regress.

`@media (prefers-contrast: more)` promotes `--text-3`→`--text-2` and `--line`→`--line-strong`. `@media (forced-colors: active)` gives every panel a 1px `CanvasText` border.

### Object classes — equal-lightness ring + mandatory glyph

All at OKLCH L=0.80 so no class dominates. **Colour is reinforcement; the glyph is the encoding** — I verified that exoplanet at h=330 is indistinguishable from galaxy at h=340, and deuteranopia collapses several more pairs.

| Class | base | dim | tint | glyph (10px) |
|---|---|---|---|---|
| star | `#dcbc33` | `#9d8519` | `#271f00` | ring |
| planet | `#7dc1ff` | `#5688c8` | `#0e2036` | filled disc |
| moon | `#a0c4d4` | `#6f8b97` | `#172125` | small disc |
| dwarf planet | `#d1a8ff` | `#9575b8` | `#241930` | dashed ring |
| asteroid | `#ffa460` | `#b9723f` | `#311806` | diamond |
| comet | `#4cd7c8` | `#2e998e` | `#002622` | teardrop |
| spacecraft | `#81d584` | `#58985b` | `#0f2510` | chevron |
| galaxy | `#f59cd8` | `#b06c9a` | `#2d1626` | spiral |
| nebula | `#ff9395` | `#c46668` | `#341415` | cloud |
| star cluster | `#a5b6ff` | `#7481c5` | `#191d35` | dotted cluster |
| black hole | `#aebde5` | `#7b85a4` | `#1b1f29` | black disc + ring |

Exoplanets use **planet blue with a ring outline**, not their own hue.

### Layout — five zones

| Zone | Size | Surface |
|---|---|---|
| **1 Top bar** | 48px, full width | `--surface-1` opaque, 1px bottom `--line`. Wordmark · View/Layers/Time menus · ⌘K field (260px) · settings |
| **2 Cosmic address** | 32px | transparent over canvas, 11px Inter 600 uppercase +0.08em |
| **3 Right inspector** | 360px fixed | `--surface-1` **opaque**, 1px left `--line`, slides in 220ms |
| **4 Bottom time bar** | 56px, full width | the **one** glass surface: `--surface-1` @ 92% + `blur(16px)` |
| **5 Left HUD + scale ladder** | 48px rail + chrome-less text | no panel; `text-shadow: 0 1px 3px rgba(0,0,0,.9)` |

Gutters 24px desktop / 16px phone. z-ladder: scene 30 · hud 900 · chrome 1000 · inspector 1100 · sheet 1200 · palette 1400 · modal 1500 · toast 1600.

Glass survives in exactly two places: the time bar and transient toasts — nothing critical is behind either.

### Mobile (<768px)

Verified broken today at 390×844: the view-model card occupies ~45% of the viewport directly over the Sun, and the LIVE UTC card overflows the right edge.

Right inspector is replaced by a bottom sheet with three snap points: **PEEK 88px** (class dot + name + one headline stat + grab handle) / **HALF 50vh** / **FULL 92vh**. Handle 36×4px, radius 2px, `#2d333e`, `touch-action: none` on the handle only. Top bar collapses to 44px. Scale ladder becomes a horizontally-scrollable 28px strip. **A sheet never exceeds 60vh by default — the 3D subject must stay visible, which is the entire point of the product.** `env(safe-area-inset-bottom)` padding throughout.

### Motion

```css
--ease-out:      cubic-bezier(.16, 1, .3, 1);     /* entering: panels, sheets, palette */
--ease-standard: cubic-bezier(.2, 0, 0, 1);       /* moving in place */
--ease-micro:    cubic-bezier(.4, 0, .2, 1);      /* hover, colour, opacity */
--d-press: 90ms; --d-micro: 120ms; --d-standard: 180ms; --d-enter: 220ms; --d-sheet: 320ms;
```

Camera flights interpolate in **log distance** with a van Wijk–Nuij geodesic (ρ=√2), duration `clamp(900, 420·log10(d_end/d_start) + 700, 2600)` ms — so Earth→Moon and Earth→Andromeda take the same comfortable time. Orbit damping scales with the active layer (a fixed 0.06 is molasses at galactic scale and twitchy at the surface).

**Reduced motion:** flights become a 120ms crossfade cut; no idle drift; no parallax; label fades 0ms; planet rotation clamps and the simulation defaults to paused — but **time controls stay enabled**, because the simulation is content, not decoration. Bloom stays (it is not motion).

### 3D look — five changes, ranked by payoff per line

1. **Bloom + AgX.** `<EffectComposer multisampling={0} frameBufferType={HalfFloatType}>` → `<Bloom intensity={0.85} luminanceThreshold={1.0} luminanceSmoothing={0.28} mipmapBlur radius={0.72} resolutionScale={0.5} />` → `<ToneMapping mode={AGX} />` → `<SMAA />`, with `gl.toneMapping = NoToneMapping`. **AgX, not ACES** — ACES hue-shifts saturated bright oranges toward white, which is exactly the Sun and Jupiter. No `SelectiveBloom` (second render pass for nothing); push emissive above 1.0 and let the HDR threshold select. **Drop `toneMapped={false}` on the Sun** so its glare reads as light, not a white sticker.
2. **Atmosphere rim.** Backside sphere at 1.025× radius, `AdditiveBlending`, `depthWrite: false`, `alpha = pow(1 - dot(N,V), 3.0) * clamp(dot(N,L)+0.3, 0, 1)`. Earth `#4a87d8`, Mars `#c9846a`, Venus `#e8d9a8`, Titan `#d9a44c`, Neptune `#4a6fd8`. ~40 lines, transforms every planet.
3. **Night lights.** NASA Black Marble 2016 (public domain), mixed as emissive by `smoothstep(0.02, -0.12, dot(N,L))`. One texture, biggest single "wow" at Earth.
4. **Ring shadowing + forward scatter.** Ray/sphere test to darken the shadowed arc, plus `mix(reflected, transmitted, smoothstep(0,1,-dot(L,V)))` so rings brighten when backlit. This is what makes Saturn look photographed.
5. **Vignette + 1.5% grain.** ~10 lines; kills the flat-black-void feeling.

Also: `ambientLight intensity={0.24}` at `SolarSystemScene.tsx:67` drops to **0.03** plus a `hemisphereLight` at 0.06 tinted `#22304a`. That fake fill is the main reason the planets currently look like billiard balls.

**Explicitly skipped:** SSAO (nothing to occlude), depth of field (reads as a bug at planetary scale and fights label legibility), SSR, motion blur, god rays, lens flares, chromatic aberration.

### Labels

Two tiers on the single 2D canvas overlay. **PRIMARY** (Sun, planets, dwarfs): Inter 600, 11px, UPPERCASE, +0.14em, `#f2f6f9`, 4px leader line to a 5px class-coloured ring glyph. **SECONDARY** (moons, features, stars): Inter 500, 11px, sentence case, `--text-2`. Every label gets `shadowColor rgba(0,0,0,.9)` / `shadowBlur 4`, plus a 50%-opacity rounded-rect scrim when the pixels behind it are bright. Greedy declutter: sort by importance, reserve AABB, skip collisions, fade 160ms. Selection marker is a **4-piece corner-bracket reticle** in `--accent-hi`, not a circle.


## Data plan

## Rule zero

**No third-party host is contacted at runtime. Ever.** Everything is ingested by a `scripts/build-*.mjs`, pinned to a commit or release tag, sha256-recorded, licence-recorded, and served from our own origin. This is what makes the COOP/COEP headers safe, removes the entire CDN-CORS failure class, and satisfies per-asset attribution obligations. The one permitted exception is `hips2fits` **at build time**.

`src/data/assetUrls.ts` is the single registry. Every entry: `{ id, url, sha256, bytes, licence, attribution, frame, retrieved, pinnedTo }`.

### Solar system

| Layer | Source | Licence | Size | Packaging |
|---|---|---|---|---|
| Planet / major-moon ephemeris | **astronomy-engine 2.1.19** (in-bundle, VSOP87/ELP) | MIT | — | Runtime, in worker. Keep. |
| Body surface maps | **CDS hips2fits** bake: `CDS/P/Mars/MOLA-color`, `CDS/P/Moon/LROC-WAC-100m`, `CDS/P/Mercury/MESSENGER-MDIS-LOI-166m`, `CDS/P/Venus/Magellan/C3-MDIR-2025m`, `CDS/P/Io/Galileo-SSI-1km`, `CDS/P/Europa/Voyager-GalileoSSI-500m`, `CDS/P/Titan/SAR-HiSAR-128ppd`, `CDS/P/Pluto/NewHorizons-Jul2017-300m`, + the ~50 others in the registry | NASA/ESA/USGS provenance; per-survey `properties` carries `prov_progenitor` | 4096×2048 (8192×4096 Earth/Moon/Mars) → **KTX2 UASTC ≈ 33 MB / ETC1S ≈ 17 MB each** | `scripts/bake-body-textures.mjs` → `scripts/build-textures-ktx2.mjs`. Over-request and crop: at `fov=360, height=800` Mars came back with thin polar black bands. |
| Elevation | `CDS/P/Mars/MOLA-MEX-blended` (fits), `CDS/P/Earth/DEM/elevation` (fits), existing LOLA 4ppd | public domain | 2048×1024 16-bit PNG + derived normal map | FITS decoded in **Node at build time**, not in the browser |
| Gas-giant + Sun maps | **Solar System Scope / INOVE 8K** | CC BY 4.0 | KTX2 ETC1S | Credit line is mandatory and goes in the loading screen + Sources |
| Named small bodies | **JPL SBDB** `ssd-api.jpl.nasa.gov/sbdb_query.api` — top ~1,200 by H | public domain | ~60 KB JSON | **Build time only.** Verified: returns 200 with valid data but sends *no* `Access-Control-Allow-Origin`. |
| Belt field | Same SBDB pull, H-limited, 80,000 bodies | public domain | 80,000 × 28 B = **2.24 MB** `Float32` SoA (a, e, i, Ω, ω, M0, epoch) | Propagated entirely in the vertex shader. Gives real Kirkwood gaps instead of a decorative ring. |
| Orbit polylines | Precomputed from astronomy-engine | — | ~400 KB total | **Must be build-time.** Verified: Pluto's 181-sample path costs **60.7 ms** synchronously inside a React render today, on every mount and every mode toggle. |

**Fixes landing with this ingest:** the four notable asteroids currently hardcode `nodeDeg: 0, periapsisDeg: 0` (`asteroidBelt.ts:136-137`) while the UI cites JPL SBDB as the source — Ceres' real Ω is ~80.3° and ω ~73.6°. They are also oriented with `parentEquatorialFrame(Body.Sun, …)` — the Sun's rotation pole, 7.25° off the ecliptic — because no ecliptic transform exists in the codebase.

### Stellar

Primary catalogue: **AT-HYG v4.0** (Tycho-2 + Gaia DR3 + Hipparcos + Gliese + IAU names), from `https://codeberg.org/astronexus/athyg/media/branch/main/data/subsets/athyg_40_reduced_m10.csv.gz`. **Use `/media/`, not `/raw/`** — the raw URL returns a 133-byte Git-LFS pointer and will silently break the build script.

**Licence decision: accept CC BY-SA 4.0 on the derived binaries.** The alternative (rebuilding from Gaia DR3 + Tycho-2 + BSC) means redoing AT-HYG's cross-matching, which is the expensive part, for a share-alike obligation that costs us nothing — our application code is unaffected. Ship `public/data/stars/LICENSE-DATA.md` and keep `scripts/build-stars.mjs` in the repo so the obligation is trivially satisfiable.

| Tier | Cut | Stars | Layout | Bytes | When |
|---|---|---|---|---|---|
| **L0** naked eye | mag ≤ 6.5 | 8,127 | A: f32 xyz pc + u8 absmag + u8 bv + 2 B flags = 16 B | **127 KiB** | parallel with planet textures |
| **L1** neighbourhood | mag ≤ 8.0 **or** d ≤ 50 pc | 47,756 | A, 16 B | **746 KiB** | on idle after first paint |
| **L2** deep | whole m10 subset | 329,571 | B: i16 xyz per-shell + u8 ×2 = 8 B | **2.58 MiB**, HEALPix nside=4 → 192 chunks, 13.5 KiB mean | when the camera leaves the solar system |
| **L3** opt-in | m11 subset | 875,292 | B, 8 B | 6.7 MB | toggle that names the size; **off by default on touch** |

Three things that are easy to get wrong and are verified:
- **`ra` is in HOURS, not degrees.** Skip the trig entirely — `x0/y0/z0` are already ICRS-equatorial parsecs (verified to 1.6e-06 relative error).
- **Row id=1 is the Sun** (`Sol`, d=4.85e-06 pc). Filter it or you render a star at the camera origin.
- **Quantize i16 per distance shell, not globally.** A global scale degrades the 25 pc shell from 0.76 mpc to ~3 pc of error. Store the shell radius in the manifest; multiply in the vertex shader.
- **Budget RAW bytes.** Brotli-11 on correctly-quantized 8-byte records gave 214.5 KiB from 214.5 KiB — literally zero gain.

Supporting:
- **Constellations** — Stellarium `modern_iau` `index.json` (134 KB), HIP id sequences resolved against AT-HYG's `hip` column at build time → `Uint32Array` index pairs, ~1,600 segments, ~13 KB. Chosen over d3-celestial's GeoJSON because HIP sequences attach to real 3D positions, so **the constellations correctly distort and fall apart as the camera leaves the Sun** — the single most memorable moment in a universe atlas. They fade out entirely past ~50 pc; keeping them at 10 kpc would be actively misinformative.
- **Star colour** — Ballesteros (2012) B−V → T_eff → Planck × CIE 1931 → linear sRGB, **luminance-normalised** (skip that and blue stars render dim), baked into a 256×1 RGB8 LUT (768 B). One `texelFetch`, zero shader math.
- **Names** — AT-HYG's `proper` column (605 named, 1,539 Bayer). The Rochester IAU-CSN.txt is frozen at 2022-04-04 with 451 entries; AT-HYG v4.0 is more current. → `names.json`, a few tens of KB.
- **10 pc census** — VizieR `J/A+A/650/A201` (Reylé+ 2021), 541 objects in 336 systems. AT-HYG's m10 holds only 306 objects within 10 pc because the brown dwarfs and late-M dwarfs were never in Tycho-2. ~40 KB JSON.
- **Exoplanets** — NASA Exoplanet Archive TAP `pscomppars`, joined on **`gaia_dr3_id`** (strip the `"Gaia DR3 "` prefix; the column `gaia_id` does not exist and throws ORA-00904). 6,445 planets / 4,842 hosts → **<150 KB** packed. **No CORS header — build time only.**
- **Sky background** — **NASA SVS Deep Star Maps 2020** 8192×4096 celestial-frame (1.7 billion stars, Hipparcos-2 + Tycho-2 + Gaia DR2) → KTX2, ~6 MB. Public domain. **Chosen over CDS DSS2 HiPS, whose `properties` declares `hips_license = ODbL-1.0`** — share-alike, awkward baked into a shipped texture.

### Deep sky

| Layer | Source | Licence | Packaging |
|---|---|---|---|
| NGC/IC | **OpenNGC release tag `v20260501`** (pinned, not master), 13,970 rows + 64-row addendum | CC-BY-SA-4.0 | 24 B/record → **335 KB** `ngc.bin`. RA/Dec are **sexagesimal strings** — parse, don't read as floats. |
| Nebula outlines | OpenNGC `outlines/objects/` — **379 traced isophote polygons**, 6.1 MB text | CC-BY-SA-4.0 | Int16 RA/Dec deltas + index header ≈ **1 MB**. The highest-visual-payoff free asset almost nobody uses. |
| Per-object imagery | **hips2fits** cutout on selection, `fov = max(MajAx, 2′) × 2.5 / 60` deg | per-survey credit | ~22 KB/cutout, cached in **Dexie** by (id, survey, fov). Survey selector: DSS2 / 2MASS / SDSS / AllWISE. |

Derived files live under `public/data/deepsky/` with their own LICENSE file. **Never inline OpenNGC rows into `src/data/*.ts`** — CC-BY-SA is copyleft on the derived database and we do not want to argue about whether our source is an adaptation.

### Galaxy

| Layer | Source | Size | Provenance badge |
|---|---|---|---|
| Globular clusters | **Harris 2010** (Dec 2010 revision), 157 clusters with R_Sun/R_gc | ~20 KB JSON | MEASURED |
| Spiral-arm tracers | **Reid+ 2019** (ApJ 885, 131), ~200 maser parallaxes, R₀ = 8.15 kpc, Θ₀ = 236 km/s | ~10 KB JSON | MEASURED |
| Arm curves | Reid's log-periodic spiral fits, implemented in `src/astronomy/galaxy.ts` **as code, not data** | — | **MODEL**, visually tied to the masers constraining it |
| Disk field | `scripts/build-galaxy-field.mjs`: ~300k deterministically seeded points from the Reid model, 3.5 kpc scale length, 300 pc thin-disk height, coloured by an age/metallicity gradient | ~4 MB f32 | **MODEL** |
| Dust | Edenhofer+ 2024 (Zenodo), 69–1250 pc, nside 256 | downsampled to ~800 KB | MEASURED |

**There is no photograph of the Milky Way from outside and there never will be.** The ESO/R. Hurt artwork (`eso1339e`, CC BY 4.0) ships as a **separately-toggled, verbatim-credited "artist's impression" overlay** — never as the default galaxy. The default carries the badge: *"MODEL — generated from Reid+2019 arm fits; no image of our galaxy from outside exists."* Deterministic seeding is non-negotiable or shared deep links stop reproducing what the user saw.

### Extragalactic & cosmic

| Layer | Source | Rows | Packaging | Note |
|---|---|---|---|---|
| Local Volume | **UNGC** (Karachentsev+ 2013, VizieR `J/AJ/145/101`) | ~1,400 within 11 Mpc | ~250 KB JSON | Mostly TRGB distances. The missing rung between Local Group and Cosmicflows. Tidal index is a free, genuinely informative colour channel. |
| Cosmic web (distance) | **Cosmicflows-4 table3** (`J/ApJ/944/94`) | 38,053 **groups** | 20 B/rec = **761 KB** | Ships `SGL`/`SGB` — supergalactic coords already computed, no frame math. Redshift-*independent*, so no Fingers-of-God. Render `e_DMav` as radial elongation: line-of-sight error dominates, so this is honest *and* distinctive. Groups, not table2's 55,877 individuals. |
| Cosmic web (all-sky) | **2MRS** (`J/ApJS/199/26`) | 44,599 galaxies | 14 B/rec = **624 KB** | Redshift-space only. **Render the 9% zone of avoidance as an explicit translucent wedge labelled "obscured by the Milky Way — no survey coverage."** Every atlas that silently interpolates across it is lying. |
| Horizon | **Planck 2018 SMICA CMB** → equirect KTX2 | — | ~2 MB | Textured shell at 14,300 Mpc comoving. Labelled *"the limit of what can be seen — 13.787 billion years of light travel"*, **not** "the edge of the universe." |

**Whole extragalactic stack ≈ 3.7 MB over the wire**, comparable to the 2.35 MB `countries-50m.bin` already shipping.

### Cosmology — one frozen module

`src/astronomy/cosmology.ts`:
```ts
export const COSMOLOGY = Object.freeze({
  H0: 67.66, Om: 0.3111, OL: 0.6889,
  source: 'Planck 2018 TT,TE,EE+lowE+lensing+BAO',
})
```
Use the **distance modulus directly wherever it exists** (CF4, UNGC) — exact, no cosmology assumed. Use `cz/H0` only below z≈0.1 (2MRS). Use the comoving integral `D_C = (c/H0)∫dz'/E(z')` for anything beyond. CF4's internal scale is H0 = 74.6 while Planck gives 67.4; mixing them puts a visible ~10% seam exactly at a scale transition. The UI discloses the tension rather than hiding it — that turns a footnote into exactly the kind of informative honesty the product promises.

### Explicitly rejected

| Rejected | Why |
|---|---|
| **AMNH Digital Universe Atlas** | Best-curated 3D atlas in existence, worst possible licence: personal use only, no public consumption without written permission. Use as a reference for *what* to show; rebuild from primary catalogues. |
| **Live HiPS tile pyramid** | Order 11 is 12×4¹¹ = **50.3 million tiles** for one survey. A multi-terabyte remote dependency and a per-frame network stall, for a product whose objects are individually placed. We take hips2fits at build time instead. `HipsTileProvider` stays a stub for a later surface-descent phase. |
| **Gaia DR3 HiPSCat TSV** | Rows carry the full ~100-column `gaia_source` schema — kilobytes per useful star. |
| **Milliquas v8** (1.02M quasars) | 16.3 MB. Deferred to post-launch; needs HEALPix order-3 sharding sorted brightest-first. |
| **IllustrisTNG** | Simulates a universe with our parameters, not our universe. No object in it corresponds to anything real. |
| **Gaia DR4** (lands 2 Dec 2026) | ~500 TB; does not change the browser ceiling. `build-stars.mjs` takes a catalogue-version parameter so a re-run is a flag, not a rewrite. |
| **d3-celestial `mw.json`** | 178 KB gzipped of Milky Way polygons that will not agree with the 330k real stars we already render. |


## Interaction model

## Orientation first, everything else second

The product's hardest problem is not rendering 23 orders of magnitude — it is making the user know where they are at every point along them. Five persistent affordances answer that, and nothing else in the HUD is permanent.

### Permanent chrome (5 elements)

1. **Scale ladder** — left rail, 48px, full height. Logarithmic axis, 14 named rungs, draggable thumb tracking view span. Labels on hover/focus only so it reads as a quiet instrument, not a menu. Thumb is a 2px bar with a 16px grab target; rungs are 1px ticks with named rungs at 12px. Keyboard: ↑/↓ steps a rung, PgUp/PgDn jumps three, Home returns to Earth. `role="slider"` with `aria-valuetext` reading the rung name plus the distance — which is also the accessible answer to "where am I," currently unserved anywhere in the UI. **This component earns its space three times: as the primary long-haul control, as the loading indicator (which rungs are loaded / loading / unavailable), and as the grand-tour progress bar.**

2. **Cosmic address** — top-centre, 32px row. `Observable Universe › Laniakea › Local Group › Milky Way › Orion Arm › Solar System › Earth › Moon › Tycho`. Derived from the **catalogue containment hierarchy, not navigation history** — standing on Tycho the path is always the same regardless of how you arrived. Last 2 segments shown, expand on click, middle collapses to `…` under 900px. Each segment is a `flyTo`. This replaces the back button as the primary orientation device. Derived purely from camera distance + focus so it can never desync from the view.

3. **Distance readout** — always two lines. Primary auto-selects m → km → R⊕ → AU → ly → kpc → Mpc → Gly so the mantissa stays in [1, 1000). Secondary is **always light-travel time**, the only unit that stays intuitive across all 23 decades. `formatDistance()` in `Interface.tsx` currently tops out at "million km" — it has no branch above 1e6 km at all. Lead with light-years for a general audience; carry pc/kpc/Mpc and z as secondary professional fields. Past 100 Mly, a lookback banner: *"You are seeing M87 as it was 53.5 million years ago."*

4. **Context inset** — bottom right, 160×160, **two stacked 2D projections** (top-down and edge-on), not a 3D render. Two because one view cannot show whether you are above or below the galactic plane. Contents swap with the active layer.

5. **Nearest-object chip** — top bar. In interstellar space this chip is the entire difference between "lost in a void" and "3.2 ly from Proxima Centauri."

Plus a **off-screen focus chevron**: an edge-clamped arrow with name and angular offset whenever the focus leaves the viewport. OpenSpace's own docs concede that navigating with the focus off-screen "can be a bit cumbersome" — we do not inherit that bug.

### Rung-keyed HUD

`Interface.tsx` already renders ten permanent elements. Adding five orientation widgets on top produces the expert-only cockpit that makes Celestia and Gaia Sky unapproachable. The resolving rule: **the HUD shows exactly what is actionable at the current rung, and nothing else.**

| Rung | Rung-specific controls |
|---|---|
| Surface / Body | surface layers, terrain exaggeration, coordinate readout |
| Moon system / Inner / Outer system | orbit paths, orbit colours, shadow transits, time rate |
| Heliosphere / Oort / Nearest stars | limiting magnitude, proper-motion rate, constellation toggle |
| Local Bubble / Milky Way | dust opacity, arm model toggle, globulars, deep-sky filter |
| Local Group → Observable Universe | redshift range, survey footprint, lookback readout, CMB |

Controls irrelevant at the current rung are **removed, not greyed** — a country-borders toggle visible from the Virgo Cluster is noise. Implemented as a control registry where each entry declares `visibleAtRungs: RungId[]`; ~30 lines, and it is the difference between scaling to 14 rungs and collapsing under chrome at 4.

### Search — ⌘K command palette

`DirectoryPanel.tsx` runs four `Array.filter().includes()` passes per keystroke over countries/cities/craters, allocating a fresh `AtlasEntity` per match, with a per-source `.slice(0, 40)` that **silently drops good matches today**, and renders every row as a DOM button with no virtualization. It is hopeless against 330k stars, let alone 1.8 billion.

Replacement: ⌘K / Ctrl+K / `/`, 560px, centred at 18vh, opaque `--surface-1`, radius 12px, `0 24px 64px rgba(0,0,0,.6)`.

- **Grouped by scale rung, never flat**, with counts: `Surface features (12) · Moons (3) · Planets (1) · Stars (431) · Deep sky (18) · Galaxies (2)`. A flat list across 23 orders of magnitude is incomprehensible — **the group header is the scale context.** Typing "rhea" must visibly disambiguate Saturn's moon from the lunar crater; grouping does that for free.
- **Every row carries containment path + live distance from you**: `Tycho — Moon › Near side — 1.4 light-seconds away`.
- **Strict ranking tiers:** exact canonical name → exact alias/ID → prefix of canonical → prefix of alias → trigram fuzzy. Within each tier, sort by a **precomputed prominence score** (apparent magnitude, body importance, population), never alphabetically. Acceptance test: `"mar"` returns Mars before Mare Marginis before Maracaibo.
- **Catalogue IDs first-class:** HIP, HD, HR, Gaia DR3 source_id, Messier, NGC, IC, Bayer/Flamsteed — baked into `names.json` at build time.
- **Actions too**, not just objects: "Set time to…", "Toggle orbit paths", "Go to Local Group", "Compare sizes with Earth".
- MiniSearch over a build-time prefix index, **in a worker**, lazy-loaded per rung. Budget **<16 ms per keystroke**, 80ms debounce, 50 rows capped with an "N more" footer.
- **Coverage honesty as a row:** when a rung has no dataset loaded, render *"Quasars — not in this snapshot"* rather than returning nothing.

The browsable directory survives as a **Discover** panel: category filter chips (Planets, Moons, Small bodies, Stars, Nebulae, Galaxies, Missions) over cards with a real captured scene thumbnail and a one-line hook — thumbnails generated in CI by driving `?focus=&dist=&dir=` URLs with Playwright.

### Inspector — a graph, not a tree

Right panel, 360px, opaque. Header: class dot + glyph, name (22px Inter Tight 600), subtitle (`Moon · of Jupiter`, 13px `--text-3`). Four tabs:

- **Overview** — 3-sentence description, Read More (progressive disclosure), key facts as label/value rows with tabular-nums right-aligned.
- **Data** — full physical/orbital parameters with uncertainties, and `distanceKind` on every distance.
- **Evidence** — the moat. Per-aspect provenance chips (see below).
- **Nearby** — **Related chips with thumbnails**. This is the real information architecture: you reach a spacecraft from a planet, not through a menu tree. A taxonomy sidebar dead-ends at every leaf.

### Provenance — the differentiator

`src/data/types.ts` gains:
```ts
provenance: {
  position:   ProvenanceRef
  orbit:      ProvenanceRef
  physical:   ProvenanceRef
  appearance: ProvenanceRef
}
type ProvenanceRef = {
  source: string
  kind: 'observed' | 'catalog' | 'computed' | 'reconstructed' | 'illustrative' | 'undocumented'
  retrieved?: string
  url?: string
}
```

Rendered as small chips at the bottom of the inspector. **Aspect-scoped**, because an object's position can be computed while its appearance is reconstructed — Miranda's unobserved northern hemisphere must not be presented as mapped. The product line is: *reconstructions and visual exaggerations are identified in the interface instead of being passed off as observations.* Each layer additionally carries a three-state badge: **MEASURED / DERIVED / ILLUSTRATION**.

This is the cheapest way for OmniAtlas to be informative in a way NASA Eyes and Solar System Scope are not, and — more usefully — **it forces data hygiene across the entire catalogue**, because every field must name where it came from.

Every disclosure string is **generated from the transform actually in use**, never hand-written, with a unit test asserting the rendered string matches. The current `Interface.tsx:182` lie is exactly what happens otherwise.

### Time

Bottom bar, 56px, full width, glass. `⏪ ⏸ ⏩` driving a **discrete rate ladder** — `[±100 yr, ±1 yr, ±1 mo, ±1 wk, ±1 day, ±1 h, ±1 min, ±1 s] / s` — with a human-readable string (`real time`, `60×`, `3 min/s`, `5 day/s`, `1 yr/s`). Date chip split `2026 / 14 OCT / 19:51:45` UTC, click to edit. `Now` button with a `● LIVE` badge. Scrub slider with window presets **24h / 30d / 1y / 100y / 1ky** and a "real current time" tick on the track. Keyboard `,` `.` `Space` `N`.

Taking Space Time's design over NASA's: NASA's curved arc is prettier but its rate is a continuous slider with no readable units, and a user cannot tell what rate they are at.

**There is exactly one clock.** Today `CameraRig.tsx:134` and `:174` call `new Date()` — literal wall-clock — while the scene renders `new Date(simulationTimeMs)`. They agree only because `Interface.tsx:66-70` pins `simulationTimeMs = Date.now()` every second, which means **no pause, scrub or rate control can ever hold**. The moment one ships, the camera chases a moon's real-time position while the moon is drawn at its simulated position: for Io, a 1-hour scrub puts the camera ~8° of orbit off target. `Date.now()` becomes illegal below `src/ui/`, lint-enforced.

Later addition once stars ship: an **Observed Light** toggle showing objects as their light left them. A genuine differentiator.

### First five seconds

The store defaults to `focus: 'system'` — an abstract compressed diagram of nine dots with no referent and no reason to care. **Open at Earth.** It is the only object every visitor already has a scale intuition for, and the whole ladder hangs off it.

| t | |
|---|---|
| 0.0 s | Earth filling ~55% of frame height, real current-UTC terminator, Moon in frame, real star background. One line of chrome: `Earth · now`. No spinner — globe loads at a 512px placeholder and silently upgrades. |
| 0.5 s | Scale ladder fades in, thumb parked at BODY. |
| 1.0 s | Slow pull-back (~8°/s apparent). Moon acquires a leader line: `the Moon · 1.28 light-seconds`. |
| 3.0 s | **The cosmic address writes itself outward, segment by segment**: `Earth ‹ Solar System ‹ Milky Way ‹ Observable Universe`. A one-second typewriter that teaches the product's entire structure before the user has clicked anything. The highest-value second in the experience. |
| 5.0 s | Motion stops. Three chips low-centre: *Explore Earth* / *Fly to the Solar System* / *Zoom out to the Universe*, plus a dismissible `Scroll to zoom · Drag to orbit` (persisted in localStorage after the first successful drag + zoom). |

**Any pointer, key or wheel event before 5 s hands over control instantly.** `prefers-reduced-motion` renders the 5.0 s end state directly. The intro is built as a normal `cameraPath` animation, not a special case — so the same machinery powers the **grand tour** ("Take me to the edge of the universe": a 25 s skippable scripted path through all 14 rungs with the thumb sliding), deep links, and visual regression tests.

### Loading screen

`LoadingScreen.tsx` is 20 lines gating the whole app behind one `<Suspense>`. Replacement: the Sun or Earth renders **live** behind it (start the canvas immediately, gate only the UI); wordmark in Inter Tight 200 at `clamp(48px, 7vw, 96px)` +0.18em; a 1px `--accent` progress rule; a status line naming the **real** phase from actual load events (`Decoding Blue Marble`, `Loading Gaia starfield`, `Computing ephemeris`); a rotating fact card about the body you are about to land on; the texture credit inline. Distinguish *essential* from non-essential assets and **lift the overlay the moment the focus body has geometry and its essential texture** — stream the rest in behind the live scene. Never lift on "all modules loaded," or slow modules leave the camera parked next to the Sun.

### URL state

```
/#f=helio&a=mars&d=4.21e4&q=0.31,0.02,-0.95,0.1&t=2026-10-14T19:40Z&l=orbits,labels&m=solar,stars
```
`f`=layer, `a`=anchor, `d`=distance in layer units (3 sig figs), `q`=quaternion (2 dp), `t`=simulation time, `l`=layers, `m`=modules (for isolated dev/profiling). Under 120 characters, pasteable into a chat. Throttled `replaceState` at 500 ms; the parser validates every field and degrades gracefully on garbage.

**One format, four features:** sharing, embedding (`?embed=true`), tour keyframes, and visual regression tests — every Playwright screenshot test becomes a URL.

### Accessibility

A WebGL canvas is an opaque image to assistive tech. **Do not try to make the canvas accessible — mirror the scene in the DOM.**

- `<canvas role="application" aria-label="3D universe view">` with a sibling paragraph read by screen readers describing the keyboard model.
- A visually-hidden-but-focusable `<ul>` of `<button>`s mirroring the currently-labelled objects, **ordered by screen position left-to-right**. Tab walks them, Enter flies — a keyboard user traverses exactly what a mouse user clicks.
- `aria-live="polite"` announcing selection and fly-to arrival: *"Europa. Moon of Jupiter. 628,300 kilometres from Jupiter. Press Enter to fly there."*
- "Skip 3D view" as the first focusable element.
- Real landmarks: `region`/`navigation`/`group` with names ("Simulation time controls", "Cosmic address", "Display and sound"), `aria-pressed` on toggles, `aria-expanded`/`aria-controls` on every disclosure.
- Full keyboard map in a `?` card: `⌘K`/`/` palette · arrows orbit 15°/press · `+`/`−` zoom one step · `F` focus selection · `Esc` deselect · `[` `]` cycle visible objects · `I` read selection · `H` home · `T` time · `L` labels · `M` markers · `1`–`9` jump to scale rung.
- Focus ring `outline: 2px solid #8bdbff; outline-offset: 3px`. In-scene equivalent is the corner-bracket reticle.
- Targets ≥44×44px touch, ≥28×28px with 8px spacing desktop.

This is roughly two days of work and it makes OmniAtlas better than NASA Eyes on an axis NASA is legally obliged to care about.


## Implementation phases

### Phase 0 — Foundations and guardrails

**Goal.** Make the overhaul measurable and safe before any architecture changes. The app looks identical at the end of this phase; everything underneath is now testable.

**Work.**
- Add `vitest` + `@vitest/coverage-v8` and `@playwright/test`. There are currently ZERO tests; no precision or unit claim in this plan is verifiable without them.
- Turn on oxlint `correctness` + `react-hooks` rule sets in `.oxlintrc.json`. Fix the three stale dependency arrays currently hidden behind `// eslint-disable-next-line react-hooks/exhaustive-deps` at `SolarSystemScene.tsx:34`, `CameraRig.tsx:153` (omits `goal` and `coarseEphemeris` — the one that matters) and `AsteroidBelt.tsx:49` for a rule that is not even enabled.
- Add lint rules: no `Date.now()` below `src/ui/`; no `three` import in `src/astronomy/`; no numeric literals in `src/astronomy/` (`ephemeris.ts:121`, `:140` hardcode `1/6_371` and `:195` hardcodes `1_737.5` instead of using `kmToUnits`/`MOON_RADIUS_KM`).
- Remove `leva` (verified zero imports). Keep `dexie`.
- Self-host fonts: `npm i @fontsource-variable/inter @fontsource-variable/inter-tight @fontsource/dm-mono`; delete the render-blocking `@import` on `src/styles/global.css:1`; preload Inter Variable woff2 in `index.html` with a `size-adjust`-matched fallback.
- Write `scripts/check-contrast.mjs` (WCAG relative luminance over the token file) and wire it into CI. It currently fails: `--quiet #626c73` measures 3.66:1.
- Write `scripts/build-textures-ktx2.mjs` (toktx; UASTC for Earth/Moon/Mars base colour, ETC1S for everything else) and `src/core/textures/KtxLoader.ts` with a worker transcoder. Convert the existing 24 JPEGs. Verified today: 11 MB on disk decodes to ~350 MB VRAM, and `blue-marble-december.jpg` alone is 5400x2700.
- Write `scripts/build-orbit-paths.mjs`. Verified: Pluto's 181-sample path costs 60.7 ms SYNCHRONOUSLY inside a React render, on first mount and on every mode toggle. Also drop the `a^1.5` Kepler approximation for each body's tabulated period.
- Fix `AsteroidBelt.tsx` in place: move the instance write from `useMemo` to `useLayoutEffect` (the ref is null during render, so all 4,500 matrices stay at identity until the 1 Hz clock ticks), drop `visible` from deps, drop the wasted `computeBoundingSphere()`.
- Vite: production COOP/COEP headers matching dev; `manualChunks` splitting three+R3F / UI / catalogue modules (dist is currently one 1.35 MB chunk).
- Pass `active` through to `InfoPanel.tsx:30-32` and `DirectoryPanel.tsx:83-85`, which currently eagerly fetch 631 KB of JSON on boot for two closed panels.

**Exit.** `npm test` and `npm run lint` pass with zero warnings. Contrast gate runs in CI and the token file passes. Texture VRAM measured under 90 MB (down from ~350 MB). No synchronous work over 4 ms inside any React render, verified by a Performance trace. The asteroid belt is visible on first paint. App is visually unchanged.

### Phase 1 — The engine: float64 world, render layers, camera

**Goal.** Replace the coordinate and rendering foundation. The existing solar system is ported onto it unchanged in content but correct in precision. This is the phase everything else depends on.

**Work.**
- `src/core/world.ts`: `Vec3d` float64 SI metres; `AU_M`, `PC_M`, `LY_M`, `MPC_M`; frame transform matrices for ICRF equatorial, J2000 ecliptic (obliquity 23.439291111 deg — does not exist in the codebase today), galactic, supergalactic.
- `src/core/Layer.ts` + `src/core/Engine.ts`: the six layers, per-frame float64 rebase `(camWorld - origin)/unit`, `near = max(1e-9, d*1e-4)`, `far = max(defaultFar, d*20)`, far-to-near render with `gl.autoClear = false` and a depth clear between passes.
- DELETE `logarithmicDepthBuffer: true` from `SceneManager.tsx:20` and `configureCameraClipping`'s dependence on `distanceMode`. Do NOT adopt reverse-Z.
- `src/core/registry.ts` + `src/core/SceneNode.ts`: one composable node type (Renderable + Translation + Rotation + Scale) replacing eight bespoke components.
- `src/core/camera/AtlasControls.ts` replacing drei `OrbitControls`: multiplicative log zoom x1.15 / shift x2.0, explicit `WheelEvent.deltaMode` normalisation, left-drag orbit, right-drag look, layer-scaled damping, asymptotic soft landing instead of `minDistance`, NO `maxDistance`.
- `src/core/camera/cameraPath.ts`: van Wijk-Nuij geodesic, rho = sqrt(2), duration `clamp(900, 420*log10(ratio)+700, 2600)` ms. Keep the existing `prefers-reduced-motion` snap branch.
- `src/core/camera/framePolicy.ts`: layer attach/detach with 0.9/1.1 hysteresis.
- `src/workers/simulation.worker.ts`: float64 SoA ephemeris on a `SharedArrayBuffer`. Delete `calculateSolarSystemEphemeris` and the `Map<string, BodyState>` type. Port `bodyOrientation` and `keplerianPosition` across unchanged — they are correct.
- Fix `tidalLockQuaternion` (`ephemeris.ts:94-97`): `setFromUnitVectors` leaves roll unconstrained, so 16 of ~20 moons plus all four asteroids have a wandering north pole. Rebuild from a real basis (Z toward parent, Y = parent pole, X = Y x Z, `Matrix4.makeBasis`) — the same construction `bodyOrientation` already does correctly.
- DELETE `explorationDistanceForAu`, `explorationRadiusUnits`, `explorationMoonDistance` from `src/data/constants.ts` and `distanceMode` from the store. Add the constant-screen-size marker glyph (`BodyMarker`) and the `View spans X` readout as the replacement.
- `src/core/labels/LabelEngine.ts`: generalise `SurfaceLabelField.tsx`'s projection + declutter into a single 2D canvas overlay with a label pool and a `Map<id, index>` (replacing the `items.find()` that costs ~134,000 string comparisons per frame). Delete `BodyLocator` and all drei `<Html>` usage.
- `src/core/picking/IdPass.ts`: 3x3 scissored ID buffer read replacing raycasting.
- Split the store into `useViewStore` / `useTimeStore` / `useSelectionStore` + non-reactive `SimContext`. `focusStack` becomes `containmentPath` (derived) + `history` + `anchor`/`aim`.
- Tests: place a 1,353 km body at 30 AU, assert vertex error < 1 km. Assert `AU_M`/`PC_M` round-trips. Assert the ecliptic transform against known J2000 values. Assert the camera can reach 1e27 m without NaN.

**Exit.** The camera flies continuously from 1 m above Tycho to 1e27 m with no jitter, no z-fighting, no mode switch and no clamp. Precision test passes. One ephemeris evaluation per frame in the worker, zero per-frame React reconciliation (verified in React DevTools Profiler). All existing bodies, moons, orbits, Earth detail layers and crater labels render exactly as before, at true scale.

### Phase 2 — Chrome: design system and HUD

**Goal.** The product stops looking like a terminal and starts looking like an instrument. Every orientation affordance ships, wired to the solar system only.

**Work.**
- Replace `src/styles/global.css` tokens with the OKLCH hue-265 ramp. Global replace `--quiet` -> `--text-3`. Add `prefers-contrast: more` and `forced-colors: active` blocks.
- Delete `backdrop-filter` from `.panel` (`ui.css:30-38`); introduce a separate `.glass` class used exactly twice (time bar, toasts).
- Apply the type scale. Raise the 9px DM Mono kicker to 11px Inter 600 uppercase +0.08em and the 8px credit strip to 12px. Add `font-variant-numeric: tabular-nums slashed-zero` to every numeric readout.
- `src/data/objectClasses.ts`: the 11-class equal-lightness ring plus 11 distinct glyph paths in `src/core/labels/glyphs.ts`.
- Five-zone layout in `AppChrome.tsx`: 48px top bar, 32px cosmic address, 360px opaque right inspector, 56px glass time bar, left HUD + scale ladder rail.
- `ScaleLadder.tsx` — all 14 rungs, with rungs 8-14 greyed and labelled `coming in this release`. Draggable thumb tracking view span, `argmin |log(rung) - log(span)|` highlighting, `role="slider"` + `aria-valuetext`, full keyboard.
- `CosmicAddress.tsx` derived from the containment hierarchy, not history.
- `src/format/units.ts`: `formatDistance(metres)` across m -> Gly with light-travel time as a permanent second line; `distanceKind` required on every distance or the component refuses to render.
- `CommandPalette.tsx` + `src/workers/search.worker.ts` with MiniSearch. Grouped by rung with counts, 5-tier ranking, prominence sort, containment path + live distance per row, actions as well as objects, coverage-honesty rows. Acceptance test: `"mar"` -> Mars, Mare Marginis, Maracaibo in that order.
- `TimeBar.tsx`: discrete rate ladder with human-readable strings, UTC date chip, Now + LIVE badge, scrub slider with window presets and a now tick, keys `,` `.` `Space` `N`. Delete the `setInterval(() => setSimulationTime(Date.now()), 1000)` at `Interface.tsx:66-70` and the two `new Date()` calls in `CameraRig.tsx`.
- `Inspector.tsx` with Overview / Data / Evidence / Nearby tabs; `ProvenanceChips.tsx`; `RelatedChips.tsx`; `SizeCompare.tsx`. Add `provenance`, `related: string[]` and `distanceKind` to `src/data/types.ts`.
- Rung-keyed control registry: each control declares `visibleAtRungs`; irrelevant controls are removed, not greyed.
- `state/urlState.ts` with throttled `replaceState`, plus the Playwright visual-regression harness driven by URLs.
- Mobile: bottom sheet with PEEK 88px / HALF 50vh / FULL 92vh snap points, 44px top bar, scrollable breadcrumb strip, safe-area insets.
- `A11yMirror.tsx`, `KeyboardHelp.tsx`, canvas `role="application"`, `aria-live` announcements, `[`/`]` object cycling, Skip-3D link, landmarks.
- `LoadingScreen.tsx` rework: live scene behind, real phase text, fact card, inline credit, lifts on focus-object ready.
- Generated scale-disclosure component reading the active transform, with a unit test asserting the rendered string matches. Kills the `Interface.tsx:182` class of bug permanently.

**Exit.** Contrast gate passes on every token pair in use. No element below 11px. Lighthouse accessibility >= 95. Full keyboard traversal of every visible object with screen-reader announcements verified in NVDA and VoiceOver. 390x844 renders with the subject visible and no overflow. Every view is a shareable URL that reproduces exactly, verified by Playwright screenshot diff.

### Phase 3 — Solar system complete

**Goal.** The solar system becomes the finished, polished, demoable product. This ships as a milestone on its own before any universe work begins.

**Work.**
- `scripts/build-small-bodies.mjs`: JPL SBDB at build time (no CORS). ~1,200 named asteroids with real a/e/i/Omega/omega/M0/epoch — fixing the hardcoded `nodeDeg: 0, periapsisDeg: 0` at `asteroidBelt.ts:136-137` that the UI currently cites JPL as the source for. Plus 80,000 H-limited belt members as a 2.24 MB Float32 SoA.
- Rewrite the belt as GPU-propagated: upload elements once as `InstancedBufferAttribute`s, pass `daysSinceEpoch` as one uniform, evaluate Kepler in the vertex shader. CPU cost per frame drops to zero and the count goes 4,500 -> 80,000, giving real Kirkwood gaps.
- Orient all heliocentric Keplerian orbits in the J2000 ecliptic frame instead of `parentEquatorialFrame(Body.Sun)` (the Sun's pole, 7.25 deg off).
- `scripts/bake-body-textures.mjs`: hips2fits bake of ~55 bodies at 4096x2048 (8192x4096 for Earth/Moon/Mars), plus FITS DEM decode in Node to 16-bit height + normal maps for Moon, Mars, Mercury, Earth. Over-request and crop (verified polar black bands at `fov=360, height=800`). Store `obs_title` + `prov_progenitor` next to each so attribution is automatic.
- Complete the moon set: all major moons of every planet, each with correct IAU rotation or a correct tidal-lock basis, plus a per-planet `system` layer.
- `src/core/render/PostStack.ts`: `EffectComposer` with HalfFloat, mipmap Bloom (threshold 1.0, intensity 0.85, resolutionScale 0.5), AgX tone mapping moved into the composer, SMAA, vignette + 1.5% grain. Set `gl.toneMapping = NoToneMapping`. Drop `toneMapped={false}` on the Sun and push emissive above 1.0.
- Lighting: `ambientLight` 0.24 -> 0.03 plus a `hemisphereLight` 0.06 tinted #22304a.
- Atmosphere rim shader on Earth, Mars, Venus, Titan, Neptune, Uranus, Jupiter, Saturn, Pluto.
- NASA Black Marble night lights on Earth.
- `src/astronomy/eclipse.ts`: analytic umbra/penumbra from up to 4 occluder (centre, radius) uniform pairs. Solar and lunar eclipses, Saturn's ring shadow on the globe, Jovian moon shadow transits. NO shadow maps — the shadow camera inherits the same near/far explosion as the main camera.
- Ring shadowing + forward scatter on Saturn and Uranus.
- Per-planet orbit colours as a data field. Trajectory trails. Heliopause shell at 121 AU.
- Populate `provenance` for all ~250 solar-system objects. This is the forcing function for data hygiene.
- `Discover.tsx` with Playwright-generated scene thumbnails.
- Surface layer: Earth coastlines/borders/cities and Moon craters ported to the `surface` layer with real terrain displacement on Moon and Mars.

**Exit.** Every body in the solar system is reachable, framed correctly, labelled, true-to-scale, textured from a NASA/ESA/USGS-provenanced source, and carries four-aspect provenance. A solar eclipse on 2027-08-02 renders with a correct umbral track. 60 fps at 1920x1080 dpr 1 on an Iris Xe at the system view with the belt on. This is a shippable product on its own.

### Phase 4 — Stars and the stellar neighbourhood

**Goal.** The first rung beyond the solar system. The sky stops being 4,000 random points and becomes a real catalogue you can fly into.

**Work.**
- `scripts/build-stars.mjs`: AT-HYG v4.0 m10 subset from Codeberg `/media/` (NOT `/raw/`, which returns a 133-byte LFS pointer). Filter row id=1 (Sol). Read `x0/y0/z0` directly — they are already ICRS parsecs; `ra` is in HOURS. Emit L0 (127 KiB), L1 (746 KiB), L2 (2.58 MiB, HEALPix nside=4, 192 chunks), per-shell i16 quantization with shell radius in the manifest. Ship `LICENSE-DATA.md` (CC BY-SA 4.0).
- `src/core/render/StarPoints.ts`: one `InstancedBufferGeometry` per tile with a shared 4-vertex quad. NOT `gl.POINTS` — implementations clip on the point centre so edge stars vanish (KhronosGroup/WebGL #2917), and `ALIASED_POINT_SIZE_RANGE[1]` is 64 on M1/M2.
- Star vertex shader: decode `m = magu/16 - 2`; compute true camera distance in pc; derive apparent magnitude from ABSOLUTE magnitude as `m = M + 5*log10(d_pc) - 5` (without this, flying to Alpha Centauri leaves Sirius exactly as bright as from Earth and the illusion dies); split radius from intensity — `r = r_min + k*max(0, m_limit - m)` hard-clamped to 24 px, intensity as true flux written additively into the HDR buffer so bloom catches bright stars naturally.
- `uMagLimit` driven by FOV (`m_base + 5*log10(FOV_ref/FOV_cur)`) and exposed as a user `limiting magnitude` slider that doubles as a performance dial.
- 256-entry blackbody LUT from Ballesteros B-V -> T_eff -> Planck x CIE 1931 -> luminance-normalised linear sRGB, baked at build time into a 256x1 RGB8 texture.
- `src/core/streaming/TileStreamer.ts` + `UploadScheduler.ts` + Dexie `TileCache.ts`. Worker pool of `min(hwConcurrency-1, 4)`, transferable ArrayBuffers, <= 2 MB GPU upload per frame. Generalise `useRemoteBinary` to return `ArrayBuffer` (it currently hardcodes `Float32Array`).
- `scripts/build-constellations.mjs`: Stellarium `modern_iau` HIP sequences resolved against AT-HYG's `hip` column -> ~1,600 index pairs, ~13 KB. Full opacity inside ~1 pc, gone by ~50 pc, so the constellations visibly distort and dissolve as the camera leaves the Sun.
- `scripts/build-exoplanets.mjs`: NASA Exoplanet Archive `pscomppars` joined on `gaia_dr3_id` (strip the `"Gaia DR3 "` prefix; `gaia_id` does not exist). Flag bit in the per-star flags byte, distinct selectable glyph.
- 10 pc census from VizieR `J/A+A/650/A201` as `neighbourhood.json`.
- NASA SVS Deep Star Maps 2020 8K -> KTX2 as the far-field backdrop, cross-faded against resolved stars so there is no popping boundary. Delete drei `<Stars>`.
- Proper motion: AT-HYG's vx/vy/vz driving a +/-100,000 year time scrub.
- Rungs 8-9 of the ladder go live.

**Exit.** Fly from Earth to Proxima Centauri continuously. Constellations visibly distort and fall apart on the way out. Star brightness changes physically with camera position. 60 fps with L0+L1 resident and L2 streaming. <= 150 KB of star data before the first interactive frame, <= 3 MB resident. No whole-catalogue download.

### Phase 5 — Deep sky and the galaxy

**Goal.** The Milky Way becomes a place you can be inside and then leave, with every synthetic element labelled as such.

**Work.**
- `scripts/build-deepsky.mjs`: OpenNGC release tag v20260501 (13,970 rows + 64 addendum) -> 335 KB `ngc.bin` with sexagesimal RA/Dec parsed. Derived files under `public/data/deepsky/` with their own LICENSE.
- The 379 nebula outline polygons -> ~1 MB packed Int16 rings. Render as additive filled polygons on the celestial sphere inside the galaxy, fading to sprites past a screen-size threshold. This single layer is what makes the sky look authored.
- hips2fits per-object cutouts on selection (`fov = max(MajAx, 2') * 2.5 / 60` deg), cached in Dexie by (id, survey, fov), with a DSS2 / 2MASS / SDSS / AllWISE survey selector. Watching M51 switch from optical to infrared teaches more than any paragraph.
- Harris 2010: 157 globular clusters (~20 KB JSON), MEASURED.
- Reid+ 2019: ~200 maser parallaxes (~10 KB JSON), MEASURED, with the log-periodic arm fits implemented as code in `src/astronomy/galaxy.ts`, rendered as translucent ribbons badged MODEL and visually tied to the maser points constraining them.
- `scripts/build-galaxy-field.mjs`: ~300k deterministically seeded points from the Reid model (R0 = 8.15 kpc, 3.5 kpc scale length, 300 pc thin-disk height), coloured by an age/metallicity gradient, weighted by Edenhofer 2024 dust. One ~4 MB f32 binary, one additive draw call. Deterministic seeding is non-negotiable or shared links stop reproducing.
- ESO eso1339e as a separately-toggled `artist's impression` overlay with the verbatim credit string. Never the default.
- LMC (50 kpc), SMC (62 kpc), M31 (0.78 Mpc) as resolved objects.
- Three-state MEASURED / DERIVED / ILLUSTRATION badge rendered on every active layer.
- Rung 10 goes live.

**Exit.** Fly from inside the Orion Arm to 100 kpc above the galactic plane and see a Milky Way whose structure is visibly derived from the ~200 masers and 157 globulars drawn alongside it, with the MODEL badge and its three citations one click away. Deep-sky objects are individually selectable with a real telescope cutout in the inspector.

### Phase 6 — Extragalactic and cosmic

**Goal.** Close the ladder at the CMB. Every distance beyond the Local Group declares its kind and its cosmology.

**Work.**
- `src/astronomy/cosmology.ts`: frozen Planck 2018 constants; `distanceModulusToMpc`, memoised Simpson `comovingDistanceMpc(z)`, `lookbackTimeGyr(z)`. Distance modulus used wherever it exists; cosmology only where it does not. Unit-tested at z = 0.01, 0.1, 1, 3, 1089.
- `scripts/build-universe.mjs`: UNGC (~1,400 Local Volume galaxies, TRGB distances, ~250 KB JSON); Cosmicflows-4 table3 (38,053 groups, SGL/SGB already supergalactic, 761 KB at 20 B/rec, with `e_DMav` rendered as radial elongation because line-of-sight error dominates); 2MRS (44,599 galaxies, 624 KB at 14 B/rec, labelled `redshift-space`).
- Render the 2MRS zone of avoidance as an explicit translucent wedge labelled `obscured by the Milky Way - no survey coverage`. Never interpolate across it.
- Planck 2018 SMICA CMB -> equirect KTX2 shell at 14,300 Mpc comoving, labelled `the limit of what can be seen - 13.787 billion years of light travel`, NOT `the edge of the universe`. Invent nothing beyond it.
- Lookback banner past 100 Mly; comoving-distance disclosure past 1 Gly with the H0 = 67.4 vs 74.6 tension surfaced as an informative note rather than hidden; redshift z as a first-class field alongside distance for everything extragalactic.
- Per-rung coverage honesty: `Galaxies brighter than m=15 within 300 Mpc - selection-limited`.
- The grand tour: a 25 s skippable scripted `cameraPath` through all 14 rungs with the ladder thumb sliding, built on the same machinery as the intro and deep links.
- Rungs 11-14 go live.

**Exit.** One continuous, uninterrupted camera flight from 1 m above Tycho crater to the CMB shell, with the scale ladder thumb climbing all 14 rungs and the cosmic address rewriting itself at every transition. Every distance readout names its kind. No layer renders without a provenance badge.

### Phase 7 — Hardening and launch

**Goal.** Hit every budget on real mid-range hardware, close the accessibility and attribution loops, ship.

**Work.**
- Wire `src/core/perf/Governor.ts`: `<PerformanceMonitor>` driving dpr, with a strict degradation order - dpr -> bloom resolution -> star limiting magnitude -> tile detail. Never geometry correctness.
- Ship `src/core/perf/Stats.ts` as a visible View toggle: p50/p95 frame ms, draw calls, triangles, points, estimated VRAM, adaptive-resolution state. It keeps the product honest and it is how every later regression gets caught.
- Profile on the three reference machines (see Risks). Fix whatever misses budget.
- Heavy layers (L3 stars, nebula outlines, 16K Moon colour) become explicit opt-in toggles showing their download cost, gated off by default on touch devices.
- Full attribution audit: every asset in `assetUrls.ts` has licence + attribution + sha256; the Sources affordance renders per-layer attribution only while that layer is visible; CC BY-SA derived-data LICENSE files present for AT-HYG and OpenNGC.
- Full a11y pass with NVDA + VoiceOver + keyboard-only. Verify the announcement text for every object class.
- Visual regression suite: a Playwright screenshot per ladder rung per theme per breakpoint, driven entirely by URLs.
- Rewrite `docs/ARCHITECTURE.md`, `docs/RENDERING.md`, `docs/DATA_AND_COORDINATES.md`, `docs/ROADMAP.md` to describe what was built. Remove the CesiumJS proposal and the PostgreSQL catalogue-API proposal, both of which this plan supersedes.
- Service Worker for offline revisits backed by the Dexie tile cache with an explicit size budget.

**Exit.** All budgets in the Risks section met on all three reference machines. Lighthouse: Performance >= 90, Accessibility >= 95, Best Practices 100. Zero console errors or warnings on a cold load. Every shipped asset has a recorded licence. Docs describe the built system.

## Kill list

- `src/data/constants.ts:19-38` — `explorationDistanceForAu`, `explorationMoonDistance`, `explorationRadiusUnits`. DELETE, not refactor. The three laws were designed in isolation and are mutually inconsistent: computed from the actual code, Jupiter's Callisto reaches 44.58 units while Saturn orbits at 43.34 (the moon system crosses Saturn's orbit), Saturn's Iapetus reaches 61.27 while Uranus orbits at 61.35 (they touch), and the Sun renders at 6.54 units while Mercury orbits at 8.71 — a ratio of 1.33 where the true ratio is 83.2. No fixed power law can guarantee non-overlap across six orders of magnitude.
- `distanceMode` in `src/store/useExplorerStore.ts` and every one of its ~20 call sites. A global toggle that silently multiplies every distance by 14*sqrt(AU) and every radius by ^0.4 is precisely the confusing-scale-jump failure mode; no flagship does it; and two truths per position is incompatible with a single float64 world model.
- `src/astronomy/ephemeris.ts:160-258` `calculateSolarSystemEphemeris` and the `Map<string, BodyState>` type at `:21-34`. Not a slow version of the right design — a different design, where every object it produces is a React-reconciled node. It is also evaluated three times per second from three components with identical arguments (`SolarSystemScene.tsx:50`, `CameraRig.tsx:123`, `Interface.tsx:52`), the third of which needs exactly two scalars out of it.
- `src/astronomy/ephemeris.ts:94-97` `tidalLockQuaternion`. `setFromUnitVectors` produces the minimal-angle rotation, leaving roll about that axis completely unconstrained — so 16 of ~20 moons plus all four notable asteroids have a north pole that points wherever the minimal rotation lands and sweeps around unpredictably as the body orbits. No pole, no obliquity, no libration, and +Z points the chosen face AWAY from the parent.
- `src/components/scene/SolarSystemScene.tsx` — the JSX-per-body scene graph. Fine for 40 objects, catastrophic at 10^4. Every `<group position={state.position}>` gets fresh object identity on each 1 Hz tick, forcing a full reconciliation of the R3F tree.
- `src/components/scene/AsteroidBelt.tsx` — rewrite as GPU-propagated instancing. Beyond the verified first-paint bug (instance matrices written inside `useMemo`, where `meshRef.current` is null during render, so all 4,500 stay at identity until the clock ticks), the whole 360k-triangle loop is recomputed in JS on the main thread with a full `instanceMatrix` re-upload, and `visible` is in the dep array but never read in the body.
- `src/components/scene/PlanetBody.tsx`, `MoonBody.tsx`, `MoonMesh.tsx` — collapse into one data-driven `SphereBody` renderable. Eight bespoke body components become eighty when stars, galaxies and the CMB arrive.
- `src/components/scene/CameraRig.tsx` — rewrite as `AtlasControls`. Beyond the structural issues: `maxDistance = focusRadiusUnits * 12` (`:199-200`) means focusing Earth in physical mode gives `maxDistance = 12` while the Moon is at 60.4 units, so you literally cannot zoom out far enough to see the Moon from Earth; focusing Jupiter gives 131.7 while Callisto sits at 295.5. It also tracks `new Date()` (`:134`, `:174`) while the scene renders `simulationTimeMs`.
- `logarithmicDepthBuffer: true` at `SceneManager.tsx:20`. Writes `gl_FragDepth`, disabling early-Z on every GPU (a measured three.js case went 65 -> 35 fps) and MSAA on some; it fixes only depth, not position; and with per-layer near/far ratios capped at 1e4 there is nothing left for it to fix.
- `drei <Stars count={4000} factor={2.4}>` at `SolarSystemScene.tsx:65`. A uniform random point cloud with no catalogue behind it. In a captured 1600x900 screenshot roughly 70% of the frame is dead black.
- `ambientLight intensity={0.24}` at `SolarSystemScene.tsx:67`. A fake fill that washes out every terminator — the main reason the planets currently look like billiard balls.
- drei `<Html>` in `BodyLocator`. One absolutely-positioned DOM node per label with a per-frame transform write. Will not survive 200 labels, and it is a second, divergent label system with no collision behaviour at all.
- `src/components/ui/DirectoryPanel.tsx` (300 lines). Four `Array.filter().includes()` passes per keystroke, a fresh `AtlasEntity` allocated per match, a per-source `.slice(0, 40)` that silently drops good matches today, every one of 1,251 cities rendered as an unvirtualized DOM button, and a browsable-tree IA that dead-ends at every leaf.
- `src/data/catalog.ts` — a barrel re-export whose only logic is a linear `Array.find`.
- `src/store/useExplorerStore.ts` (flat, 78 lines). Mixes `directoryOpen` with `viewScaleKmPerPixel` and `cameraRangeKm`, which are written from `useFrame` 6.7 times per second each, re-rendering the entire `Interface` tree. `focusStack: string[]` is visit history being used as a breadcrumb, with no notion of hierarchy and therefore no 'up to parent' operation.
- `src/components/ui/LoadingScreen.tsx` (20 lines gating the whole app) and the single `<Suspense fallback={null}>` wrapping the entire scene at `SceneManager.tsx:26`. Nothing renders until the last of 11 MB of JPEG decodes.
- `src/styles/global.css:1` — the `@import` of Google Fonts. Three serialised round trips to two origins before any text paints, pulling six static weights where two variable files would do.
- `--quiet: #626c73`. Measured 3.66:1 on the panel background, failing WCAG AA, and currently carrying layer descriptions, scale-bar units and the entire credit strip at 13 locations in `ui.css`, several at 8-9px.
- `.panel { backdrop-filter: blur(18px) saturate(120%) }` at `ui.css:30-38`. Text contrast collapses over a lit Blue Marble, and it forces a composited readback of the WebGL layer every frame the canvas changes — which is every frame.
- `leva@0.10.1`. Verified: zero imports anywhere in `src/`.
- `Interface.tsx:66-70` — `setInterval(() => setSimulationTime(Date.now()), 1000)`. Overwrites the simulation clock every second, making pause, scrub and rate control structurally unreachable.
- `Interface.tsx:182` and `:215` — hand-written disclosure strings that contradict the code. `:182` claims body sizes are true to scale while `constants.ts:37` applies `^0.4` (the Sun shows at 6.5 Earth radii instead of 109.2, a 17x understatement); `:215` calls the orbit paths 'reference circles' when `ephemeris.ts:314-328` samples the real HelioVector path and its own docstring says 'not an idealized circle'.
- `nodeDeg: 0, periapsisDeg: 0` at `src/data/asteroidBelt.ts:136-137` for Ceres, Vesta, Pallas and Hygiea, while `:160` cites JPL SBDB as the source. Ceres' real ascending node is ~80.3 deg and its argument of periapsis ~73.6 deg.
- The CesiumJS surface-descent proposal in `docs/ARCHITECTURE.md` and the PostgreSQL catalogue/search/ephemeris API proposal. Both are superseded: HiPS-baked imagery plus FITS-derived DEMs cover surface descent through one code path, and VizieR/SIMBAD TAP at build time covers the catalogue work.

## Keep list

- `scripts/build-earth-countries.mjs`, `build-earth-coastline.mjs`, `build-earth-places.mjs`, `build-moon-craters.mjs` (233 lines total) — KEEP AS-IS and generalise. Offline shapefile -> typed-array-binary ETL writing to `public/data/<domain>/` is exactly the right pattern, and it is the template for all eleven new build scripts.
- `src/astronomy/orbit.ts` (71 lines) — KEEP UNCHANGED. `keplerianPosition` and `solveEccentricAnomaly` are a clean, correct Newton solve (12 iterations, 1e-10 tolerance). Nothing to improve.
- `src/astronomy/ephemeris.ts:45-66` `bodyOrientation` — KEEP THE MATH, move it off the per-frame path into the worker. The IAU pole -> prime-meridian -> `Matrix4.makeBasis` construction is correct, and it is the template for fixing `tidalLockQuaternion`.
- `src/data/coordinates.ts::latLonToCartesian` — correct and reused everywhere surface features are anchored.
- `src/components/scene/SurfaceLabelField.tsx` (271 lines) — the best-engineered file in the repo. Screen-space AABB declutter, tier bands, pixel-constant scaling, single-projection loop. REFACTOR into `src/core/labels/LabelEngine.ts`: add a `Map<id, index>` (replacing the `items.find()` at `:202` that costs ~134,000 string comparisons per frame) and a fixed label pool (replacing mount/unmount of troika `<Text>`, each of which allocates an SDF atlas region). Everything else generalises unchanged to stars and galaxies.
- The curated editorial content in `src/data/planets.ts` (231 lines), `moons.ts` (463), `sun.ts` (25), `asteroidBelt.ts` (163) — the prose, the `facts[]` arrays, the per-object `source` attributions. THIS IS THE PRODUCT. NASA Eyes and Solar System Scope do not have it. Its container changes (it gains `provenance`, `related`, `distanceKind`, `orbitColour`); the writing survives verbatim. Draw the line explicitly: hand-written TS for anything with editorial prose (~10^3 objects), binary tiles for anything counted in thousands.
- `src/styles/ui.css` (1,299 lines) — KEEP THE STRUCTURE, replace the tokens. It is a coherent design language with sensible component decomposition; the problems are the colour values, the font choices and the `backdrop-filter`, all of which are find-and-replace changes against the new token set.
- `docs/` (645 lines across five files) — KEEP, and USE AS THE SPEC. `docs/ARCHITECTURE.md:92-102` already mandates double-precision canonical state and states that 'the camera never carries universe-scale coordinates in Three.js Vector3 values'; `docs/RENDERING.md:23-33` already lists floating-origin rebasing as requirement 1 and prescribes separate scenes/passes for incompatible ranges; `docs/DATA_AND_COORDINATES.md` already mandates HEALPix NESTED for sky catalogues and immutable pinned provider releases; `docs/PRODUCT_SPEC.md` already commits to 'truth over spectacle' and honest coverage disclosure. The design was right and the code diverged from it. Start the overhaul from these documents, then rewrite them in Phase 7 to describe what was built.
- `src/data/remoteAssets.ts` (86 lines) — KEEP THE IDEA, fix the shape. The dedupe/inflight/cache pattern is right; `useRemoteBinary` must return `ArrayBuffer` instead of hardcoding `Float32Array` (star tiers are interleaved Uint8/Int16 records), and the `forceRender` counter must go away in favour of the `TileStreamer` for anything above a few hundred KB.
- `astronomy-engine@2.1.19` — KEEP as the solar-system ephemeris source. VSOP87/ELP-grade accuracy, zero network dependency, MIT, already correct. The fix is where it runs (worker, once per frame, float64 SI output), not what it is.
- `dexie@4.4.5` — currently unused, but KEEP. It becomes the IndexedDB tile cache for star tiles, deep-sky cutouts and HiPS imagery, which is its obvious job.
- `zoomToCursor` on the existing OrbitControls — the single most important zoom ergonomic and the reason Google Maps' zoom feels right. Carries over to `AtlasControls`.
- The `prefers-reduced-motion` branch at `CameraRig.tsx:146` and the block at `ui.css:1290` — the hook exists and is correct; it just needs a shared easing/duration vocabulary behind it.
- `vite.config.ts`'s `worker: { format: 'es' }` and `build: { target: 'esnext' }` — already correct for the worker-heavy architecture this plan needs.
- The React + TypeScript + Vite + Three.js + R3F + Zustand stack itself. The bottleneck is 1 Hz full-tree reconciliation, 350 MB of uncompressed textures and O(n) scans — none of which a different renderer or framework fixes.

## Risks and budgets

- **Scope explosion kills the solar system before it is finished.** This is the dominant risk: eight researchers produced ~120 high-confidence recommendations and following all of them produces a permanently-unfinished product. MITIGATION: Phase 3 ('Solar system complete') is a hard gate with its own ship-quality bar, and nothing from Phases 4-6 may start before it passes. Four named reductions already taken: no live HiPS tile pyramid (bake at build time instead), no Milliquas, no IllustrisTNG, no WebGPU. If a phase slips, cut Phase 6 contents before cutting Phase 3 polish.
- **The float64 world + layer rewrite is the single point of failure for everything.** Phases 2-7 all sit on `src/core/world.ts` + `Layer.ts` + `Engine.ts`. If that is wrong, the whole plan is wrong. MITIGATION: it is ~600 lines and it is already solved in readable form at `universesimulator.org/src/core/{layer,camera,points}.js`, served unminified with an importmap. Mirror those three files locally and read them before writing a line. Write the precision test FIRST (1,353 km body at 30 AU, assert vertex error < 1 km), then make it pass. Build the layer system against the EXISTING solar system content so Phase 1 is verifiable against a known-good render rather than against new content.
- **Performance budget, with explicit numbers.** Target: 60 fps on an Intel Iris Xe / GTX 1650 laptop at 1920x1080, dpr 1. Frame budget 16.6 ms: scene <= 9 ms, post <= 2.5 ms, JS/UI <= 2 ms, 3 ms headroom. Draw calls <= 250. Triangles <= 2.5M. Points/sprites <= 1.2M. VRAM <= 512 MB desktop / 192 MB mobile. Initial JS <= 350 KB gzip. Data before first interactive frame <= 1.5 MB. Resident data <= 48 MB. First meaningful paint <= 2.0 s on 20 Mbps. GPU upload <= 2 MB per frame. MITIGATION: three reference machines profiled every phase (Iris Xe laptop, M2 MacBook Air, Pixel 7a); the Stats readout ships from Phase 0 as a visible toggle; the Governor's degradation order is fixed (dpr -> bloom res -> star magnitude limit -> tile detail, never geometry correctness); any phase that misses budget does not exit.
- **Texture VRAM is the budget nobody tracks and it is already 70% over.** 11 MB of JPEG on disk decodes to ~350 MB of VRAM with mipmaps today (blue-marble 5400x2700 alone is ~78 MB), and Phase 3 adds ~55 more baked bodies. MITIGATION: KTX2 ships in Phase 0, BEFORE any new textures are baked — UASTC is ~4x and ETC1S ~8x smaller and stays compressed on the GPU, which also cuts sampling bandwidth. LRU eviction by last-used frame with explicit disposal. One 512x256 placeholder per body inline; full map streams only on focus.
- **AT-HYG's CC BY-SA 4.0 is viral on our derived .bin files, and so is OpenNGC's.** The packed binaries are adaptations of the database and inherit share-alike; anyone can demand them under the same terms. MITIGATION: decided up front — accept it. `public/data/stars/LICENSE-DATA.md` and `public/data/deepsky/LICENSE` ship with the data, crediting 'AT-HYG v4.0, David Nash / Astronomy Nexus' + 'ESA/Gaia/DPAC' and 'OpenNGC, Mattia Verga'. `build-stars.mjs` and `build-deepsky.mjs` stay in the repo so the obligation is trivially satisfiable. Critically: derived data lives ONLY under `public/data/`, never inlined into `src/data/*.ts`, so there is no argument about whether application source is an adaptation. Separately, AMNH Digital Universe and CDS DSS2 HiPS (ODbL) are both rejected on licence grounds despite being the obvious first choices.
- **Three upstream APIs send no CORS header, and discovering that at integration time costs a phase.** Verified: JPL `ssd-api.jpl.nasa.gov/sbdb_query.api` and `ssd.jpl.nasa.gov/api/horizons.api` both return 200 with valid data and NO `Access-Control-Allow-Origin`; the NASA Exoplanet Archive TAP service likewise. MITIGATION: 'no third-party host at runtime' is rule zero of the data plan, which turns all three from runtime failures into build-script dependencies. It also makes the COEP `require-corp` header safe, which would otherwise silently block every cross-origin asset.
- **COOP/COEP divergence between dev and production.** `vite.config.ts` sets them under `server.headers`, so they apply in dev only — `SharedArrayBuffer` would work locally and be `undefined` on deploy, the worst possible failure shape. MITIGATION: set the same headers in the production host config in Phase 0, with a boot-time assertion that logs loudly if `crossOriginIsolated` is false, plus a non-SAB fallback path in the simulation worker (`postMessage` with transferables) so the product degrades rather than breaking.
- **Label clutter is a correctness problem, not a polish item.** NASA Eyes already shows it at its own home view — 3I/ATLAS, Psyche, STEREO Ahead, BioSentinel and Euclid all competing near the inner planets with grey text colliding with orbit lines. At 330k stars plus 14k deep-sky objects it is unbounded. MITIGATION: greedy screen-space AABB declutter with a hard importance ordering ships in Phase 1, before any catalogue arrives. Retrofitting declutter is far harder than building it in. `L` toggles labels, `M` toggles markers.
- **Precision at the surface layer.** At `surface` unit = 1 km, a body-centred globe mesh spans +/-6,371 units, giving float32 ULP ~0.76 m — marginal for 1 m terrain features. MITIGATION: terrain patches get their own patch-origin groups (vertices within ~1e2 of their own origin), so only the base globe sphere sits at full body radius, where 0.76 m is invisible. Covered by the Phase 1 precision test extended to a surface case.
- **jsDelivr reports COMPRESSED size for Range requests on .bin/.json.** A tiled loader using Range will silently truncate. MITIGATION: fetch binaries whole; we self-host everything anyway, which sidesteps it entirely, but the build scripts that pull from jsDelivr must not use Range.
- **Codeberg's `/raw/` URL returns a 133-byte Git-LFS pointer** instead of the AT-HYG file, which a naive build script will happily parse as an empty catalogue. MITIGATION: use `/media/branch/main/...`, assert the downloaded byte count against the manifest (athyg_40_reduced_m10.csv.gz = 27,587,896 B), and verify the sha256.
- **Three silent data traps in AT-HYG that each produce a plausible-looking but wrong sky.** (1) `ra` is in HOURS, not degrees — a 15x error. (2) Row id=1 is the Sun, which renders a star at the camera origin. (3) Global int16 quantization degrades the 25 pc shell from 0.76 mpc to ~3 pc of error. MITIGATION: read `x0/y0/z0` directly (verified already ICRS parsecs to 1.6e-06), filter id=1, quantize per distance shell with the radius in the manifest, and add a unit test asserting Sirius lands near (-0.49, -1.75, -1.86) pc.
- **Cosmology seam at the Local Group / supercluster boundary.** CF4's internal scale is H0 = 74.6 while Planck 2018 gives 67.4 — mixing them puts a visible ~10% discontinuity exactly where the user is watching a scale transition. MITIGATION: one frozen `COSMOLOGY` object; distance modulus used directly wherever it exists (CF4, UNGC), cosmology only where it does not (2MRS, high-z). The tension is disclosed in the UI rather than hidden, which turns a bug into a feature.
- **Deleting the exploration mode may be read as a regression by anyone who liked it.** MITIGATION: it is replaced by four things that are each individually more useful — constant-screen-size marker glyphs so nothing is ever invisible, a permanent 'View spans X' readout, a local Compare Sizes tool, and the scale ladder as the actual navigation control. Ship them in the same phase the compression is deleted (Phase 1 + 2), never leave a gap. The honest framing: the old mode made Jupiter's moons cross Saturn's orbit and told the user the Sun was true-to-scale when it was 17x understated.
- **Regression risk from rewriting eight scene components at once in Phase 1.** MITIGATION: the Playwright visual-regression harness lands in Phase 2 but a minimal version (ten fixed camera positions, screenshot diff) goes in at the START of Phase 1 against the current build, so the port is checked against a known-good render rather than against taste. Phase 1 changes precision and structure, NOT content: if a pixel moves for any reason other than true-scale positioning, it is a bug.
