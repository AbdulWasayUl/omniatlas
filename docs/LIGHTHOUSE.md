# Lighthouse: what the score is, and what is worth doing about it

Baseline, captured 2026-10-23 against the deployed site with Lighthouse 13.4.1, emulated
Moto G Power, Slow 4G, single page session:

| | |
|---|---:|
| **Performance** | **61** |
| Accessibility | 95 |
| Best Practices | 100 |
| SEO | 100 |

| Metric | Value |
|---|---:|
| First Contentful Paint | 2.3 s |
| **Largest Contentful Paint** | **40.8 s** |
| Total Blocking Time | 430 ms |
| Cumulative Layout Shift | 0.004 |
| Speed Index | 3.3 s |

Everything below was checked against this repository rather than taken from the report.
Where the report and the code disagree, that is called out.

## Read the conditions before the score

This is a WebGL atlas that streams a star catalogue, measured on a low-end phone over
Slow 4G. Some of the distance between 61 and 100 is the thing itself, and chasing the
number past the point where the app is actually fast would be optimising the test. The
items below are ordered by what a real visitor on a real connection feels; the score
follows from the first two and most of the rest is hygiene.

CLS is 0.004 and SEO is 100. Neither needs work.

## 1. LCP is 40.8 s because nothing paints text until the engine has booted

This is the whole performance story. 40.8 s of a 61 is one metric.

Measured in the browser with a `largest-contentful-paint` PerformanceObserver, the LCP
element is:

```
DIV.hud-sub.hud-text — "A hundred thousand light-years: the span of a large spiral galaxy"
```

That is the HUD's rung caption. It renders from `snapshot`, which arrives only once the
viewer is ready, which waits on module init. So LCP is not measuring a slow image or a
slow font: it is measuring the moment the atlas finishes booting, because **no
substantial text exists on the page before then**.

A `<canvas>` is not an LCP candidate, so the 3D view can never satisfy this metric no
matter how fast it gets. The loading screen is the only thing on screen before ready, and
it currently holds a wordmark, a progress bar and one short line — too small an area to
win, so LCP skips it and waits for the HUD.

Two fixes, both worth doing and neither a trick:

**Give the loading screen real content.** `docs/OVERHAUL_PLAN.md` already specifies it as
"phase text + fact card + credit" and it was built as a wordmark and a sweep. A genuine
fact card is a block of text large enough to be the honest largest paint at ~2.3 s, and
it is content a visitor on a 40-second connection actually wants. This alone should move
LCP from 40.8 s to near FCP.

**Shorten time-to-ready**, which items 2 and 3 cover. That helps every visitor rather
than just the metric.

Do the first one first. It is small, it is already in the spec, and it is the difference
between a 61 and something in the high 80s on its own.

## 2. TBT 430 ms, 4.4 s of main-thread work, 15 long tasks

Every catalogue binary is decoded on the main thread during module init: 282,103 stars,
80,598 belt instances, 43,497 2MRS galaxies, 38,051 CF4 groups, 13,371 NGC objects. The
decode loops are tight and allocate little, but they are long, synchronous, and they all
run before the first frame.

`docs/ARCHITECTURE.md` already names the destination — `src/workers/catalog.worker.ts`,
"binary tile parse → transferable typed arrays. Never per-star objects" — and it was
never built. The decoders are pure functions over an `ArrayBuffer` that produce typed
arrays, which is exactly the shape that transfers to a worker with no copy.

Short of that, the same loops yield between chunks: a decode that fills 4 MB of
`Float32Array` in 20 slices of a few hundred microseconds produces the same buffer and no
long task. That is a smaller change than a worker pool and recovers most of the TBT.

## 3. Payload: 10,395 KiB reported, and most of the easy wins are already taken

The report predates four of the five items in `docs/PERFORMANCE.md`. As of now a cold boot
is about 49 requests; the remaining weight is the belt (2.2 MB), `named.json` (1.0 MB),
CF4 (0.7 MB) and the star tiers.

What is left:

- **`smallbodies/named.json` is 1.0 MB of JSON**, the only sizeable dataset that never got
  the struct-of-arrays binary treatment the others have. Brotli takes it to ~0.3 MB on the
  wire, so this is a parse-time cost more than a transfer one, which makes it an item 2
  problem as much as an item 3 one.
- **The belt binary is 2.2 MB and loads at boot.** Unlike the disc field it is wanted at
  the inner-system rungs, which is where most sessions start, so it is not a deferral
  candidate. It is a candidate for a coarser first tier.
