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

## A preview deployment scores differently, and SEO 60 is the tell

Measure production. Vercel sends `x-robots-tag: noindex` on every preview deployment, by
design, so previews stay out of search. Lighthouse's `is-crawlable` audit carries roughly
forty per cent of the SEO category, so a preview scores about **60 on SEO no matter what
the code does**, and production scores 100 on the same commit. Verified both ways:

```
preview:    x-robots-tag: noindex      SEO ~60
production: (absent)                   SEO 100
```

If an SEO number drops to about 60, check which URL was measured before changing
anything.

## Read the conditions before the score

This is a WebGL atlas that streams a star catalogue, measured on a low-end phone over
Slow 4G. Some of the distance between 61 and 100 is the thing itself, and chasing the
number past the point where the app is actually fast would be optimising the test. The
items below are ordered by what a real visitor on a real connection feels; the score
follows from the first two and most of the rest is hygiene.

CLS is 0.004 and SEO is 100. Neither needs work.

## 1. LCP was 40.8 s because nothing painted text until the engine had booted (done)

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

**Done: the loading screen now carries a sourced fact card.** Measured against the
production build, LCP fires at **0.40 s, the same instant as FCP**, with one candidate at
25,862 px². One candidate is the part that matters: the HUD caption is 10,783 px², so it
never supersedes the card, and LCP stays at first paint instead of drifting to the end of
boot. On the Slow 4G profile that should put LCP at roughly the 2.3 s FCP rather than
40.8 s.

The facts are real and sourced, and `tests/unit/loading-facts.test.ts` re-derives the
counted ones from the same manifests the renderer reads. A fact card is exactly where a
plausible wrong number would never be noticed, and an atlas whose whole claim is sourced
truth cannot show invented trivia on its own splash screen.

Shortening time-to-ready, which items 2 and 3 cover, is still worth doing. It just is no
longer what LCP measures.

## 2. TBT: the biggest single task is sliced (done)

Every catalogue binary is decoded on the main thread during module init: 282,103 stars,
80,598 belt instances, 43,497 2MRS galaxies, 38,051 CF4 groups, 13,371 NGC objects. The
decode loops are tight and allocate little, but they are long, synchronous, and they all
run before the first frame.

`docs/ARCHITECTURE.md` already names the destination — `src/workers/catalog.worker.ts`,
"binary tile parse → transferable typed arrays. Never per-star objects" — and it was
never built. The decoders are pure functions over an `ArrayBuffer` that produce typed
arrays, which is exactly the shape that transfers to a worker with no copy.

Short of that, the same loops yield between chunks. **Done for the largest of them.**
`src/core/scheduling.ts` slices work and yields between slices, preferring
`scheduler.yield()` over a `setTimeout` whose 4 ms clamp would otherwise dominate; the
L2 star decode uses it, sliced by HEALPix chunk because that structure was already there.

Measured on the production build: one **54 ms** task became **12 slices, 37 ms of CPU,
worst slice 4.2 ms**, for the same 282,103 stars. A phone CPU is four to six times slower,
which puts the worst slice near 25 ms — under the 50 ms threshold, so it contributes
nothing to TBT rather than most of it.

The remaining decodes were measured before touching them, which is why only this one was
sliced: per-module `init` is now timed and reported through `Engine.moduleTimings`, and
nothing else came close. Worth re-checking on a real phone trace rather than extrapolating
from a desktop, because a desktop understates all of this by the same four to six times.

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

## 6. Three non-composited animations (done)

Named, so nobody has to hunt for them:

| Where | Property | Fix |
|---|---|---|
| `@keyframes live-pulse` | `box-shadow` | a pseudo-element scaled with `transform`, faded with `opacity` |
| `.scale-bar-rule` | `width` transition | `transform: scaleX()` from a fixed base width |
| `.ladder-rung::before` | `width` transition | `transform: scaleX()` |

All three are mine, from the chrome rework. `live-pulse` runs continuously on every frame
the clock is live, so it is the one that matters; the other two fire only on interaction.

## 6b. The webfont swap shifts the top bar (open)

Found while measuring the above, not in the report. The only layout shift on a cold load
is a single 0.0138 entry at 0.68 s whose sources are the top bar's own elements,
`.search-trigger.brackets` among them. That is Inter arriving under `font-display: swap`
and reflowing chrome that was laid out in the fallback face.

It is small and CLS stays well inside "good", so this is hygiene rather than a problem.
The fix is `size-adjust` and the matching metric overrides on a local `@font-face`
fallback, so the fallback occupies the same space Inter will. Preloading the woff2 helps
separately: the fonts are currently reached through two levels of CSS `@import`, which is
a request waterfall before the first byte of font data is asked for, and that is also one
of the report's render-blocking findings.

The fact card itself is not among the shift sources. Its `min-height` was set for exactly
this reason.

## 7. `--text-4` failed AA, and the gate meant to catch it did not exist (done)

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

Both done, in that order. Nine usages that were real labels — section heads, the
palette's group headings, its class column, its footer, the breadcrumb separator, the
keycap, the placeholder, the close control — moved to `--text-3`. `--text-4` itself went
from `#616a71` to `#666f77` so it clears 3.0 against every surface text sits on, which
is the floor for the non-text and `:disabled` cases it is now reserved for.

`scripts/check-contrast.mjs` exists and runs as part of `npm run lint`. Writing it
immediately caught two things worth recording. It first reported a pass while measuring
the **`prefers-contrast: more` overrides**, because a regex over the whole token file
keeps the last declaration of a duplicated name; it now reads the default `:root` block
only. And it excludes `--surface-4`, which is the scrollbar thumb and the ladder's
unshipped tick and never a text background — a floor that flags pairings the product
never renders is a floor people learn to ignore.

## 8. Best Practices advisories (done)

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

All done in `vercel.json` and `vite.config.ts`: CSP, HSTS, XFO, COOP, a
`Permissions-Policy`, and `build.sourcemap: true`.

The CSP was tested before shipping rather than after, because `vite preview` ignores
`vercel.json` and a broken CSP is invisible until production. A small static server in the
scratchpad applied the real headers to `dist/`, and the atlas booted under them with no
violations. `style-src` keeps `'unsafe-inline'`: the catalogue's class colours and the
inspector's accent are written as inline `style` attributes, which CSP counts.

Trusted Types is still open. It needs a policy for every DOM sink, and three.js is not
audited for it.

## Order of work

Done: the loading screen fact card (LCP), slicing the L2 decode (TBT), the `--text-4`
contrast and its gate, the three non-composited animations, the headers and source maps,
and `robots.txt`.

Open, in order:

1. The rest of the catalogue decode, driven by a real phone trace rather than desktop
   numbers. A worker is the documented destination; slicing may be enough.
2. The webfont swap's layout shift, and preloading the woff2 past the `@import` waterfall.
3. `named.json` to binary; named three.js imports — measure first.
4. Trusted Types.
5. Ignore the minify audit unless a second minifier disagrees with the single-line file.

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
