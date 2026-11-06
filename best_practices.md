# OmniAtlas rule catalog

The single source of truth for what a review flags. The `/review-pr` skill
([`.claude/skills/review-pr/SKILL.md`](.claude/skills/review-pr/SKILL.md)) owns the
*workflow*; this file owns the *rules*. When a rule changes, edit this file only.

Every rule has a stable ID. Cite it in findings (`**[BLOCKING][OA-PREC-001]** …`), in
suppressions (`// oa-disable OA-PREC-001 — <reason>`), and on the PR when you want to
argue with one. IDs are never reused or renumbered; a retired rule is marked
**RETIRED** and left in place.

---

## 3.0 Severity and scope

### Severity

| Severity | Means | Blocks merge |
|---|---|---|
| **CRITICAL** | A correctness, precision, data-truth or security defect that reaches users. Wrong positions, a catalogue misattributed, an unbounded fetch, a leak that grows every frame. | Yes |
| **BLOCKING** | Breaks a stated invariant, a public contract, or a quality gate. Will cause a bug or a maintenance failure, just not today. | Yes |
| **WARNING** | Real but contained. Duplication, a missing test for a non-trivial branch, an unclear name at a boundary. | No |
| **SUGGESTION** | Worth doing, safe to defer. Style, naming inside a function, a cleaner formulation. | No |

### Scope — `OA-SCOPE-001`

**Review the diff, not the repository.** Pre-existing debt in a file the PR barely
touched is at most a SUGGESTION, and usually nothing. Reporting repo-wide counts as PR
findings is noise, and noise is how a review stops being read.

Debt is in scope when the PR *moves into* it: extending a function that was already
wrong, copying a pattern that was already a rule violation, or adding the third
instance of a duplication that was previously two.

### Scope — `OA-SCOPE-002`

**Do not flag what the author documented.** The PR description and the invariant
checklist in the template are author intent. If the PR says it is deliberately changing
a contract and explains why, that is a REG finding raised *for confirmation*, not a
violation.

### Scope — `OA-SCOPE-003`

**Evidence, not inference.** Before flagging duplication, grep for the existing
implementation and name it with a path and line. Before flagging a contract change,
grep for the call sites and name them. A finding whose "Fix" is not copy-pasteable is
half a finding.

---

## 3.1 Logic correctness and edge cases — `OA-LOGIC-*`

- **`OA-LOGIC-001`** — Off-by-one, inverted comparison, or wrong operator precedence in
  index maths over an instanced buffer. These are silent: one wrong instance in 300,000
  is invisible on screen and wrong forever.
- **`OA-LOGIC-002`** — Division by a value that can be zero. Distances, radii and
  magnitudes are routinely 0 in this codebase (`radiusMetres` is 0 whenever the
  catalogue records no size), so `x / radiusMetres` is a real `Infinity`, not a
  hypothetical one.
- **`OA-LOGIC-003`** — `Math.log10` / `Math.sqrt` / `Math.acos` reached with an input
  outside its domain. `acos` of a dot product that floating-point error pushed to
  1.0000000001 returns `NaN`, and one `NaN` position poisons a whole bounding sphere.
- **`OA-LOGIC-004`** — An empty-collection path that is not handled: an empty catalogue
  slice, a zero-length typed array, a layer with no nodes, a filter that matched nothing.
- **`OA-LOGIC-005`** — Mutating an array or object while iterating it, including
  `registry` mutation inside a loop over `registry`.
- **`OA-LOGIC-006`** — An async continuation that can outlive what started it, with no
  cancellation check. React StrictMode double-mounts every effect in development and a
  user can navigate away mid-boot; see `forEachSlice`'s `shouldStop`. A decode that goes
  on filling buffers belonging to a disposed engine is this rule.
- **`OA-LOGIC-007`** — A floating-point equality comparison (`a === b`) on a computed
  double. Use a tolerance, and say what tolerance.
- **`OA-LOGIC-008`** — Angle arithmetic that does not wrap: a difference of two
  longitudes, right ascensions or yaws without normalising to (−π, π].

---

