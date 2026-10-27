import { describe, expect, it } from 'vitest'
import { LANDMARK_POOLS, generateInterior } from '../../src/generators/galaxy'

/**
 * A place has to be worth arriving at, which starts with it not being the last place.
 *
 * Measured before this mattered: 107 landmarks across eight galaxies shared nineteen
 * description sentences between them, one of which appeared fourteen times, and a single
 * galaxy held the Lantern Bloom, the Lantern Reach and the Lantern Scar. The world
 * generator next door produced 887 descriptions for 887 worlds with no repeats at all,
 * which is the standard this is held to.
 */

const interiors = (n: number) =>
  Array.from({ length: n }, (_, i) => generateInterior(`probe:${i}`, 1.2e20, 'galaxy'))

describe('landmark variety', () => {
  it('never says the same thing twice about one galaxy', () => {
    // The standard that matters, because this is the list a reader actually sees at
    // once. Before: eight galaxies, 107 places, nineteen sentences between them, one of
    // them fourteen times.
    for (const g of interiors(90)) {
      const texts = g.landmarks.map((l) => l.description)
      expect(new Set(texts).size, `${g.hostId} repeats itself`).toBe(texts.length)
    }
  })

  it('mostly avoids repeating itself across galaxies too', () => {
    // A weaker bar on purpose. Two places in two different galaxies that happen to be
    // the same size at the same radius and drew the same two sentences will read alike,
    // and nobody is ever looking at both lists at once.
    const all = interiors(90).flatMap((g) => g.landmarks)
    const unique = new Set(all.map((l) => l.description))
    expect(all.length).toBeGreaterThan(400)
    expect(unique.size / all.length).toBeGreaterThan(0.9)
  })

  it('does not name every place in one galaxy out of the same two words', () => {
    for (const g of interiors(60)) {
      const firsts = g.landmarks.map((l) => l.name.split(' ')[1])
      const seconds = g.landmarks.map((l) => l.name.split(' ')[2])
      // Within one host, a word may repeat only once the vocabulary is genuinely spent.
      const repeatedFirst = firsts.length - new Set(firsts).size
      const repeatedSecond = seconds.length - new Set(seconds).size
      expect(repeatedFirst, `${g.hostId} reuses an adjective`).toBeLessThanOrEqual(1)
      expect(repeatedSecond, `${g.hostId} reuses a noun`).toBeLessThanOrEqual(2)
    }
  })

  it('tells you how big each place is and where it sits', () => {
    // The measured clause is what makes two places with the same prose still different.
    for (const g of interiors(20)) {
      for (const l of g.landmarks) {
        expect(l.description, l.name).toMatch(/across/)
        expect(l.description, l.name).toMatch(/\d/)
      }
    }
  })

  it('never calls a famous nursery a supernova remnant', () => {
    // What kind of object M42 is was settled a century ago. ILLUSTRATED covers an
    // invented arrangement, not an invented identity.
    for (const id of ['ngc:NGC1976', 'ngc:NGC6611', 'ngc:IC4703', 'ngc:NGC6618', 'ngc:NGC6523', 'ngc:NGC3372']) {
      const neb = generateInterior(id, 1.6e17, 'nebula')
      expect(neb.description, id).toMatch(/emission/i)
      expect(neb.landmarks.some((l) => l.kind === 'pulsar'), `${id} has a neutron star in it`).toBe(false)
      expect(neb.landmarks.some((l) => l.kind === 'front'), `${id} has a shock front in it`).toBe(false)
    }
  })

  it('still calls a famous remnant a remnant', () => {
    for (const id of ['ngc:NGC1952', 'ngc:NGC6960', 'ngc:NGC6992']) {
      expect(generateInterior(id, 1.6e17, 'nebula').description, id).toMatch(/remnant/i)
    }
  })
})

describe('sentence pools', () => {
  it('holds more lines than a single host will draw from them', () => {
    // Without-replacement picking cannot help once a pool is smaller than the number of
    // places drawn from it: omega Centauri names seven members from a three-line pool,
    // so the pigeonhole guaranteed four repeats however the picking worked. Measured
    // worst cases: 7 members per cluster, 4 shock fronts per remnant, up to 10 nebulae
    // per galaxy.
    const worst = 10
    for (const [kind, lines] of Object.entries(LANDMARK_POOLS)) {
      expect(lines.length, `${kind} has too few lines to avoid repeating itself`).toBeGreaterThanOrEqual(worst)
    }
  })

  it('says something different about each member of one cluster', () => {
    for (let i = 0; i < 40; i++) {
      const cluster = generateInterior(`gc:probe${i}`, 5e17, 'cluster')
      const stripped = cluster.landmarks.map((l) => l.description.replace(/[\d,]+/g, '#'))
      expect(new Set(stripped).size, `cluster ${i} repeats once the numbers are stripped`).toBe(stripped.length)
    }
  })

  it('never reports a distance of zero light years', () => {
    // "It lies 0 light years from the centre of the crowd" is not a sentence.
    for (let i = 0; i < 60; i++) {
      for (const l of generateInterior(`gc:probe${i}`, 5e17, 'cluster').landmarks) {
        expect(l.description, l.name).not.toMatch(/\b0 light years\b/)
      }
      for (const l of generateInterior(`probe:${i}`, 1.2e20, 'galaxy').landmarks) {
        expect(l.description, l.name).not.toMatch(/\b0 light years\b/)
      }
    }
  })

  it('uses one number format per sentence', () => {
    // "It is 3,037 light years across, 13.9 thousand light years out" put two formats
    // for the same unit side by side.
    for (let i = 0; i < 40; i++) {
      for (const l of generateInterior(`probe:${i}`, 1.2e20, 'galaxy').landmarks) {
        expect(l.description, l.name).not.toMatch(/thousand light years/)
      }
    }
  })
})
