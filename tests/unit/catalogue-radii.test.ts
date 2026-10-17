import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { Engine, type SceneNodeHandle } from '../../src/core/Engine'
import { AU_M, MPC_M, PC_M } from '../../src/core/world'

/**
 * The standing rule the catalogue modules keep breaking, pinned as a test.
 *
 * `radiusMetres` is what the inspector prints under "Mean radius" and what the proxy
 * module sizes a stand-in shape from. It may only ever hold a size the catalogue
 * states for that object. Every number that exists so the camera has something to
 * stop at — a class median, a virial radius scaled from a member count, the angular
 * size of a region, the separation of a double star — belongs in
 * `framingRadiusMetres`, which nothing presents as a property of the object.
 *
 * Three waves of fixes have each re-broken this in a different module, always for the
 * same reason: a destination with no radius drew nothing on arrival, so a placeholder
 * was written into the field that makes arrival work. These cases are the ones that
 * were caught by eye in the running app, which is an expensive way to find them.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public')

beforeAll(() => {
  ;(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
    const file = ROOT + String(url)
    if (!fs.existsSync(file)) return { ok: false, status: 404 }
    const buffer = fs.readFileSync(file)
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(buffer.toString('utf8')),
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      text: async () => buffer.toString('utf8'),
    }
  }
  ;(globalThis as { window?: unknown }).window = { devicePixelRatio: 1 }
  ;(globalThis as { document?: unknown }).document = {
    createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} }),
    createElement: () => ({ addEventListener() {}, removeEventListener() {}, getContext: () => null, style: {} }),
  }
})

/** Boot one module against the real data files and hand back its registry. */
async function registryOf(load: () => Promise<{ init(engine: Engine): Promise<void> }>): Promise<Engine> {
  const engine = new Engine({ renderer: {} as never })
  const module = await load()
  await module.init(engine)
  return engine
}

/** What the camera actually flies to; mirrors AtlasViewer.focus. */
function framingRadius(node: SceneNodeHandle): number {
  return node.radiusMetres > 0 ? node.radiusMetres : (node.framingRadiusMetres ?? 0)
}

describe('smallbodies: an unmeasured comet nucleus', () => {
  it('frames on the class median without reporting it as a radius', async () => {
    const engine = await registryOf(async () => new (await import('../../src/modules/smallbodies')).SmallBodiesModule())
    const comets = [...engine.registry.values()].filter((n) => n.objectClass === 'comet')
    expect(comets.length).toBeGreaterThan(20)

    // 1300 m is the Jupiter-family median from NOMINAL_COMET_NUCLEUS_RADIUS_M. It is a
    // statement about the population, so it may not appear as this object's radius.
    const asRadius = comets.filter((n) => n.radiusMetres === 1300)
    expect(asRadius.map((n) => n.name)).toEqual([])

    const unmeasured = comets.filter((n) => n.radiusMetres === 0)
    expect(unmeasured.length).toBeGreaterThan(20)
    for (const node of unmeasured) {
      expect(node.framingRadiusMetres, `${node.name} has nothing to frame on`).toBe(1300)
      expect(framingRadius(node)).toBe(1300)
    }
  })
})

describe('cosmos: sizes nobody published', () => {
  let engine: Engine
  beforeAll(async () => {
    engine = await registryOf(async () => new (await import('../../src/modules/cosmos')).CosmosModule())
  }, 60_000)

  it('gives a CF4 group a framing size, not a mean radius', () => {
    const groups = [...engine.registry.values()].filter((n) => n.id.startsWith('cf4:'))
    expect(groups.length).toBe(14)
    for (const node of groups) {
      // CF4 rows are a distance, a direction and a member count. No radius at all.
      expect(node.radiusMetres, `${node.id} reports a radius CF4 does not publish`).toBe(0)
      expect(framingRadius(node)).toBeGreaterThan(0.1 * MPC_M)
      expect(framingRadius(node)).toBeLessThan(5 * MPC_M)
    }
  })

  it('gives the Zone of Avoidance no radius, because it is not an object', () => {
    const anchors = [...engine.registry.values()].filter((n) => n.id.startsWith('cosmos:zone-of-avoidance'))
    expect(anchors.length).toBe(2)
    for (const node of anchors) {
      expect(node.radiusMetres).toBe(0)
      // Still reachable: without a framing size the flight stops at the flat 1 Gm
      // fallback, a solar-system distance inside a 769 Mpc shell.
      expect(framingRadius(node)).toBeGreaterThan(10 * MPC_M)
      // And nothing may build a shape for it: `region` is a class no renderer handles.
      expect(node.objectClass).toBe('region')
    }
  })
})