## 3.2 TypeScript and React — `OA-TS-*`

- **`OA-TS-001`** — `any`, `as any`, or `as unknown as X` with no comment giving the
  reason. The codebase's existing escapes (`globalThis as { scheduler?: … }`) all carry
  one.
- **`OA-TS-002`** — `@ts-ignore` or `@ts-expect-error` without a reason on the same line.
- **`OA-TS-003`** — A non-null assertion (`!`) on a value the code cannot prove is
  present — `registry.get(id)!`, `array[i]!` with a computed `i`.
- **`OA-TS-004`** — A new public interface field on `SceneNodeHandle`, `AtlasModule`,
  `LayerConfig` or `FrameContext` with no doc comment. Those interfaces are the project's
  API and every existing field is documented.
- **`OA-TS-005`** — A type assertion used to silence a real mismatch rather than describe
  a true one. If the shapes genuinely differ, convert; do not assert.
- **`OA-TS-006`** — A hook called conditionally, after an early return, or inside a loop
  or callback. oxlint's `react/rules-of-hooks` catches most of it; the ones it misses are
  hooks inside a `useMemo` body.
- **`OA-TS-007`** — A `useEffect` with a missing or over-broad dependency array, where it
  changes behaviour: an effect that re-subscribes every frame, or one that never
  re-subscribes when it must.
- **`OA-TS-008`** — A `useEffect` that subscribes, starts a timer, adds a listener or
  begins a fetch with no cleanup return.
- **`OA-TS-009`** — Work in a component body that should be in a `useMemo` and is
  expensive enough to matter: parsing, sorting a catalogue, building a geometry.

---

## 3.3 Precision and the world model — `OA-PREC-*`

This is the section that makes the project possible. Breaking one of these does not look
like a bug — it looks like geometry quietly tearing at some distance nobody tested.

- **`OA-PREC-001`** (CRITICAL by default) — **Vertex data outside ±1e4 of its own object
  origin.** The GPU sees float32. Any geometry whose coordinates exceed roughly 1e4 units
  from its object origin will visibly jitter. Where a catalogue needs a vast distance,
  store a *unit direction* and a *scalar distance* and multiply in the shader — the
  deep-sky buffers (`dsDir` × `dsDist`) are the pattern.
- **`OA-PREC-002`** (CRITICAL by default) — **A physical value with a render fudge folded
  into it.** Positions are float64 metres in SI. Compression, exaggeration and legibility
  scaling are render-space values, kept separate, and visible in the UI. A stored number
  that is neither the catalogue's nor honestly derived from it is this rule.
- **`OA-PREC-003`** — A float64 world quantity downcast to `Float32Array` or
  `THREE.Vector3` before the camera-relative subtraction. The subtraction is what makes
  the number small; doing it after the downcast has already lost the precision.
- **`OA-PREC-004`** — Metres assumed where layer units are meant, or the reverse. Every
  layer has its own `unitMetres`. A conversion that reads `unitMetres` from the wrong
  layer, or skips it, is a silent factor-of-a-million error.
- **`OA-PREC-005`** — A hard-coded unit constant (parsec, light year, AU, kpc) written
  inline rather than taken from `src/data/constants.ts`. Two spellings of a parsec drift.
- **`OA-PREC-006`** — Accumulating a position by repeated `+=` across frames. Error
  compounds; recompute from the epoch.
- **`OA-PREC-007`** — A magnitude computed without saying which it is. Absolute
  (`M = m − 5(log10 d_pc − 1)`) and apparent are both in use and are not
  interchangeable; the variable name or a comment must say.

---

## 3.4 Layers, frames and the camera — `OA-LAYER-*`

- **`OA-LAYER-001`** — A position used across frames without `convertFrame`. ICRF,
  galactic and body-fixed frames are different orientations; mixing them puts objects in
  the wrong part of the sky, which looks plausible and is wrong.
- **`OA-LAYER-002`** — A node registered in one layer but drawn in another, with no
  `alsoDrawnIn` listing the copies. The label engine skips a node whose layer is not
  active, so this makes the object silently unclickable exactly when it is on screen.
  See the `alsoDrawnIn` rationale on `SceneNodeHandle`.
