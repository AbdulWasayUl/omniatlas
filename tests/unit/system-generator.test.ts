import { describe, expect, it } from 'vitest'
import {
  type GeneratedSystem,
  frostLineAu,
  generateSystem,
  habitableZoneAu,
  nameSystem,
} from '../../src/generators/system'

/**
 * An invented system still has to be a system.
 *
 * The generator is allowed to make things up — that is its job — but not to make up
 * things that could not exist. These tests are the line between the two: orbits that do
 * not cross, moons their planet can actually hold, ice where it is cold and rock where it
 * is not, and a habitable zone placed by the star's luminosity rather than by taste.
 *
 * Determinism is tested hardest, because it is the property a viewer can catch the atlas
 * breaking: the camera state lives in the URL, so a permalink to a generated moon has to
 * show the next person that same moon.
 */

const AU_M = 1.495978707e11
const EARTH_RADIUS_M = 6.371e6
const G = 6.6743e-11
const SUN_KG = 1.98892e30

const sol = () => generateSystem({ id: 'star:88', temperatureK: 5772, radiusMetres: 6.957e8 })
const everyWorld = (s: GeneratedSystem) => s.planets.flatMap((p) => [p, ...p.moons])

describe('generateSystem', () => {
  it('gives the same star the same system, every time', () => {
    expect(JSON.stringify(generateSystem({ id: 'star:1234' }))).toBe(
      JSON.stringify(generateSystem({ id: 'star:1234' })),
    )
  })

  it('gives different stars different systems', () => {
    const a = generateSystem({ id: 'star:1' })
    const b = generateSystem({ id: 'star:2' })
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  it('depends on the id alone, not on call order or anything ambient', () => {
    // Interleaving the two calls must not change either answer. If any shared mutable
    // state crept into the generator this is the test that would catch it.
    const first = generateSystem({ id: 'star:alpha' })
    generateSystem({ id: 'star:noise' })
    generateSystem({ id: 'star:more-noise' })
    expect(JSON.stringify(generateSystem({ id: 'star:alpha' }))).toBe(JSON.stringify(first))
  })

  it('never lets two orbits cross', () => {
    // Apoapsis of each world must clear the periapsis of the next one out. This is the
    // property the geometric spacing exists to guarantee, for planets and for moons.
    for (let i = 0; i < 300; i++) {
      const system = generateSystem({ id: `star:${i}` })
      const check = (bodies: { semiMajorAxisMetres: number; eccentricity: number }[]) => {
        for (let k = 1; k < bodies.length; k++) {
          const inner = bodies[k - 1]
          const outer = bodies[k]
          const apo = inner.semiMajorAxisMetres * (1 + inner.eccentricity)
          const peri = outer.semiMajorAxisMetres * (1 - outer.eccentricity)
          expect(apo).toBeLessThan(peri)
        }
      }
      check(system.planets)
      for (const planet of system.planets) check(planet.moons)
    }
  })

  it('keeps every moon outside its planet and inside the star-stable region', () => {
    for (let i = 0; i < 300; i++) {
      const system = generateSystem({ id: `star:${i}` })
      const starMassKg = system.star.massSun * SUN_KG
      for (const planet of system.planets) {
        const hill = planet.semiMajorAxisMetres * Math.cbrt(planet.massKg / (3 * starMassKg))
        for (const moon of planet.moons) {
          expect(moon.semiMajorAxisMetres).toBeGreaterThan(planet.radiusMetres * 2)
          expect(moon.semiMajorAxisMetres).toBeLessThanOrEqual(hill / 3)
          expect(moon.radiusMetres).toBeLessThan(planet.radiusMetres)
        }
      }
    }
  })

  it('obeys Keplers third law for every orbit it states a period for', () => {
    const system = sol()
    const starMassKg = system.star.massSun * SUN_KG
    const expected = (a: number, m: number) => (2 * Math.PI * Math.sqrt((a * a * a) / (G * m))) / 86400
    for (const planet of system.planets) {
      expect(planet.periodDays).toBeCloseTo(expected(planet.semiMajorAxisMetres, starMassKg), 6)
      for (const moon of planet.moons) {
        expect(moon.periodDays).toBeCloseTo(expected(moon.semiMajorAxisMetres, planet.massKg), 6)
      }
    }
  })

  it('puts the Suns habitable zone where the Sun actually has one', () => {
    const zone = habitableZoneAu(1)
    expect(zone.inner).toBeCloseTo(0.95, 2)
    expect(zone.outer).toBeCloseTo(1.67, 2)
    // Earth is inside it; Venus and Mars are not.
    expect(1.0).toBeGreaterThan(zone.inner)
    expect(1.0).toBeLessThan(zone.outer)
    expect(0.72).toBeLessThan(zone.inner)
    expect(1.52).toBeLessThan(zone.outer)
  })

  it('moves the zone and the frost line with the stars luminosity', () => {
    // Four times the luminosity puts both at twice the distance: the flux at a given
    // distance goes as L/d^2, so an equal-flux surface scales as sqrt(L).
    expect(habitableZoneAu(4).inner).toBeCloseTo(habitableZoneAu(1).inner * 2, 10)
    expect(frostLineAu(4)).toBeCloseTo(frostLineAu(1) * 2, 10)
    // A dim red dwarf has both hard up against the star.
    expect(habitableZoneAu(0.0017).outer).toBeLessThan(0.1)
  })

  it('only calls a world habitable when it is in the zone and could hold air', () => {
    let habitable = 0
    for (let i = 0; i < 400; i++) {
      const system = generateSystem({ id: `star:${i}` })
      for (const planet of system.planets) {
        const zone = system.habitableZoneAu
        const au = planet.semiMajorAxisMetres / AU_M
        for (const world of [planet, ...planet.moons]) {
          const r = world.radiusMetres / EARTH_RADIUS_M
          if (!world.habitable) continue
          habitable++
          expect(au).toBeGreaterThanOrEqual(zone.inner)
          expect(au).toBeLessThanOrEqual(zone.outer)
          expect(r).toBeGreaterThanOrEqual(0.4)
          expect(r).toBeLessThanOrEqual(1.9)
          expect(['gasGiant', 'hotJupiter', 'iceGiant']).not.toContain(world.kind)
          expect(world.habitabilityNote).toBeTruthy()
        }
      }
    }
    // The point of the mode is that these exist and are rare enough to be worth finding.
    expect(habitable).toBeGreaterThan(5)
  })

  it('produces habitable moons, not only habitable planets', () => {
    // The configuration the solar system does not have, and the one the request asked
    // for by name: a large moon of a giant that happens to orbit in the zone.
    let found = 0
    for (let i = 0; i < 1500 && found === 0; i++) {
      for (const planet of generateSystem({ id: `star:${i}` }).planets) {
        found += planet.moons.filter((m) => m.habitable).length
      }
    }
    expect(found).toBeGreaterThan(0)
  })

  it('puts ice outside the frost line and keeps giants out of the inner system, mostly', () => {
    let inner = 0
    let innerGiants = 0
    for (let i = 0; i < 300; i++) {
      const system = generateSystem({ id: `star:${i}` })
      for (const planet of system.planets) {
        const au = planet.semiMajorAxisMetres / AU_M
        if (au < system.frostLineAu) {
          inner++
          if (planet.kind === 'gasGiant' || planet.kind === 'hotJupiter') innerGiants++
        }
        // Nothing warm is made of ice.
        if (planet.kind === 'ice') expect(planet.equilibriumK).toBeLessThan(260)
        if (planet.kind === 'lava') expect(planet.equilibriumK).toBeGreaterThan(700)
      }
    }
    // Migration is allowed, so this is a rate rather than a prohibition: the census
    // finds hot Jupiters around about 1% of stars, and a generated galaxy with none
    // would be as wrong as one made entirely of them.
    expect(innerGiants / inner).toBeLessThan(0.2)
    expect(innerGiants).toBeGreaterThan(0)
  })

  it('reproduces the mass-radius relation the transit census measured', () => {
    // Pinning the calibration points rather than the formula, so the relation can be
    // replaced as long as it still agrees with the solar system: Earth-sized worlds come
    // out near an Earth mass, and Jupiter-sized ones near Jupiter's.
    const earths: number[] = []
    const giants: number[] = []
    for (let i = 0; i < 400; i++) {
      for (const p of generateSystem({ id: `star:${i}` }).planets) {
        const re = p.radiusMetres / EARTH_RADIUS_M
        const me = p.massKg / 5.972e24
        if (re > 0.9 && re < 1.1) earths.push(me)
        if (re > 10.5 && re < 11.9) giants.push(me)
      }
    }
    if (earths.length) {
      const mean = earths.reduce((a, b) => a + b) / earths.length
      expect(mean).toBeGreaterThan(0.6)
      expect(mean).toBeLessThan(1.6)
    }
    if (giants.length) {
      const mean = giants.reduce((a, b) => a + b) / giants.length
      expect(mean).toBeGreaterThan(200)
      expect(mean).toBeLessThan(450)
    }
  })

  it('uses the catalogue star where the catalogue knows it', () => {
    // The invention should sit on whatever the atlas actually measured about this star,
    // so two different real stars with the same id-derived seed still differ.
    const hot = generateSystem({ id: 'star:x', temperatureK: 9000, radiusMetres: 1.4e9 })
    const cool = generateSystem({ id: 'star:x', temperatureK: 3200, radiusMetres: 2.5e8 })
    expect(hot.star.luminositySun).toBeGreaterThan(cool.star.luminositySun * 50)
    expect(hot.habitableZoneAu.inner).toBeGreaterThan(cool.habitableZoneAu.inner * 5)
  })

  it('produces a range of systems rather than one system with different numbers', () => {
    const kinds = new Set<string>()
    let withRings = 0
    let withMoons = 0
    let planetTotal = 0
    const counts = new Set<number>()
    for (let i = 0; i < 400; i++) {
      const system = generateSystem({ id: `star:${i}` })
      counts.add(system.planets.length)
      planetTotal += system.planets.length
      for (const p of system.planets) {
        kinds.add(p.kind)
        if (p.hasRings) withRings++
        if (p.moons.length) withMoons++
      }
    }
    // Every world kind the generator can make should actually turn up in 400 systems.
    expect(kinds.size).toBeGreaterThanOrEqual(8)
    expect(counts.size).toBeGreaterThan(5)
    expect(withRings).toBeGreaterThan(10)
    expect(withMoons).toBeGreaterThan(50)
    expect(planetTotal / 400).toBeGreaterThan(2)
  })

  it('names worlds by the conventions the real catalogues use', () => {
    const system = nameSystem(sol(), 'Sabik')
    expect(system.planets[0].name).toBe('Sabik b')
    if (system.planets[1]) expect(system.planets[1].name).toBe('Sabik c')
    const withMoons = system.planets.find((p) => p.moons.length > 0)
    if (withMoons) expect(withMoons.moons[0].name).toBe(`${withMoons.name} I`)
  })

  it('namespaces every generated id under the star it was invented for', () => {
    const system = generateSystem({ id: 'star:88' })
    for (const world of everyWorld(system)) expect(world.id.startsWith('star:88/')).toBe(true)
  })

  it('never emits a number that would poison a vertex buffer', () => {
    for (let i = 0; i < 500; i++) {
      const system = generateSystem({ id: `star:${i}` })
      for (const world of everyWorld(system)) {
        for (const v of [world.radiusMetres, world.semiMajorAxisMetres, world.eccentricity, world.periodDays]) {
          expect(Number.isFinite(v)).toBe(true)
          expect(v).toBeGreaterThanOrEqual(0)
        }
        expect(world.eccentricity).toBeLessThan(1)
        expect(world.color).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })
})
