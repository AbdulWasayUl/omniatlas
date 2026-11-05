import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  type ExoplanetSystemRow,
  describeMeasuredWorld,
  measuredSystem,
  radiusFromMassEarths,
} from '../../src/data/exoplanets'

/**
 * The planets that are actually there.
 *
 * The atlas shipped a NASA Exoplanet Archive match manifest from the day the star data
 * was built, and nothing read it — so immersive mode invented planets around 130 named
 * stars whose real systems are in the literature. Cervantes has four measured planets
 * and was being drawn with invented ones. That is the single thing this atlas is built
 * not to do, and it was happening in the one mode whose whole job is honesty about
 * invention.
 *
 * These tests are about the line between the two. Not whether the numbers are pretty —
 * whether each one can say where it came from.
 */

const row = (over: Partial<ExoplanetSystemRow> = {}): ExoplanetSystemRow => ({
  host: '55 Cnc',
  star: 4849,
  tier: 'l1',
  via: 'gaia_dr3',
  teffK: 5172,
  radiusSun: 0.943,
  massSun: 0.905,
  planets: [
    {
      name: '55 Cnc e',
      semiMajorAxisAu: 0.01544,
      periodDays: 0.7365474,
      radiusEarths: 1.875,
      massEarths: 7.99,
      eccentricity: 0.05,
      inclinationDeg: 83.59,
      equilibriumK: null,
    },
  ],
  ...over,
})