- **`OA-LAYER-003`** — A new layer, or a change to `order`, `unitMetres` or `frame` on an
  existing one, with no explanation of the near/far plane consequences.
- **`OA-LAYER-004`** — Camera distance or near-plane maths that reads `radiusMetres`
  where it needs the drawn size. `radiusMetres` is the catalogue's number and is 0 for a
  sizeless row; `framingRadiusMetres` is where to stop the camera; `drawnRadiusMetres` is
  how big the thing is on screen; `shapeRatio` flattens it. Reading the wrong one of the
  four is a recurring defect in this codebase and each field's doc comment says why.
- **`OA-LAYER-005`** — A scale-ladder rung that becomes reachable without its data, or a
  rung silently hidden instead of greyed. Gaps stay labelled.
- **`OA-LAYER-006`** — Work in `update()` that depends on the camera. `update()` runs
  before camera-dependent work; `preRender()` is where LOD selection, fades and
  camera-derived uniforms belong.

---

## 3.5 Provenance and honesty — `OA-PROV-*`

The product promise. A finding here is CRITICAL unless it is purely cosmetic.

- **`OA-PROV-001`** (CRITICAL) — **An object placed at a distance nobody published.** An
  object with no trustworthy distance belongs on the direction-only shell, drawn as a
  hollow ring. Inventing a plausible distance to make a view look better is the single
  thing this project exists not to do.
- **`OA-PROV-002`** (CRITICAL) — A node whose `provenance` does not match what the code
  actually did: `measured` on a generated position, `derived` on an invented one.
  `measured` / `derived` / `illustration` mean exactly what `src/ui/Inspector.tsx`
  reports them to mean.
- **`OA-PROV-003`** — A measurement and a rendering fact conflated in one field.
  `radiusMetres` stays 0 when the catalogue is silent, even when something must still be
  drawn — that is what `drawnRadiusMetres` and `framingRadiusMetres` are for.
- **`OA-PROV-004`** — A generated or statistical dataset shipped without its `DERIVED`
  badge and statement in the manifest. The Milky Way field says it is a realisation of an
  arm model and not a catalogue of real stars; anything like it must too.
- **`OA-PROV-005`** — A procedurally invented shape, texture or structure not marked
  `illustration` and not stable across sessions. Proxies hash the object's own id so the
  same object looks the same in every shared link.
- **`OA-PROV-006`** — Uncertainty, epoch or coordinate frame dropped on ingest. They are
  first-class fields, not optional metadata.
- **`OA-PROV-007`** — A number shown in the UI with more significant figures than its
  source supports.

---

## 3.6 Registry, picking and labels — `OA-PICK-*`

- **`OA-PICK-001`** (BLOCKING) — **Something newly drawn with no registered node.** Drawn
  implies clickable. `tests/unit/deepsky-clickable.test.ts` pins this for the deep sky; a
  new catalogue module needs its own equivalent.
- **`OA-PICK-002`** — A registered node nothing draws, and no suppression recording why.
  The reverse of `OA-PICK-001`: dead registry entries show up in search and select
  nothing.
- **`OA-PICK-003`** — A duplicate registration of the same physical object across
  catalogues with no dedupe. One object, two catalogue rows, two labels, two click
  targets.
- **`OA-PICK-004`** — A change to label scoring constants (`MAX_MARKED`,
  `DISTANCE_MISMATCH_PENALTY`, `SCORE_FLOOR_BELOW_BEST`, `DESIGNATION_PENALTY`,
  `MARKER_RADIUS`, …) with no measured before/after. These interact; a value tuned for
  one view regresses another, and the failure mode is "most labels disappear at some
  specific camera distance".
- **`OA-PICK-005`** — A change to hover or marker drawing that alters which objects are
  hit-testable. Reveal, glow and hover are presentation; the hit set must not move with
  the pointer. `tests/unit/label-hit-targets.test.ts` pins this.
- **`OA-PICK-006`** — `engine.register` called in `update()` or `preRender()` rather than
  `init()`, without a registry-version guard. Registration is boot work.
