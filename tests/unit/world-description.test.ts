import { describe, expect, it } from 'vitest'
import { describeWorld } from '../../src/generators/description'
import { type WorldKind, WORLD_KINDS, generateSystem } from '../../src/generators/system'

/**
 * A description has to be about ONE world.
 *
 * What this replaces was a sentence per kind, so every desert in the atlas read
 * identically and the two hundredth told you nothing the first had not. That is fine for
 * a legend and useless for a place.
 */

const sample = (limit = 400) => {
  const out: ReturnType<typeof describeWorld>[] = []
  for (let i = 0; i < limit; i++) {
    const system = generateSystem({ id: `star:${i}` })
    for (const planet of system.planets) {
      out.push(
        describeWorld({
          id: planet.id,
          kind: planet.kind,
          radiusMetres: planet.radiusMetres,
          semiMajorAxisMetres: planet.semiMajorAxisMetres,
          periodDays: planet.periodDays,
          equilibriumK: planet.equilibriumK,
          starRadiusMetres: system.star.radiusMetres,
          starDistanceMetres: planet.semiMajorAxisMetres,
          moonCount: planet.moons.length,
          hasRings: planet.hasRings,
          habitable: planet.habitable,
          isMoon: false,
        }),
      )
    }
  }
  return out
}

describe('describeWorld', () => {
  it('says the same thing about the same world, every time', () => {
    const one = { id: 'star:7/b', kind: 'ocean' as WorldKind, radiusMetres: 7e6, semiMajorAxisMetres: 1.5e11,
      periodDays: 365, starRadiusMetres: 6.957e8, starDistanceMetres: 1.5e11, moonCount: 1,
      hasRings: false, habitable: true, isMoon: false }
    expect(describeWorld(one)).toBe(describeWorld({ ...one }))
  })

  it('says something different about different worlds', () => {
    const texts = sample()
    const unique = new Set(texts)
    // Not every description need be unique, but near-enough: a reader should be able to
    // visit a hundred worlds without meeting the same paragraph twice.
    expect(unique.size / texts.length).toBeGreaterThan(0.9)
  })

  it('can describe every kind the generator can produce', () => {
    for (const kind of Object.keys(WORLD_KINDS) as WorldKind[]) {
      const text = describeWorld({
        id: `probe/${kind}`, kind, radiusMetres: 6.4e6, semiMajorAxisMetres: 2e11, periodDays: 500,
        starRadiusMetres: 6.957e8, starDistanceMetres: 2e11, moonCount: 2, hasRings: true,
        habitable: false, isMoon: false,
      })
      expect(text.length, kind).toBeGreaterThan(60)
      expect(text.trim().endsWith('.'), kind).toBe(true)
    }
  })

  it('never uses an em dash', () => {
    // House style, and the reason is practical: they are the signature of machine
    // writing and they flatten everything into one voice.
    for (const text of sample(120)) expect(text).not.toMatch(/—/)
  })

  it('always carries something concrete, not only mood', () => {
    // Every description should contain a number, a direction or a named object. A
    // paragraph of atmosphere that could be about anywhere is the failure mode here.
    for (const text of sample(120)) {
      expect(text, text).toMatch(/\d|north|south|east|west|pole|equator|horizon|core|crust|star|moon/i)
    }
  })

  it('weaves in the orbit it was given rather than inventing a second one', () => {
    const text = describeWorld({
      id: 'x/b', kind: 'rocky', radiusMetres: 5e6, semiMajorAxisMetres: 1e11, periodDays: 12.3,
      starRadiusMetres: 6.957e8, starDistanceMetres: 1e11, moonCount: 0, hasRings: false,
      habitable: false, isMoon: false,
    })
    // The year is short enough that the generator must state it in days.
    expect(text).toMatch(/12\.3 days|year/i)
  })
})
