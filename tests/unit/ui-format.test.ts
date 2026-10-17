import { describe, expect, it } from 'vitest'
import { LY_M, chooseScaleBar, formatDistance, formatRate } from '../../src/format/units'
import { SCALE_LADDER } from '../../src/data/scaleLadder'
import { railFor, railFraction, rungForView } from '../../src/ui/scaleRungs'
import { aliasContains, aliasesFor } from '../../src/ui/searchMatch'

/**
 * The pure parts of the chrome: the unit ladder, the scale rail's two directions, and
 * the search palette's designation matching. All three are boundary logic with one
 * right answer per input, and all three have regressed at least once while the
 * rendering around them stayed visibly fine.
 */

describe('formatDistance', () => {
  it('refuses to present a broken number as a measurement', () => {
    expect(formatDistance(Number.NaN).text).toBe('—')
    expect(formatDistance(Number.POSITIVE_INFINITY).text).toBe('—')
  })

  it('keeps the sign of a signed separation', () => {
    expect(formatDistance(-1234).text).toBe('−1.23 km')
  })

  // The band edges sit at 999.5 of a unit rather than at 1000, because `round` prints
  // [100, 1000) with no decimals: 999.6 kly would otherwise render as "1000 kly".
  it('hands over to the next unit before the readout grows a fourth digit', () => {
    expect(formatDistance(999.4 * LY_M).text).toBe('999 ly')
    expect(formatDistance(999.6 * LY_M).text).toBe('1.000 kly')
    expect(formatDistance(999.6e3 * LY_M).text).toBe('1.000 Mly')
    expect(formatDistance(999.6e6 * LY_M).text).toBe('1.000 Gly')
  })

  it('stays in the light-year family above a light-year', () => {
    // The ladder used to be cut in parsecs while printing light-years, so every band
    // ran to 1,630 of itself and the HUD read "1,057 Mly" for 1.06 Gly.
    for (const metres of [2.5e6 * LY_M, 1.06e9 * LY_M]) {
      expect(Number(formatDistance(metres).text.replace(/[^\d.]/g, ''))).toBeLessThan(1000)
    }
  })
})

describe('formatRate', () => {
  it('phrases each rung of the UI ladder grammatically', () => {
    expect(formatRate(0)).toBe('Paused')
    expect(formatRate(1)).toBe('Real time')
    expect(formatRate(60)).toBe('1 min / second')
    expect(formatRate(3600)).toBe('1 hour / second')
    expect(formatRate(7200)).toBe('2 hours / second')
    expect(formatRate(86_400)).toBe('1 day / second')
    expect(formatRate(86_400 * 30)).toBe('30 days / second')
    expect(formatRate(86_400 * 365.25)).toBe('1 year / second')
  })
})