- **`OA-PICK-007`** — A node id that is not stable across sessions, or not unique.
  Share URLs carry ids; an unstable id breaks every link that used it.

---

## 3.7 three.js resources and the GPU — `OA-GL-*`

- **`OA-GL-001`** (CRITICAL) — A geometry, material, texture or render target created
  per frame, or per update, and not disposed. This is the leak that grows until the tab
  dies.
- **`OA-GL-002`** — A module that creates GPU resources and has no `dispose()`, or a
  `dispose()` that misses some of them.
- **`OA-GL-003`** — A `BufferAttribute` written without `needsUpdate = true`, or with
  `needsUpdate = true` set every frame when nothing changed.
- **`OA-GL-004`** — An object allocated in a per-frame path: `new THREE.Vector3()`,
  `new THREE.Matrix4()`, an array literal or a closure inside `update`, `preRender` or a
  raycast loop. Hoist to a module-level scratch.
- **`OA-GL-005`** — A shader uniform updated from the CPU every frame when the value
  could be derived in the shader, or vice versa.
- **`OA-GL-006`** — A draw call added per object where instancing is the established
  pattern. Catalogue content is instanced; a new per-object mesh for catalogue content
  needs a reason.
- **`OA-GL-007`** — A new material that does not say how it interacts with the
  layer-by-layer composite (depth cleared between passes, colour preserved) when it
  blends or writes depth unusually.
- **`OA-GL-008`** — A texture loaded at full size when a smaller mip or a compressed
  format would do, in a path that runs at boot.

---

## 3.8 Data, assets and loading — `OA-DATA-*`

- **`OA-DATA-001`** (CRITICAL) — An asset URL built by string concatenation instead of
  `assetUrl()`. The build content-hashes every file; a hand-built path is a guaranteed
  404 in production and works fine in development, which is the worst combination.
- **`OA-DATA-002`** — A `fetch` with no `response.ok` check, or no error path at all.
- **`OA-DATA-003`** — A new dataset shipped without its licence file beside it in
  `public/data/<set>/`, its terms in the manifest, and a row in the README table.
- **`OA-DATA-004`** (CRITICAL) — A dataset whose terms do not permit redistribution.
  Check before adding, not after.
- **`OA-DATA-005`** — A binary decode over more than a few thousand records that does not
  go through `forEachSlice`. Anything over 50 ms is a long task; a phone is four to six
  times slower than the desktop you measured on.
- **`OA-DATA-006`** — A decode whose record layout is hard-coded in two places — the
  build script and the reader — without the manifest describing it. The manifest is the
  contract between `scripts/build-*.mjs` and the module.
- **`OA-DATA-007`** — A boot-blocking fetch for data that could be deferred until its
  layer is reachable.
- **`OA-DATA-008`** — A `build-*.mjs` change that alters an output format without
  bumping what the reader checks, or without regenerating the committed file.
