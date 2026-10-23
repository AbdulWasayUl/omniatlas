/**
 * Facts shown while the atlas boots.
 *
 * Two jobs, and the second one is the reason this file is separate.
 *
 * The first is that a visitor on a slow connection waits several seconds looking at a
 * progress bar, and a sourced fact about what is loading is better than a sweep
 * animation. That is what `docs/OVERHAUL_PLAN.md` asked for: "phase text + fact card +
 * credit".
 *
 * The second is Largest Contentful Paint. A `<canvas>` is not an LCP candidate, so the
 * 3D view can never satisfy that metric however fast it gets; before this the largest
 * text on the page was a HUD caption that renders only once the engine is ready, which
 * is why LCP measured 40.8 s on a Slow 4G run. A block of real text in the first paint
 * fixes that honestly, by having something worth reading early rather than by gaming
 * what the metric looks at.
 *
 * EVERY NUMBER HERE IS CHECKED AGAINST THE SHIPPED DATA, not remembered. An atlas whose
 * whole claim is sourced truth cannot show invented trivia on its own loading screen,
 * and a fact card is exactly where a plausible wrong number would never be noticed.
 * `tests/unit/loading-facts.test.ts` re-derives the counted ones from the same files the
 * renderer reads, so a catalogue rebuild that changes a total fails the suite rather
 * than quietly making this page wrong.
 */

export interface LoadingFact {
  /** Two short sentences at most: this has to fit the card without reflowing it. */
  text: string
  /** Where the number comes from. Shown, not just recorded. */
  source: string
}

export const LOADING_FACTS: readonly LoadingFact[] = [
  {
    // 8,125 + 39,632 + 282,103, summed from l0.json, l1.json and l2/index.json.
    text: 'This atlas holds 329,860 real stars, each one placed from its own measured parallax rather than scattered to look right.',
    source: 'AT-HYG v4.0, Astronomy Nexus',
  },
  {
    // 2mrs.json: statistics.withRedshift 43,533 + statistics.withoutRedshift 1,066.
    text: 'Of the 44,599 galaxies in the 2MASS Redshift Survey, 1,066 have no measured redshift. They are not drawn anywhere, because there is no honest distance to draw them at.',
    source: '2MRS, Huchra et al. 2012',
  },
  {
    // scaleLadder.ts rung 6, which cites the plasma wave instrument for the crossing.
    text: 'Voyager 1 crossed the heliopause at 121 AU on 25 August 2012, leaving the Sun’s wind behind. You can fly to that boundary.',
    source: 'Voyager 1 plasma wave instrument',
  },
  {
    // R0_KPC in astronomy/galaxy.ts, adopted from the Reid+2019 arm model.
    text: 'The centre of the Galaxy is 8.15 kiloparsecs away, about 26,600 light-years. Everything you can see by eye sits in a bubble a thousandth that wide.',
    source: 'Reid et al. 2019',
  },
  {
    // notableObjects.ts, TON 618, whose mass is a broad-line estimate rather than dynamical.
    text: 'TON 618’s event horizon is roughly 1,300 AU across, forty times the width of Neptune’s orbit. Its mass is estimated from the width of its emission lines, so the atlas labels it derived rather than measured.',
    source: 'Shemmer et al. 2004',
  },
  {
    // DATA_AND_COORDINATES.md: the Triton replacement, and why it was needed.
    text: 'Voyager 2 photographed less than half of Triton in 1989. The rest of its map is a flat fill, and the atlas draws it that way rather than inventing a surface.',
    source: 'NASA/JPL-Caltech/USGS',
  },
]

/**
 * One fact, chosen by index.
 *
 * The caller picks the index once and keeps it, so the card never changes under a
 * reader mid-load. Taking a modulo here rather than trusting the caller means a stale
 * index from a hot reload cannot blank the card.
 */
export function loadingFact(index: number): LoadingFact {
  return LOADING_FACTS[Math.abs(Math.trunc(index)) % LOADING_FACTS.length]
}