describe('deepsky: an extent that is not an extent', () => {
  let engine: Engine
  beforeAll(async () => {
    engine = await registryOf(async () => new (await import('../../src/modules/deepsky')).DeepSkyModule())
  }, 60_000)

  it('keeps Messier 40 findable without drawing one star where there are two', () => {
    // Winnecke 4: two 9th-magnitude stars 51.7" apart. Its catalogued "major axis" is
    // that separation, so it frames the pair and is not the size of a body.
    const node = engine.registry.get('ngc:M040')
    expect(node, 'Messier 40 is one of the 110 and has to be searchable').toBeDefined()
    expect(node!.radiusMetres).toBe(0)
    const frame = framingRadius(node!)
    expect(frame).toBeGreaterThan(1000 * AU_M)
    expect(frame).toBeLessThan(10_000 * AU_M)
  })

  it('puts the Coalsack at its published distance rather than on the shell', () => {
    const node = engine.registry.get('ngc:C099') as (SceneNodeHandle & { directionOnly?: boolean }) | undefined
    expect(node, 'the Coalsack is a naked-eye object and has to be searchable').toBeDefined()
    // Without a distance it was projected onto the 100 kpc direction-only shell, and
    // flying there put the camera 25 kpc out in intergalactic space looking at nothing.
    expect(node!.directionOnly).toBe(false)
    // 7 degrees of dark nebula at 180 pc is about 11 pc of radius.
    expect(node!.radiusMetres).toBeGreaterThan(5 * PC_M)
    expect(node!.radiusMetres).toBeLessThan(20 * PC_M)
    // A consensus literature figure is not a measurement, and neither is the radius
    // computed from it. The Orion Nebula and the Horsehead are in the same boat.
    const provenanced = node as SceneNodeHandle & { provenance?: string; distanceSource?: string }
    expect(provenanced.distanceSource).toBe('literature')
    expect(provenanced.provenance).toBe('derived')
    const orion = engine.registry.get('ngc:NGC1976') as (SceneNodeHandle & { provenance?: string }) | undefined
    if (orion) expect(orion.provenance).toBe('derived')
  })

  it('still rejects the duplicate and nonexistent rows', () => {
    // M102 is a Dup of M101 with no coordinates of its own; registering it put a
    // second 'Messier 101' four megaparsecs from the real one.
    expect(engine.registry.get('ngc:M102')).toBeUndefined()
    expect(engine.registry.get('ngc:NGC6994')).toBeDefined()
  })
})

describe('galaxy: a catalogued galaxy with no catalogued size', () => {
  it('registers And XXX rather than leaving it to a module that also drops it', async () => {
    const engine = await registryOf(async () => new (await import('../../src/modules/galaxy')).GalaxyModule())
    const rows = [...engine.registry.values()].filter((n) => /and\s*xxx\b/i.test(n.name))
    // localgroup.json is the row's home, so this module owns it. The cosmos module
    // skips its UNGC row for want of a size and says so, naming this module as the
    // owner — when both skipped it, a catalogued M31 satellite left the atlas.
    expect(rows.map((n) => n.name)).toHaveLength(1)
    const node = rows[0]
    // No D25 major axis anywhere, so no radius and no framing size either: the flight
    // falls back to the span the galactic layer is built for.
    expect(node.radiusMetres).toBe(0)
    expect(node.framingRadiusMetres ?? 0).toBe(0)
  }, 60_000)
})

describe('solar: the shape the camera has to stop outside of', () => {
  it('publishes the drawn equator of a flattened planet, and nothing for a round one', async () => {
    // SphereBody draws an oblate planet at mean / cbrt(polarRatio), so a camera floor
    // measured from the mean radius parks inside the silhouette: at Saturn the wheel
    // bottomed out 2,030 km under its own drawn equator, with the near plane clipping
    // the front of the planet away and the constellation lines showing through it.
    const engine = await registryOf(async () => {
      const { SolarModule } = await import('../../src/modules/solar')
      return new SolarModule()
    })
    const saturn = engine.node('saturn')!
    const jupiter = engine.node('jupiter')!
    const earth = engine.node('earth')!
    expect(saturn.shapeRatio).toBeCloseTo(1.035, 2)
    expect(jupiter.shapeRatio).toBeCloseTo(1.0226, 3)
    // A body the renderer draws as a sphere says nothing at all rather than saying
    // 1, so the controller's own default is the only place that number appears.
    // Earth's own 1/298 flattening is below the threshold the renderer models.
    expect(earth.shapeRatio).toBeUndefined()
    // And it is a rendering fact, never a measurement: the catalogue radius is the
    // mean radius and stays that.
    expect(saturn.radiusMetres).toBe(58_232_000)
  })
})