describe('chooseScaleBar', () => {
  it('never falls more than 0.4x short of the budget it is given', () => {
    // The HUD budgets a pixel width and then draws the bar at its exact true ratio, so
    // a bar far below the budget is a short rule, not a wrong one — but 0.4 is the
    // worst the 1/2/5 snap can do, and anything below it means the snap is broken.
    for (let decade = -3; decade <= 27; decade++) {
      for (const mantissa of [1, 1.3, 1.9, 2.4, 4.9, 5.1, 7, 9.9]) {
        const budget = mantissa * 10 ** decade
        const bar = chooseScaleBar(budget)
        expect(bar.metres / budget).toBeGreaterThanOrEqual(0.4)
        expect(bar.metres / budget).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('the scale rail', () => {
  const RADII = [
    0, // no anchor
    1.7374e6, // the Moon
    6.371e6, // Earth
    6.957e8, // the Sun
    1.03e9, // Sirius
    1.9e13, // M87*
    4.63e20, // the Milky Way
  ]

  const anchorAt = (radiusMetres: number) =>
    radiusMetres > 0
      ? { radiusMetres, name: `R=${radiusMetres}`, objectClass: 'planet', inSolarSystem: true }
      : null

  it('is a control: every rung means a different span, in order', () => {
    for (const radius of RADII) {
      const rail = railFor(anchorAt(radius))
      for (let i = 1; i < rail.length; i++) {
        expect(rail[i].spanMetres, `${rail[i].id} at R=${radius}`).toBeGreaterThan(rail[i - 1].spanMetres)
      }
    }
  })

  it('lights exactly the rung that was clicked, at every anchor size', () => {
    // The rail reads its lit rung back out of the view span, so the two directions
    // have to be inverses. They were not: anchored on Sirius every rung from Body up
    // to Moon system resolved to the same span, so four presses of ArrowUp left the
    // span frozen and "Body" lit. Every rung the rail now shows is absolute and
    // reachable, which is what makes this exact rather than approximate.
    for (const radius of RADII) {
      const rail = railFor(anchorAt(radius))
      for (const rung of rail) {
        expect(rungForView(rung.spanMetres, rail).id, `${rung.id} at R=${radius}`).toBe(rung.id)
      }
    }
  })

  it('is a different rail at a planet and at a galaxy', () => {
    // The complaint this answers: the rail looked identical everywhere, with eight of
    // its rungs naming views inside the body the camera was standing on.
    const earth = railFor(anchorAt(6.371e6))
    const galaxy = railFor(anchorAt(4.63e20))
    expect(earth.length).toBeGreaterThan(galaxy.length)
    expect(galaxy.map((rung) => rung.id)).toEqual(['anchor', 'local-group', 'supercluster', 'cosmic-web', 'observable'])
    // Nothing inside the galaxy survives on its rail, and nothing is floored to fake
    // a rung that cannot be reached.
    for (const rung of galaxy.slice(1)) expect(rung.spanMetres).toBeGreaterThan(4.63e20)
  })

  it('makes the object itself the bottom rung, framed whole', () => {
    const rail = railFor({ radiusMetres: 5.8232e7, name: 'Saturn', objectClass: 'planet', inSolarSystem: true })
    expect(rail[0].isAnchor).toBe(true)
    expect(rail[0].label).toBe('Saturn')
    // 3.2 radii: the arrival framing, not a span inside the planet.
    expect(rail[0].spanMetres).toBeGreaterThan(2 * 5.8232e7)
    expect(rungForView(rail[0].spanMetres, rail).label).toBe('Saturn')
  })

  it('falls back to the plain ladder when nothing has a size to measure against', () => {
    const rail = railFor(null)
    expect(rail).toHaveLength(SCALE_LADDER.length)
    expect(rail[0].isAnchor).toBe(false)
  })

  it('uses the whole track, wherever the camera is', () => {
    // The thumb used to pin itself to the top of the rail at a galaxy and the bottom
    // at a comet, because the track was the fixed ladder's full 30 decades.
    const rail = railFor(anchorAt(4.63e20))
    expect(railFraction(rail[0].spanMetres, rail)).toBeCloseTo(1, 5)
    expect(railFraction(rail[rail.length - 1].spanMetres, rail)).toBeCloseTo(0, 5)
    const middle = railFraction(rail[2].spanMetres, rail)
    expect(middle).toBeGreaterThan(0.05)
    expect(middle).toBeLessThan(0.95)
  })

  it('states a size, not a solar-system landmark, away from the planets', () => {
    const atQuasar = railFor({ radiusMetres: 1.95e14, name: 'TON 618', objectClass: 'black-hole', inSolarSystem: false })
    const oort = atQuasar.find((rung) => rung.id === 'oort')!
    expect(oort.caption).toMatch(/light-years/)
    const atEarth = railFor({ radiusMetres: 6.371e6, name: 'Earth', objectClass: 'planet', inSolarSystem: true })
    expect(atEarth.find((rung) => rung.id === 'oort')!.caption).toMatch(/icy bodies/)
  })
})

describe('search designations', () => {
  it('does not make the id prefix a searchable alias', () => {
    // Every star is registered as `star:<n>`. With the full id in the alias list a
    // query of "star" prefix-matched 600 of them above any name match, and the result
    // list filled with Ain, Ran and Kui while Barnard's Star never appeared.
    expect(aliasesFor('star:70890', 'Proxima Centauri', null)).not.toContain('star:70890')
    expect(aliasesFor('star:70890', 'Proxima Centauri', null)).toContain('70890')
    expect(aliasesFor('ngc:NGC0224', 'Andromeda Galaxy', null)).toContain('ngc224')
  })

  it('folds presentation out of a designation but keeps identity', () => {
    expect(aliasesFor('ngc:IC2431 NED02', 'IC 2431 NED02', null)).toContain('ic2431ned02')
    expect(aliasesFor('m31', 'M31', null)).toContain('m31')
  })

  it('will not let one catalogue number match the head of a longer one', () => {
    expect(aliasContains('ngc224', 'ngc224')).toBe(true)
    expect(aliasContains('xngc224', 'ngc224')).toBe(true)
    expect(aliasContains('ngc2244', 'ngc224')).toBe(false)
    // A non-digit tail is free to extend: "crab" still matches "crabnebula".
    expect(aliasContains('crabnebula', 'crab')).toBe(true)
  })
})