- **CF4 and UNGC cannot be deferred**: their rows are registry entries, and the viewer
  snapshots the registry into the label engine once after module load. A catalogue you can
  only find by flying to it first is not a catalogue. See `tests/unit/deferred-datasets.test.ts`.

## 4. "Reduce unused JavaScript, 207 KiB"

The index chunk is 589 KB raw and 258 KB brotli, and the bulk of it is three.js. The
project imports `* as THREE` in fifteen files, which defeats tree-shaking entirely.
Switching to named imports is mechanical and safe, and it is the only unused-JS lever
that does not involve removing a feature.

Worth measuring before and after with `rollup-plugin-visualizer` rather than assuming:
three.js's own module graph means a named import does not always drop what it looks like
it should.

## 5. "Minify JavaScript, 73 KiB" is probably a false positive — verify before acting

`dist/assets/catalog-*.js` is 72 KB on a **single line with no newlines**, which is to say
already minified, and the reported saving is 73 KiB. The chunk is almost entirely prose:
the catalogue's descriptions, facts and provenance strings. Lighthouse's estimate appears
to be counting the whitespace inside those string literals, which is content and cannot be
removed.

Confirm by running the chunk through a second minifier and comparing. If it comes back the
same size, the audit is wrong about this file and the right response is to ignore it, not
to mangle the prose.

## 6. Three non-composited animations

Named, so nobody has to hunt for them:

| Where | Property | Fix |
|---|---|---|
| `@keyframes live-pulse` | `box-shadow` | a pseudo-element scaled with `transform`, faded with `opacity` |
| `.scale-bar-rule` | `width` transition | `transform: scaleX()` from a fixed base width |
| `.ladder-rung::before` | `width` transition | `transform: scaleX()` |

All three are mine, from the chrome rework. `live-pulse` runs continuously on every frame
the clock is live, so it is the one that matters; the other two fire only on interaction.

## 7. Accessibility 95: `--text-4` fails AA, and the gate that was meant to catch it does not exist

Measured contrast ratios against the surfaces the token is used on:

| | surface-0 | surface-1 | surface-2 |
|---|---:|---:|---:|
| `--text-3` | 6.44 | 6.06 | 5.58 |
| `--text-4` | **3.61** | **3.40** | **3.13** |

AA wants 4.5 for body text. `tokens.css` documents `--text-4` as "disabled / decorative
only" and says `scripts/check-contrast.mjs` enforces it. **That script does not exist**,
and the token is used in sixteen places, several of which are real labels rather than
decoration: section heads, palette group headings, the palette's class column and its
footer.

Two things, in order: raise `--text-4` to clear 4.5 on `surface-2` (the worst case) or
stop using it for anything a user has to read, and then write the script the token file
claims to be enforced by. A comment asserting a gate that is not there is worse than no
comment.

## 8. Best Practices is 100, with six advisories

All are headers, and `vercel.json` is already where the project sets headers:

- **CSP** against XSS, and **Trusted Types** for DOM XSS
- **HSTS**
- **COOP** for origin isolation. Note `vite.config.ts` sets COOP/COEP for the dev server
  only, with a comment about `SharedArrayBuffer` — there is no `SharedArrayBuffer` and no
  worker anywhere in `src/`, so those headers are vestigial. If a catalogue worker lands
  (item 2) that changes, and COEP would then need auditing against every asset.
- **XFO** against clickjacking
- **Source maps** for first-party JS: the build emits none. `build.sourcemap: true` costs
  nothing at runtime and makes production stack traces readable.

A CSP on a page that loads only same-origin assets and no inline scripts is close to free
here. Worth doing before the app grows anything that complicates it.

## Order of work

1. Loading screen fact card — LCP 40.8 s → ~FCP. Biggest single move, smallest change.
2. Chunked or worker-based catalogue decode — TBT and time-to-ready.
3. `--text-4` contrast, plus the missing `check-contrast.mjs`.
4. The three non-composited animations.
5. Headers: CSP, HSTS, XFO, source maps.
6. `named.json` to binary; named three.js imports — measure first.
7. Ignore the minify audit unless a second minifier disagrees with the single-line file.

## Re-measuring

Run Lighthouse against the deployed site, not a local preview: the dev server is
unminified and uncompressed, and `vite preview` does not apply `vercel.json`. Keep the
same emulation (Moto G Power, Slow 4G) or the numbers are not comparable to the baseline
above. For the LCP element specifically, the PerformanceObserver snippet is faster than a
full run:

```js
new PerformanceObserver(l => {
  for (const e of l.getEntries()) console.log(e.startTime, e.size, e.element)
}).observe({ type: 'largest-contentful-paint', buffered: true })
```
