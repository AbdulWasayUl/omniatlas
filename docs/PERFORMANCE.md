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

## 1. Nothing is cacheable — fix the headers

There is no `vercel.json`, so every response takes the platform default:

```
cache-control: public, max-age=0, must-revalidate
```

That header is on all 250 responses, including `assets/index-DK0MaEpI.js` — a
**content-hashed** filename whose bytes can never change. `max-age=0` with
`must-revalidate` forbids the browser from reusing anything without asking first, so a
refresh re-issues every request. With a warm CDN the bytes mostly come back as 304s, but
250 conditional round trips is still the whole cost the user perceives, and any cache
eviction or a `Disable cache` tick in devtools turns it back into 19.84 MB.

Everything the atlas serves is immutable in practice. The build output is hashed, and the
datasets and textures are versioned by the ETL in `scripts/`, not edited in place.

```json
{
  "headers": [
    {
      "source": "/assets/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
      ]
    },
    {
      "source": "/(data|textures)/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=604800, stale-while-revalidate=86400" }
      ]
    }
  ]
}
```

`immutable` is safe on `/assets/` because Vite hashes those names; a content change
produces a different URL. `/data/` and `/textures/` keep a finite age because their names
are stable across rebuilds, so a week plus revalidation is the honest ceiling until those
get hashed too.

**Effect: a refresh drops from 250 requests to about 2.** No code change. This is the
cheapest item on the list and it addresses the symptom that prompted the investigation.

## 2. 186 of the 250 requests are one dataset

The deep star tier is 192 HEALPix chunks under `data/stars/l2/`, and
`StarsModule.loadDeepTier` fetches **all of them, unconditionally, on every boot**, eight
at a time, concatenating the lot into a single `Float32Array` and a single instanced
mesh. The module says so itself:

> All 192 are merged into one instanced mesh rather than 192 of them: the whole set is
> under 3 MB, and one draw call for a third of a million stars is the entire point of the
> instanced-quad approach.

So the chunking buys nothing at runtime. There is no view-dependent streaming to preserve,
no frustum test, no distance gate: 192 files are downloaded to build exactly one object,
in every view, every time. They are 74 per cent of the request count and 10 per cent of
the bytes.

The fix is in `scripts/build-stars.mjs`: emit one `l2.bin` that is the existing chunks
concatenated, and keep the per-chunk record offsets in `l2/index.json` so the shell
dequantisation still has its boundaries. `loadDeepTier` then drops its concurrency queue
and reads one buffer with the offsets it already parses.

**Effect: 250 requests to about 65, cold. Byte-identical output.**

If per-tile streaming is wanted later, it should be driven by the camera rather than
reinstated by default — and at 2.4 MB for the whole tier it is not obvious that it is
worth the complexity.

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

| | Now | After |
|---|---|---|
| Cold boot | 250 requests / 19.84 MB | ~45 requests / ~5 MB |
| Refresh | 250 requests / 19.84 MB | ~2 requests / ~0 MB |

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
