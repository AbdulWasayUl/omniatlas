import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { Engine, type SceneNodeHandle } from '../../src/core/Engine'
import { SurfaceModule, surfaceDirection } from '../../src/modules/surface'
import { vec3d } from '../../src/core/world'

/**
 * Named places on Earth and the Moon.
 *
 * The thing worth testing is the placement convention, because getting it wrong is
 * SILENT: every crater lands somewhere on the Moon, the picture looks entirely
 * plausible, and Tycho is on the far side. So the checks here are facts that do not
 * depend on the convention being right — great-circle separations between known
 * places, and which hemisphere a tidally-locked body shows us.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public')

beforeAll(() => {
  ;(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
    const file = ROOT + String(url)
    if (!fs.existsSync(file)) return { ok: false, status: 404 }
    const buffer = fs.readFileSync(file)
    return { ok: true, status: 200, json: async () => JSON.parse(buffer.toString('utf8')) }
  }
  ;(globalThis as { window?: unknown }).window = { devicePixelRatio: 1 }
})

/** Angle between two body-fixed directions, degrees. */
function separationDeg(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z
  return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI
}

describe('the latitude and longitude convention', () => {
  it('puts the poles and the prime meridian where the sphere geometry puts them', () => {
    // SphereGeometry's default mapping, which SphereBody uses unmodified: +Y north,
    // +X at longitude zero, longitude increasing towards -Z.
    const north = surfaceDirection(vec3d(), 90, 0)
    expect(north.y).toBeCloseTo(1, 9)
    const prime = surfaceDirection(vec3d(), 0, 0)
    expect(prime.x).toBeCloseTo(1, 9)
    const east = surfaceDirection(vec3d(), 0, 90)
    expect(east.z).toBeCloseTo(-1, 9)
  })

  it('reproduces real great-circle distances between cities', () => {
    // Rotation-independent, so this tests the mapping and nothing else. Tokyo to
    // London is about 9,560 km, which on a 6,371 km sphere is 85.9 degrees.
    const tokyo = surfaceDirection(vec3d(), 35.686963, 139.749462)
    const london = surfaceDirection(vec3d(), 51.5, -0.1167)
    expect(separationDeg(tokyo, london)).toBeCloseTo(86, 0)

    // Sydney to Rio de Janeiro, about 13,520 km: 121.6 degrees.
    const sydney = surfaceDirection(vec3d(), -33.92, 151.185)
    const rio = surfaceDirection(vec3d(), -22.925, -43.225)
    expect(separationDeg(sydney, rio)).toBeCloseTo(121.6, 0)
  })
})

describe('the lunar craters', () => {
  async function boot(): Promise<{ engine: Engine; module: SurfaceModule }> {
    const engine = new Engine({ renderer: {} as never })
    // The features hang off their body's node, which the solar module owns.
    for (const [id, x] of [
      ['earth', 0],
      ['moon', 3.844e8],
    ] as const) {
      engine.register({
        id,
        name: id,
        worldPosition: vec3d(x, 0, 0),
        frame: 'icrf',
        radiusMetres: id === 'earth' ? 6.371e6 : 1.7374e6,
        layer: 'system',
        objectClass: 'planet',
        parentId: null,
      } as SceneNodeHandle)
    }
    const module = new SurfaceModule()
    await module.init(engine)
    return { engine, module }
  }

  it('reads the catalogue nothing was reading', async () => {
    const { module } = await boot()
    // 1,615 IAU craters and 1,251 cities have been shipping in public/data since the
    // overhaul with no code path that loaded them.
    expect(module.manifest.craters).toBeGreaterThan(1500)
    expect(module.manifest.cities).toBeGreaterThan(1200)
    module.dispose?.()
  })

  it('keeps a near-side crater on the near side', async () => {
    const { engine, module } = await boot()
    // Tycho is at 11.4 degrees WEST, which is near-side; Tsiolkovskiy is at 129 EAST,
    // which is famously far-side. Separation from the sub-Earth point (longitude 0 on
    // a tidally locked body) is what tells them apart, and it is independent of where
    // the Moon happens to be in its orbit.
    const subEarth = surfaceDirection(vec3d(), 0, 0)
    const tycho = surfaceDirection(vec3d(), -43.31, -11.36)
    const tsiolkovskiy = surfaceDirection(vec3d(), -20.4, 129.1)
    expect(separationDeg(tycho, subEarth)).toBeLessThan(90)
    expect(separationDeg(tsiolkovskiy, subEarth)).toBeGreaterThan(90)
    expect(engine.registry.has('moon-crater-tycho')).toBe(true)
    module.dispose?.()
  })

  it('states the diameter as measured and the picture as absent', async () => {
    const { engine, module } = await boot()
    const hertzsprung = engine.node('moon-crater-hertzsprung') as
      | { radiusMetres: number; provenance?: string; provenanceNote?: string }
      | null
    // 536.37 km across, from the USGS gazetteer.
    expect(hertzsprung?.radiusMetres).toBeCloseTo(268_185, 0)
    expect(hertzsprung?.provenance).toBe('measured')
    // The honest half: the geometry is good at this scale and the imagery is not.
    expect(hertzsprung?.provenanceNote).toMatch(/2\.7 km per pixel/)
    module.dispose?.()
  })

  it('moves every feature with the body it is on', async () => {
    const { engine, module } = await boot()
    const node = engine.node('moon-crater-tycho') as SceneNodeHandle
    const before = { ...node.worldPosition }
    const ctx = { epochMs: Date.parse('2026-01-01T00:00:00Z'), engine } as never
    module.update?.(ctx)
    const placed = { ...node.worldPosition }
    // It starts at the origin and must end up on the Moon's surface, one lunar radius
    // from the Moon's centre.
    expect(placed).not.toEqual(before)
    const moon = engine.node('moon') as SceneNodeHandle
    const r = Math.hypot(
      placed.x - moon.worldPosition.x,
      placed.y - moon.worldPosition.y,
      placed.z - moon.worldPosition.z,
    )
    expect(r).toBeCloseTo(1.7374e6, 0)
    module.dispose?.()
  })

  it('gives everything back on dispose', async () => {
    const { engine, module } = await boot()
    module.dispose?.()
    expect(engine.registry.has('moon-crater-tycho')).toBe(false)
    let remaining = 0
    engine.layer('surface').scene.traverse((object) => {
      if (object.name.startsWith('surface:')) remaining++
    })
    expect(remaining).toBe(0)
  })
})