- **`OA-DATA-009`** — A dataset added to `public/` large enough to move the cold-boot
  number, with no mention of the cost. See [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

---

## 3.9 State and UI — `OA-UI-*`

- **`OA-UI-001`** — A Zustand store subscription that selects the whole store, or an
  object literal, causing a re-render every frame. Select the narrowest slice.
- **`OA-UI-002`** — Per-frame render state kept in React state rather than on the viewer.
  React is the chrome; the engine owns the frame.
- **`OA-UI-003`** — A new view parameter that is not round-tripped through
  `src/state/urlState.ts`, where it is part of the shareable view. The URL carrying the
  whole view is a feature, and a parameter that falls out of it is a half-working link.
- **`OA-UI-004`** — A URL parameter read without validation. Share URLs are untrusted
  input: a `d` of `NaN` or a `pitch` of `1e308` must not be able to break boot.
- **`OA-UI-005`** — An interactive element with no accessible name, or a keyboard
  shortcut added with no entry in the README controls list.
- **`OA-UI-006`** — A keyboard handler that fires while the user is typing. Every
  existing handler checks `typing` first.
- **`OA-UI-007`** — A panel or overlay that does not participate in the existing `Esc`
  ordering (top panel, then selection).

---

## 3.10 Performance — `OA-PERF-*`

- **`OA-PERF-001`** — Work added to the per-frame path with no measurement. The frame
  budget is 16.7 ms and the whole CPU frame currently sits at 2.5–3.1 ms median. A PR
  that adds per-frame cost states the before and after.
- **`OA-PERF-002`** — An O(n) scan over a catalogue per frame where an index, a spatial
  structure or a cached result would do.
- **`OA-PERF-003`** — A synchronous task over 50 ms anywhere in boot.
- **`OA-PERF-004`** — A `console.log` left in a per-frame or per-record path.
- **`OA-PERF-005`** — A layout-thrashing read (`getBoundingClientRect`, `offsetWidth`)
  inside a frame loop.

---

## 3.11 Styling and accessibility — `OA-A11Y-*`

- **`OA-A11Y-001`** (BLOCKING) — A text colour that cannot clear WCAG AA against its
  surface. `npm run lint` runs `scripts/check-contrast.mjs` over `src/styles/tokens.css`;
  a new token must pass it, and the comment's stated ratio must be the real one.
- **`OA-A11Y-002`** — A hard-coded colour in a component instead of a token from
  `tokens.css`. Hard-coded colours are invisible to the contrast checker.
- **`OA-A11Y-003`** — A focus style removed without replacement.
- **`OA-A11Y-004`** — A new control that is unreachable by keyboard.
- **`OA-A11Y-005`** — A layout that breaks below 768px. The header has already overflowed
  once at 375px; check the narrow case.
- **`OA-A11Y-006`** — Motion or flashing with no `prefers-reduced-motion` path.

---

## 3.12 Code quality and reuse — `OA-QUAL-*`

- **`OA-QUAL-001`** — A re-implementation of something `src/core/world.ts`,
  `src/core/names.ts`, `src/data/constants.ts` or `src/format/` already does. Name the
  existing one with a path and line.
- **`OA-QUAL-002`** — A third copy of a pattern that was already duplicated. Two is
  tolerable; three is a helper.
- **`OA-QUAL-003`** — A function doing more than one job at more than one level of
  abstraction, where splitting is obvious and cheap.
- **`OA-QUAL-004`** — Dead code: an unused export, a parameter nothing passes, a branch
  nothing reaches.
- **`OA-QUAL-005`** — A magic number in maths with no name and no source.
- **`OA-QUAL-006`** — A name that does not say its unit where the unit is ambiguous.
  `distance` is not a unit; `distancePc` and `radiusMetres` are.
- **`OA-QUAL-007`** — A second linter, formatter or config added alongside the existing
  ones. oxlint and `.oxlintrc.json` are it.
- **`OA-QUAL-008`** — A dependency added for something a few lines of local code would
  do, or added without saying what it costs in bundle size.
- **`OA-QUAL-009`** — A `catch` that swallows. Either handle it, or let it propagate, or
  record it the way `engine.failedModules` does.

---

## 3.13 Comments and documentation — `OA-DOC-*`

This codebase's long rationale comments are an asset. They are also a liability the
moment one of them stops being true.

- **`OA-DOC-001`** (BLOCKING) — **A comment that is now false.** A comment that names its
  own consumer, its own caller, or a count, and the PR changed that, and the comment did
  not change. A confidently wrong comment is worse than none.
- **`OA-DOC-002`** — A non-obvious decision with no *why*. Comments here explain why;
  what is in the code.
- **`OA-DOC-003`** — A new module with no header comment saying what it is, what it is
  not, and what it is honest about.
- **`OA-DOC-004`** — A behaviour change not reflected in `docs/` where `docs/` describes
  that behaviour, or in the README where the README does.
- **`OA-DOC-005`** — A new keyboard shortcut, URL parameter or control not added to the
  README's controls list.
- **`OA-DOC-006`** — A count, measurement or benchmark quoted in a comment or doc with no
  date or source, where it will go stale.

---

## 3.14 Regression and contract changes — `OA-REG-*`

Flag these even when intentional — the author confirms, the reviewer does not guess.

- **`OA-REG-001`** — A change to an exported signature in `src/core/` with call sites not
  all updated. Grep and list them.
- **`OA-REG-002`** — A field added to, removed from, or re-meant on `SceneNodeHandle`,
  `AtlasModule`, `LayerConfig` or `FrameContext`.
- **`OA-REG-003`** — A node id, designation key or search key changed. Share URLs carry
  these; changing one breaks every existing link.
- **`OA-REG-004`** — A URL parameter renamed, removed, or given a new meaning, with no
  backward-compatible read of the old spelling.
- **`OA-REG-005`** — A data file format changed without the reader, the manifest and the
  committed file all moving together.
- **`OA-REG-006`** — A default changed: a layer's `unitMetres`, a scoring constant, a LOD
  threshold, a fade distance.
- **`OA-REG-007`** — Behaviour removed or narrowed with no note. Something that used to
  be clickable, labelled, searchable or reachable and now is not.
- **`OA-REG-008`** — A test deleted or weakened. Say which failure it used to catch and
  why that failure is no longer possible.
- **`OA-REG-009`** — A dependency major version bumped with no note on what changed.
  three.js in particular moves its own contracts.

---

## 3.15 Tests — `OA-TEST-*`

- **`OA-TEST-001`** — Non-trivial new maths, decode or scoring logic with no unit test.
  "Non-trivial" means it could be wrong in a way reading it would not reveal.
- **`OA-TEST-002`** — A bug fix with no test that fails without the fix. Say which test,
  and what it asserts.
- **`OA-TEST-003`** — A test asserting an implementation detail (a regex over source
  text, an internal call count) where a behavioural assertion is available. Source-text
  assertions exist in this suite and they break on every refactor; adding more needs a
  reason.
- **`OA-TEST-004`** — A test with no failure it protects against. A test that cannot fail
  is cost with no cover. Do not demand a test merely because a PR is a fix or adds a
  file — existing coverage can satisfy the gate.
- **`OA-TEST-005`** — A test duplicating existing coverage. Name the existing test and
  recommend extending it instead.
- **`OA-TEST-006`** — A test depending on wall-clock time, `Math.random`, network, or
  test execution order.
- **`OA-TEST-007`** — A new catalogue module with no drawn-implies-clickable test.
  See `OA-PICK-001`.
- **`OA-TEST-008`** — A fix whose verification was never actually run. The PR says what
  was executed and what it showed.

---

## 3.16 Security and supply chain — `OA-SEC-*`

- **`OA-SEC-001`** (CRITICAL) — A secret, token or key committed. There is no backend and
  there should be no secret; one appearing is a mistake worth stopping everything for.
- **`OA-SEC-002`** — `innerHTML`, `dangerouslySetInnerHTML`, or `eval` on any value
  derived from a URL parameter, a dataset or a fetch.
- **`OA-SEC-003`** — A new runtime network call to a third-party origin. The app serves
  from its own static files; a new origin is a privacy and availability decision, not an
  implementation detail.
- **`OA-SEC-004`** — A dependency added from an unfamiliar publisher, or with a
  postinstall script.
- **`OA-SEC-005`** — Unbounded input: a fetch with no size expectation, a decode that
  trusts a length field from the file it is decoding.

---

## 3.17 Valid exceptions — do NOT flag

- `any` or a cast **with** a stated reason, especially at a three.js or browser-API
  boundary where the published types are wrong.
- A deliberate `illustration`-marked invention — proxy shapes, the galaxy field, imagined
  systems. Marked and stable is the contract; invention itself is not a defect.
- A magic number **with** a cited source (a paper, a catalogue, an IAU constant).
- Per-frame allocation in a path that provably runs once per anchor change rather than
  per frame.
- A long comment. Length is not a finding here; falseness is (`OA-DOC-001`).
- A source-text assertion in `tests/` that predates this catalog.
- Pre-existing debt in a file the PR only brushed — see `OA-SCOPE-001`.
- A format or layout difference. There is no formatter in this project; do not
  hand-review whitespace.
