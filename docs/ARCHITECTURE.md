# System architecture

This describes what is built. The reasoning behind the decisions, including the
alternatives that were rejected, is in [OVERHAUL_PLAN.md](OVERHAUL_PLAN.md).

## The problem this architecture exists to solve

An atlas that runs from a crater floor to the cosmic microwave background spans about
thirty orders of magnitude. A float32 vertex attribute carries roughly seven significant
digits, so a single scene graph cannot hold that range: at Neptune's orbit, expressed in
the Earth-radius units the first version used, one unit in the last place is about
535 km — larger than several of the moons being drawn. At one parsec the error reaches
about a billion kilometres.

Two mechanisms answer this, and almost everything else follows from them.

**One float64 world model.** Every canonical position in the product is a `Vec3d` in SI
metres, double precision, in a named reference frame. Nothing outside the renderer holds
a position in render units.

**Render layers.** Six scenes, each with its own unit, origin, frame and camera. Each
layer's camera is placed at `(cameraWorld − layer.origin) / layer.unitMetres`, computed
in float64 and downcast only at the end. The GPU therefore only ever sees small
camera-relative numbers. This is the floating origin.

Three.js makes the second half of this free: it computes `modelViewMatrix` on the CPU in
JavaScript doubles and downcasts only the product, so object *origins* may be arbitrarily
large. The constraint that remains is on vertex buffers — every geometry's coordinates
must stay local to its own object origin. A body is a unit sphere scaled by its radius; an
orbit curve is generated relative to its central body.

## Layout

```
src/
├── core/            the engine. No React, no JSX.
│   ├── world.ts         Vec3d float64 metres; ICRF / ecliptic / galactic / supergalactic
│   ├── Layer.ts         unit + origin + frame + scene + camera; the per-frame rebase
│   ├── Engine.ts        module lifecycle; the ordered far-to-near composite
│   ├── AtlasViewer.ts   renderer, controls, animation loop, UI snapshot
│   ├── camera/          AtlasControls: log zoom in altitude, van Wijk-Nuij flyTo
│   ├── render/          SphereBody, PostStack, orientation
│   └── labels/          LabelEngine: the 2D overlay, markers and declutter
├── astronomy/       pure float64 maths. No THREE import. Unit-tested.
├── modules/         content. init / update / preRender / dispose, failure-isolated.
├── data/            catalogue records, object classes, the scale ladder
├── state/           Zustand stores for UI state only
├── ui/              React chrome. Never touches the scene graph.
└── format/          units and distance formatting
scripts/            build-time ETL. Third-party data is ingested here, never at runtime.
tests/unit/         vitest
```

## The six layers

| order | id | unit | origin | frame | contents |
|---|---|---|---|---|---|
| 50 | `cosmic` | 1 Mpc | observer | supergalactic | galaxy groups, large-scale structure |
| 40 | `galactic` | 1 kpc | galactic centre | galactic | the Milky Way disc, globulars, Local Group |
| 30 | `stellar` | 1 pc | Sol | ICRF | stars, constellations, deep-sky objects |
| 20 | `helio` | 1 AU | Sun | J2000 ecliptic | Sun, planets, moons, orbits, small bodies |
| 10 | `system` | 1000 km | active body | ICRF | reserved for per-planet detail |
| 0 | `surface` | 1 km | active body | ICRF | reserved for terrain |

Layers are rendered from the largest order to the smallest, with the depth buffer cleared
between passes and the colour buffer preserved, so near layers composite over far ones.
A layer whose camera distance falls outside its band is skipped entirely.

The whole solar system lives in one layer rather than being split across `helio`,
`system` and `surface`. It fits: Earth's radius is 4.3e-5 AU, and float32 resolves that to
well under a metre, because the geometry is local to the body's own origin. The near
layers exist for terrain work that is not yet built.

### A note on the depth buffer