describe('measuredSystem', () => {
  it('keeps the archive’s numbers rather than inventing its own', () => {
    const system = measuredSystem(row(), 'star:4849')!
    const world = system.planets[0]
    expect(world.radiusMetres / 6.371e6).toBeCloseTo(1.875, 3)
    expect(world.massKg / 5.9722e24).toBeCloseTo(7.99, 2)
    expect(world.semiMajorAxisMetres / 1.495978707e11).toBeCloseTo(0.01544, 5)
    expect(world.periodDays).toBeCloseTo(0.7365474, 6)
    expect(world.eccentricity).toBeCloseTo(0.05, 3)
  })

  it('says which of a world’s numbers were published', () => {
    const world = measuredSystem(row(), 'star:4849')!.planets[0]
    expect(world.measured.semiMajorAxis).toBe(true)
    expect(world.measured.radius).toBe(true)
    expect(world.measured.mass).toBe(true)
    // The archive published no equilibrium temperature for this row, so the one shown
    // is computed and must not claim otherwise.
    expect(world.measured.equilibrium).toBe(false)
    expect(world.equilibriumK).toBeGreaterThan(1000)
  })

  it('builds an id that carries its own host, in four characters like `gen:`', () => {
    const world = measuredSystem(row(), 'star:4849')!.planets[0]
    expect(world.id).toBe('exo:star:4849/55-cnc-e')
    // `urlState` slices the host out of a generated or measured id with one `slice(4)`.
    expect('exo:'.length).toBe('gen:'.length)
    expect(world.id.slice(4).split('/')[0]).toBe('star:4849')
  })

  it('never produces a `gen:` id, which is what marks a thing invented', () => {
    for (const world of measuredSystem(row(), 'star:4849')!.planets) {
      expect(world.id.startsWith('gen:')).toBe(false)
    }
  })

  it('is the same system every time, so a shared link shows the same planet', () => {
    const a = measuredSystem(row(), 'star:4849')!
    const b = measuredSystem(row(), 'star:4849')!
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('derives a period from a separation when the archive gives only one', () => {
    const system = measuredSystem(
      row({ planets: [{ ...row().planets[0], periodDays: null }] }),
      'star:4849',
    )!
    const world = system.planets[0]
    expect(world.measured.period).toBe(false)
    // Kepler, for 0.01544 AU about 0.905 solar masses: well under a day.
    expect(world.periodDays).toBeGreaterThan(0.5)
    expect(world.periodDays).toBeLessThan(0.9)
  })

  it('drops a planet that has no orbit at all rather than placing it at a guess', () => {
    const system = measuredSystem(
      row({ planets: [{ ...row().planets[0], semiMajorAxisAu: null, periodDays: null }] }),
      'star:4849',
    )
    expect(system).toBeNull()
  })

  it('returns null for a row with nothing placeable, so invention is not stood down for nothing', () => {
    expect(measuredSystem(row({ planets: [] }), 'star:4849')).toBeNull()
  })

  it('orders the planets outward from the star', () => {
    const system = measuredSystem(
      row({
        planets: [
          { ...row().planets[0], name: 'far', semiMajorAxisAu: 5.6 },
          { ...row().planets[0], name: 'near', semiMajorAxisAu: 0.01 },
          { ...row().planets[0], name: 'mid', semiMajorAxisAu: 0.8 },
        ],
      }),
      'star:4849',
    )!
    expect(system.planets.map((p) => p.name)).toEqual(['near', 'mid', 'far'])
  })

  it('falls back to solar values for a star the archive did not characterise', () => {
    const system = measuredSystem(row({ teffK: null, radiusSun: null, massSun: null }), 'star:4849')!
    expect(system.star.temperatureK).toBe(5772)
    expect(system.star.luminositySun).toBeCloseTo(1, 3)
  })
})

describe('radiusFromMassEarths', () => {
  it('rises through the terran and neptunian regimes', () => {
    expect(radiusFromMassEarths(1)).toBeCloseTo(1, 2)
    expect(radiusFromMassEarths(2)).toBeGreaterThan(radiusFromMassEarths(1))
    expect(radiusFromMassEarths(50)).toBeGreaterThan(radiusFromMassEarths(2))
    expect(radiusFromMassEarths(130)).toBeGreaterThan(radiusFromMassEarths(50))
  })

  it('stops rising above a Jupiter, which is the whole point of the third branch', () => {
    // Degeneracy pressure: a heavier gas giant is very slightly SMALLER, not larger.
    expect(radiusFromMassEarths(2000)).toBeLessThan(radiusFromMassEarths(200))
    // ...and still recognisably Jupiter-sized rather than collapsing to nothing.
    expect(radiusFromMassEarths(318)).toBeGreaterThan(9)
    expect(radiusFromMassEarths(318)).toBeLessThan(16)
  })

  it('is continuous across both breaks', () => {
    for (const m of [2.04, 132]) {
      const below = radiusFromMassEarths(m * 0.999)
      const above = radiusFromMassEarths(m * 1.001)
      expect(Math.abs(above - below) / below).toBeLessThan(0.01)
    }
  })
})

describe('describeMeasuredWorld', () => {
  const world = measuredSystem(row(), 'star:4849')!.planets[0]

  it('gives the numbers rather than prose invented about a real place', () => {
    const text = describeMeasuredWorld(world, 'Copernicus')
    expect(text).toContain('Copernicus')
    expect(text).toContain('Earth radii')
    expect(text).toContain('Earth masses')
    expect(text).toMatch(/hours|days|years/)
  })

  it('marks a value the archive did not publish', () => {
    const text = describeMeasuredWorld(world, 'Copernicus')
    // Equilibrium temperature was null in this row.
    expect(text).toContain('computed from the star')
  })

  it('does not mark a value the archive did publish', () => {
    const text = describeMeasuredWorld(world, 'Copernicus')
    expect(text).not.toContain('(derived)')
    expect(text).not.toContain('estimated from its mass')
  })
})

/**
 * Source-level, for the same reason `texture-request` is: the invariant is about wiring,
 * and wiring that is merely absent compiles perfectly.
 */
describe('the renderer’s side of the bargain', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src')
  const module = fs.readFileSync(path.join(SRC, 'modules/systems/index.ts'), 'utf8')

  it('does not hide measured planets behind the invention toggle', () => {
    // `engine.immersive` governs INVENTION. A planet that is actually there is not an
    // imagined world and must not need a switch labelled one.
    expect(module).not.toMatch(/const wanted = this\.engine\.immersive \?/)
    expect(module).toMatch(/if \(this\.measuredRowFor\(starId\)\) return starId/)
  })

  it('still gates invention on it', () => {
    expect(module).toMatch(/this\.engine\.immersive && canHostInventedSystem/)
  })

  it('prefers the archive over the generator when both could answer', () => {
    expect(module).toMatch(/const fromArchive = row \? measuredSystem\(row, starId\) : null/)
    expect(module).toMatch(/fromArchive \?\?/)
  })

  it('gives a measured node the measured chip and an invented one the illustration chip', () => {
    expect(module).toMatch(/provenance: this\.measured \? 'measured' : 'illustration'/)
  })
})

/**
 * The shipped file, against the manifest it was built from.
 *
 * Two files describe the same join — `exoplanets.json` says WHICH star, and
 * `exoplanet-systems.json` says what is orbiting it — and they are produced by two
 * different scripts. If they ever disagree about which star a planet belongs to, the
 * atlas puts a real planet around the wrong sun, which is worse than not drawing it.
 */
describe('the shipped exoplanet data', () => {
  const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/data/stars')
  const systems = JSON.parse(fs.readFileSync(path.join(DATA, 'exoplanet-systems.json'), 'utf8'))
  const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'exoplanets.json'), 'utf8'))

  it('agrees with the match manifest about which star each host is', () => {
    const byHost = new Map<string, number>()
    for (const h of manifest.matchedHosts) if (h.star !== null) byHost.set(h.host, h.star)
    for (const s of systems.systems) {
      expect(byHost.get(s.host), `${s.host} is not a matched host`).toBe(s.star)
    }
  })

  it('carries only hosts with a placeable star index', () => {
    for (const s of systems.systems) expect(Number.isInteger(s.star)).toBe(true)
  })

  it('gives every planet something to be placed by', () => {
    for (const s of systems.systems) {
      for (const p of s.planets) {
        expect(p.semiMajorAxisAu !== null || p.periodDays !== null, `${p.name} has no orbit`).toBe(true)
      }
    }
  })

  it('builds a usable system from every row it ships', () => {
    let built = 0
    for (const s of systems.systems) {
      const system = measuredSystem(s, `star:${s.star}`)
      if (system) {
        built += 1
        for (const w of system.planets) expect(w.radiusMetres).toBeGreaterThan(0)
      }
    }
    // Every row was written because it had a placeable planet; none should fail here.
    expect(built).toBe(systems.systems.length)
  })

  it('actually covers stars the atlas can visit', () => {
    // A dataset that joins to nothing visitable would pass every test above and change
    // nothing on screen, which is the failure mode worth guarding.
    const names = JSON.parse(fs.readFileSync(path.join(DATA, 'names.json'), 'utf8'))
    const named = new Set<number>(
      names.stars.filter((r: { proper?: string }) => r.proper).map((r: { i: number }) => r.i),
    )
    const visitable = systems.systems.filter((s: { star: number }) => named.has(s.star))
    expect(visitable.length).toBeGreaterThan(100)
  })
})
