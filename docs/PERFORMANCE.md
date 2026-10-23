# Network cost of a cold boot

Measured against the deployed site at `omniatlas.wasay.dev` on 2026-10-22, Vercel edge,
cache warm at the CDN, browser cache cold. Numbers are `PerformanceResourceTiming`
`transferSize` unless stated otherwise, so they are bytes on the wire after content
encoding, not bytes on disk.

**A cold boot costs 250 requests and 19.84 MB.** Decoded, the same payload is 24.46 MB,
so brotli is already working on everything that can be compressed. A *refresh* costs the
same 250 requests again, which is the part users notice.

The three causes below are independent of one another. They are listed in the order that
gives the most relief per unit of work, which is not the order of how many bytes each
one accounts for.

## Where it goes

| Group | Requests | Transfer | Decoded |
|---|---:|---:|---:|
| `textures/planets/` | 9 | 3.54 MB | 3.53 MB |
| `data/galaxy/` | 5 | 3.54 MB | 3.88 MB |
| `textures/earth/` | 2 | 3.24 MB | 3.24 MB |
| `textures/moon/` | 2 | 2.03 MB | 2.02 MB |
| `data/stars/l2/` | 186 | 1.91 MB | 2.37 MB |
| `data/smallbodies/` | 3 | 1.83 MB | 3.18 MB |
| `textures/moons/` | 10 | 1.12 MB | 1.12 MB |
| `data/universe/` | 6 | 0.79 MB | 1.70 MB |
| `data/deepsky/` | 7 | 0.75 MB | 1.22 MB |
| `data/stars/` (L0, L1, names, constellations) | 6 | 0.69 MB | 1.08 MB |
| `assets/` (JS, CSS, fonts) | 14 | 0.41 MB | 1.12 MB |

Two things stand out. **Textures are 9.93 MB, half the payload**, and being JPEG they are
the one group brotli cannot help. **The application itself is 0.41 MB**, two per cent of
the transfer: nothing here is a bundling problem.

## 1. Caching (done)

> Implemented. Content hashing in `scripts/hash-assets.mjs`, resolution in
> `src/data/assetUrl.ts`, headers in `vercel.json`.

The original diagnosis was that there was no `vercel.json`, so every response took the
platform default — Vercel documents it as `public, max-age=0, must-revalidate`, which
matches what the site served — including `assets/index-*.js`, a content-hashed filename
whose bytes can never change. A refresh therefore re-issued all 250 requests.

The fix that first suggested itself, a long `max-age` on those paths, is wrong, and it is
worth recording why so nobody reaches for it again. **A long cache and guaranteed
freshness cannot both be had from headers on a stable filename.** A one-year `immutable`
on `/textures/moons/triton.jpg` means every browser and every edge keeps the old bytes
for a year unless something purges them. Vercel's own documentation says so for exactly
the case of a CDN in front:

> If you serve Vercel through your own CDN, purge it there too. The `410` block covers
> Vercel's CDN, but your CDN may hold the asset with its original one-year immutable
> cache header until you purge it.

Purging is a thing a human must remember, per layer, forever, and the failure mode is
silent and user-visible.

So the filenames became content-addressed instead. `scripts/hash-assets.mjs` runs after
`vite build`, renames every file under `dist/data` and `dist/textures` to carry an
8-character SHA-256 prefix of its own contents, and writes `dist/asset-manifest.json`
mapping the logical path to the deployed one. `src/data/assetUrl.ts` loads that manifest
with a top-level await and resolves paths at the point they become requests.

Three properties follow, all verified against a real build:

1. **The hash is the content.** All 257 filenames match `sha256(bytes)[:8]`.
2. **An unchanged file keeps its URL.** Rebuilding with no source change produces a
   byte-identical manifest, so a deploy invalidates nothing it did not change.
3. **Changed bytes produce a new URL.** One appended byte moved `triton.jpg` from
   `019aacfe` to `443f3fd9`.

Together those mean a deploy is a set of URLs nothing has ever requested, and the
superseded ones are never asked for again. No purge API, no TTL tuning, correct across
arbitrarily many cache layers — which is the property that makes a second CDN safe to put
in front rather than a second thing to invalidate.

`vercel.json` then gives `/assets/`, `/data/` and `/textures/` a year of `immutable`, and
holds `index.html`, `/asset-manifest.json` and `/favicon.svg` at `max-age=0,
must-revalidate`. Those three are the entry points: they are how a client discovers that
the hashes have changed, and caching any of them pins a whole deploy.

