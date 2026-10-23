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

## 3. Textures are half the bytes, and all of them load at boot

Two independent levers.

**Re-encode.** Measured across the whole set at WebP quality 82:

| | JPEG | WebP q82 |
|---|---:|---:|
| Whole set on disk | 10.89 MB | 4.93 MB (**−55%**) |

The range is wide and worth respecting per file: Neptune is 93 per cent smaller, Uranus 89,
Saturn 84 — these are smooth, low-detail maps that JPEG's 8×8 blocks handle badly. But
Callisto and Enceladus come out *larger* in WebP, both being small greyscale maps.
The build step should keep whichever encoding is smaller per file rather than converting
blindly, and emit `<name>.webp` beside the JPEG with a `<picture>`-style fallback or a
capability check at load.

**Load on approach.** Every `SphereBody` is constructed during `SolarModule.init`, and
`loadTexture` fires the moment the material is built, so all 28 maps are fetched before
the first frame regardless of where the camera is. At the default view — the Sun at
3.34 AU — roughly twenty of those bodies are under a pixel, and several are drawn as
marker glyphs rather than meshes at all. The renderer already crossfades mesh against
glyph on apparent angular size; the same threshold should gate the fetch, with the flat
`baseColor` the catalogue already carries standing in until the map arrives.

**Effect: boot textures from 9.93 MB to under 1 MB.** Combined, these two are the largest
byte reduction available.

## 4. Defer the far-scale datasets

`data/galaxy/field.bin` is 3.54 MB of Milky Way disc points, meaningful only at the
galactic rung. `data/universe/` holds CF4 and 2MRS at 0.79 MB for the cosmic rungs. Both
load during module `init`, so a visit that never leaves the inner solar system pays
4.33 MB for structures it never renders.

The engine already computes the exact signal this needs. `Engine.activateLayers` sets
`layer.active` from the camera's distance band and the view span, and the `galactic` and
`cosmic` layers are inactive at every solar-system view. Hooking the first activation of
a layer to the load of its datasets fits the existing module lifecycle: `init` registers
nodes and builds geometry, and the fetch moves into a once-only guard in `preRender`.

Failure isolation has to survive the move. A deferred load that fails should degrade the
same way a failed `init` does today, through `engine.failedModules`, rather than retrying
on every frame.

## 5. Two small ones

- `data/universe/2mrs.json` is fetched **twice**. `CosmosModule` reads it through
  `fetchBinary` at `cosmos/index.ts:1051` and then re-fetches the same manifest at
  `:1200` for the zone-of-avoidance wedge, having already parsed it. Passing the manifest
  through removes a request.
- `data/smallbodies/named.json` is 1.04 MB decoded, the only sizeable dataset still
  shipping as JSON rather than through the struct-of-arrays binary treatment the others
  get. Brotli takes it to 0.3 MB on the wire, so this is a parse-time concern more than a
  transfer one.

## Where it lands

| | Originally | Now (items 1-2 shipped) | After items 3-5 |
|---|---|---|---|
| Cold boot | 250 requests / 19.84 MB | **74 requests** / 19.84 MB | ~45 requests / ~5 MB |
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