`logarithmicDepthBuffer` is on, which the overhaul plan argued against. Layering solves
*position* precision and that is why it is here, but it does not solve *depth* precision
within a single layer, and the solar system is the hard case: hovering above Earth while
the Moon is still in the same pass needs a near/far ratio around 1e7. Splitting them into
separate passes would mean drawing bodies twice and hiding one copy. Log depth costs
early-Z rejection, which matters when a scene is fragment-bound; this one is not. The
stats overlay reports frame time so the assumption stays falsifiable.

## Modules

Content is a plain object, not a React tree:

```ts
interface AtlasModule {
  id: string
  init(engine: Engine): Promise<void> | void
  update?(ctx: FrameContext): void      // move things
  preRender?(ctx: FrameContext): void   // camera-dependent LOD, fades, uniforms
  dispose?(): void
}
```

Modules load concurrently under `Promise.allSettled`, so one failing never costs the user
the rest of the atlas; failures are recorded and surfaced in the UI. Each registers its
selectable objects in `engine.registry`, which is what feeds search, labels, picking and
the cosmic address.

`update` runs before the layers rebase and `preRender` after, so camera-dependent work
always sees a final camera. Mixing them produces a one-frame lag in every LOD decision,
which reads as shimmer.

## Scale honesty

The previous version had an "exploration" mode that compressed distances by `14·√AU` and
radii by a `^0.4` power law. It is gone, not softened. The laws were provably
self-inconsistent — Jupiter's compressed moon system crossed Saturn's compressed orbit —
and the UI string describing them contradicted what the code did.

Everything renders at true scale. Four instruments replace the compression:

- **Constant-size marker glyphs.** Below about two pixels of true angular size, the mesh
  fades out and a hairline ring of fixed screen size fades in. The ring is visibly
  chrome — unlit, never shaded — so it does not read as the body. As you approach, the
  body grows to fill its own marker, which teaches the real angular size.
- **A live "view spans X" readout.** The honest replacement for a compression toggle: it
  reports the scale instead of distorting the scene to make the scale comfortable.
- **The scale ladder**, a logarithmic rail of fourteen named rungs with a marker tracking
  the current view span. Rungs with no content yet are greyed, not hidden.
- **Light-travel time** on every distance past a light-second.

## State

Nothing written per frame is React state. The viewer publishes a throttled snapshot at
10 Hz; the camera, the ephemeris and the scene graph never enter a reconciler. The
previous version called the ephemeris three times a second from three components and
re-rendered the whole tree on each tick.

## Data

Every third-party dataset is ingested at build time by a script in `scripts/`, which
emits a binary plus a manifest recording record count, field order, dtypes, byte offsets,
dequantization formulae, coordinate frame, epoch, units, source URL, source version,
retrieval date and licence. Nothing is fetched from a third-party origin at runtime,
which is what makes the COEP header safe and removes CORS as a failure class.

Binaries are **struct-of-arrays** — all of field A, then all of field B. Reading one as
interleaved pairs produces geometry that looks plausible and is entirely wrong; it
happened once, to the constellation figures, and the resulting web of lines between
unrelated stars was convincing enough to need a manifest check to disprove.

See [DATA_AND_COORDINATES.md](DATA_AND_COORDINATES.md) for the datasets themselves.

## What is deliberately not here

- **CesiumJS.** The earlier plan proposed it for surface descent. A second globe engine
  means a second camera model, a second coordinate system and a hand-off bug surface.
  Terrain will be displaced patches on our own mesh in the `surface` layer.
- **A backend.** There is no catalogue API, no PostgreSQL, no tile service. Everything is
  static files on a CDN. This is not a scaling compromise — a competitor ships 2.5 million
  stars and 630,000 galaxies with no backend at all.
- **WebGPU.** `@react-three/postprocessing` does not run on `WebGPURenderer`, custom
  `ShaderMaterial` support is incomplete, and adapter acquisition is still unreliable on
  Linux and Android. The one thing it would buy — compute culling — is unnecessary when
  the spatial structure is precomputed offline.