**Effect: a refresh drops from 250 requests to about 2.** The cold boot is unchanged —
caching cannot help a first visit, and the items below are what do.

### Why `assetUrl` resolves at the request, not the declaration

The catalogue keeps readable paths (`textureUrl: '/textures/moons/triton.jpg'`) and the
modules keep their `DATA` constants. Only the handful of places where a path becomes a
request call `assetUrl()`: each module's `fetchJson`/`fetchBinary` helper, the six direct
fetches in the stars module, `useRemoteJson`/`useRemoteBinary`, and `loadTexture` in
`SphereBody`. A missing manifest entry returns the path unchanged and warns once, so the
failure degrades to the pre-hashing behaviour rather than a guaranteed 404.

`tests/unit/asset-paths.test.ts` guards the indirection: it checks that every literal
asset path in `src/` names a file that exists in `public/` and is non-empty. That used to
fail at build time and now would not, because the fallback is forgiving.

## 2. The star tier was 186 requests (done)

> Implemented. Packing in `scripts/build-stars.mjs`, loading in
> `src/modules/stars/index.ts`.

The deep star tier was 192 HEALPix chunks under `data/stars/l2/`, and `loadDeepTier`
fetched all of them unconditionally on every boot, eight at a time, concatenating the lot
into a single `Float32Array` and a single instanced mesh. The module said so itself:

> All 192 are merged into one instanced mesh rather than 192 of them: the whole set is
> under 3 MB, and one draw call for a third of a million stars is the entire point of the
> instanced-quad approach.

So the chunking bought nothing at runtime. There was no frustum test and no distance gate
to preserve: 192 files were downloaded to build exactly one object, in every view, every
time, for 74 per cent of the request count and 10 per cent of the bytes.

They are now one file. `l2.bin` is those same chunk blocks laid end to end, and
`chunks[].byteOffset` in `l2/index.json` says where each begins.

**One wrinkle worth knowing about.** A record is 9 bytes (`int16 x y z` plus `uint8 magu
ciu flags`), so a chunk holding an odd number of records is an odd number of bytes long,
and 95 of the 192 are. The loader reads each block's `int16` fields in place and
`Int16Array` throws on an odd `byteOffset`, so every block starts on a 2-byte boundary and
odd blocks are followed by one pad byte. Total padding is 95 bytes against 2.4 MB.

Verified by decoding all 282,103 stars from the old per-pixel files and from the packed
file and hashing the result: both give
`afced15fb9a2c84aea185bb1ceb4b9a3ff2c7e6ab2236d29260e86e450edfdbf`. Byte-identical input
to the renderer, not merely the same count.

**Effect: a cold boot drops from 250 requests to 74.** Bytes are unchanged, which is the
point: this trades nothing away.

If per-tile streaming is ever wanted, it should be driven by the camera and cut by
distance shell rather than reinstated wholesale. At 2.4 MB for the entire tier it is not
obvious that it would pay for its own complexity.

## 3. Textures were half the bytes (done)

> Implemented. Encoding recorded in `DATA_AND_COORDINATES.md`, deferral in
> `SphereBody.requestTextures` and `SolarModule.preRender`.

Textures were 9.93 MB of the 19.84 MB, and being JPEG they were the one group brotli
could not touch. Two independent levers, both taken.

**Re-encoded to WebP.** 10.90 MB to 4.81 MB across the set, 56 per cent. The saving
tracks the imagery rather than the file size — Neptune 93 per cent, Uranus 89, Saturn 84,
all smooth low-detail maps that JPEG's 8x8 blocks handle badly — and two files, Callisto
and Enceladus, came out *larger* and are still JPEG. The rule is per file, not per format.

**Deferred until a body is worth looking at.** Every `SphereBody` was constructed during
`SolarModule.init` and `loadTexture` fired from the constructor, so all 28 maps were
fetched before the first frame regardless of where the camera was. At the default view,
about twenty of those bodies are under a pixel and the renderer is drawing them as marker
glyphs; the catalogue colour is all they show anyway.

The map slot is now held from the first frame by a one-pixel `DataTexture` in the body's
own colour, and the real map replaces it in place. That detail is load-bearing: leaving
the slot `null` and assigning later would flip the `USE_MAP` shader define and recompile
the program on the frame a body comes into range, which is exactly when the camera is
moving toward it. It would also break the surface shaders that sample `map` — the
unimaged fill and the map gain — which must be valid from the first compile.

`SolarModule.preRender` already computed each body's apparent radius in pixels for the
mesh-versus-glyph cull, so the fetch rides on that number. It fires at 3 px, which is far
below legibility on purpose: the threshold is a lead-time budget against the network, not
a legibility one. A body that only crossed it when a map became *useful* would pop.

A size test alone is not enough, because a flight can begin with its destination
invisible. The anchor and the body being left behind are therefore always requested, which
covers the case the size test cannot. Measured on a Sun to Neptune flight: `neptune.webp`
was requested 2.2 s after the Sun's, at the instant the flight started and long before
arrival.

The ring maps are deliberately still eager. `saturn-ring.webp` is 5 KB and is loaded from
`surfaceShader`, a pure function with no access to the instance; deferring it would mean
threading the body through a helper that has no other reason to know about one.

**Effect: 28 textures at boot to 2** (the Sun, as focus, and the ring), and 9.93 MB to
about 0.2 MB. Bodies load their maps as the camera reaches them.

## 4. The far-scale datasets now wait (done)

> Implemented. `layerApproaching` in `src/core/Engine.ts`, used from the galaxy and
> cosmos modules' `preRender`.

`galaxy/field.bin` is 3.5 MB of Milky Way disc points and `universe/2mrs.bin` is 0.6 MB
of redshift-space galaxies. Neither means anything at a view narrower than its own rung,
and both were fetched during module init, before the first frame, for every visitor
including the ones who never leave the inner system.

Both now wait for `layerApproaching`, which asks whether the view span has come within a
decade of the span band that draws the layer. The margin is the point: fetching when a
layer goes ACTIVE is too late, because the download then happens while the content is
already wanted, which is a hole in the view rather than a saving. The test sits above the
`if (!layer.active) return` guard in both modules for the same reason.

**Only content that registers nothing can do this.** CF4 and UNGC rows are registry
entries, and the viewer snapshots the registry into the label engine once after module
load, so deferring them would make a whole catalogue findable only by flying to it first.
`tests/unit/deferred-datasets.test.ts` holds both halves: the margin, and the fact that
CF4 and UNGC still register from `init` alone with no frame having run.

**Effect: 4.1 MB off a boot that stays in the solar system**, and the requests drop from
53 to 49. Measured against the built output: at the default view neither `field.bin` nor
`2mrs.bin` is requested; at the galaxy rung both are, and the console reports the same
43,497 2MRS galaxies drawn as before.

## 5. The duplicate manifest fetch (done)

`2mrs.json` was fetched twice: once by `loadZoneOfAvoidance` for the survey's measured
coverage limits, and again by `load2Mrs` through `fetchBinary`, which pairs a `.json` with
its `.bin`. The zone-of-avoidance loader now keeps the manifest it already parsed and the
binary load reuses it, falling back to its own fetch only if that one failed. With the
binary deferred this mattered more than it did before: the second copy would have arrived
a rung later, not milliseconds later.

`smallbodies/named.json` remains the one sizeable dataset still shipping as JSON rather
than through the struct-of-arrays binary treatment the others get. Brotli takes it to
about 0.3 MB on the wire, so it is a parse-time concern more than a transfer one, and it
is tracked in `LIGHTHOUSE.md` alongside the rest of the main-thread work.

## Where it lands

| | Originally | Now (all five shipped) |
|---|---|---|
| Cold boot | 250 requests / 19.84 MB | **49 requests** (bytes measured on the dev preview, below) |
| Refresh | 250 requests / 19.84 MB | **5 requests / ~1 KB** | ~5 requests / ~1 KB |

The refresh figure is measured on the live site: 245 of 250 resources served from cache
with zero bytes, the five that touched the network being the manifest plus four ~0.3 KB
`304`s that a browser reload forces regardless of freshness.

## How to re-measure

Anything here should be re-checked rather than trusted. Load the deployed site, let it
settle — the star tier finishes last — and in the console:

```js
const rs = performance.getEntriesByType('resource')
const by = {}
let transfer = 0
for (const r of rs) {
  let k = new URL(r.name).pathname.replace(/\/[^/]*$/, '/')
  if (k.includes('/stars/l2/')) k = '/data/stars/l2/'
  ;(by[k] ??= { n: 0, t: 0 })
  by[k].n++
  by[k].t += r.transferSize || 0
  transfer += r.transferSize || 0
}
console.table(by)
console.log(rs.length, 'requests', (transfer / 1048576).toFixed(2), 'MB')
```

Measure the deployed site, not `npm run dev`. The dev server adds one request per source
module and serves Vite's unbundled dependency pre-bundle at about 9.7 MB, none of which
ships — it inflates both numbers in ways that do not correspond to anything a user pays.
