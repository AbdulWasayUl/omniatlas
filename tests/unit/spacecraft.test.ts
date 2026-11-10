import type * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/core/Engine'
import { SpacecraftModule } from '../../src/modules/spacecraft'
import { HeliosphereModule } from '../../src/modules/heliosphere'
import { AU_M } from '../../src/core/world'
import { ESCAPING_SPACECRAFT } from '../../src/data/escapingSpacecraft'

/**
 * The five probes on their way out, and what the atlas is allowed to say about them.
 *
 * The positions are an ephemeris walked forward, the sizes are published, and the
 * shapes are drawings. Those are three different kinds of claim and the tests keep
 * them apart — plus the one that actually bit: a 3.7 m object in a layer whose near
 * plane bottoms out at 150 m renders nothing, at any zoom, forever.
 */

function boot(): { engine: Engine; module: SpacecraftModule } {
  const engine = new Engine({ renderer: {} as never })
  const module = new SpacecraftModule()
  module.init(engine)
  return { engine, module }
}

function frame(module: { update?: (ctx: never) => void }, engine: Engine, epochMs: number): void {
  module.update?.({
    epochMs,
    delta: 0,
    cameraWorld: { x: 0, y: 0, z: 0 },
    cameraFrame: 'ecliptic',
    anchorDistanceMetres: 0,
    anchorId: null,
    fovDegrees: 50,
    width: 800,
    height: 600,
    viewSpanMetres: 30,
    inTransit: false,
    transitFromId: null,
    engine,
  } as never)
}

function distanceAu(engine: Engine, id: string): number {
  const node = engine.node(id)
  if (!node) throw new Error(`no node ${id}`)
  const { x, y, z } = node.worldPosition
  return Math.hypot(x, y, z) / AU_M
}

const EPOCH = Date.parse('2026-11-10T00:00:00Z')

describe('where the probes are', () => {
  it('registers all five and places each at its published heliocentric distance', () => {
    const { engine, module } = boot()
    frame(module, engine, EPOCH)
    // Heliocentric, not geocentric. Almost every figure in circulation for these is
    // the distance from EARTH, which is a different number by up to an AU.
    for (const spec of ESCAPING_SPACECRAFT) {
      expect(distanceAu(engine, spec.id), spec.name).toBeCloseTo(spec.distanceAu, 2)
    }
    module.dispose?.()
  })

  it('keeps them in the right order, furthest first', () => {
    const { engine, module } = boot()
    frame(module, engine, EPOCH)
    const order = ESCAPING_SPACECRAFT.map((s) => s.id)
      .map((id) => ({ id, au: distanceAu(engine, id) }))
      .sort((a, b) => b.au - a.au)
      .map((entry) => entry.id)
    // Voyager 1 is the most distant human-made object; New Horizons the nearest of
    // these five, having left thirty years later.
    expect(order[0]).toBe('craft:voyager-1')
    expect(order[4]).toBe('craft:new-horizons')
    module.dispose?.()
  })

  it('moves them with the clock', () => {
    const { engine, module } = boot()
    frame(module, engine, EPOCH)
    const before = distanceAu(engine, 'craft:voyager-1')
    frame(module, engine, EPOCH + 10 * 365.25 * 86_400_000)
    // 3.569 AU/yr for ten years.
    expect(distanceAu(engine, 'craft:voyager-1') - before).toBeCloseTo(35.69, 1)
    module.dispose?.()
  })

  it('agrees with the heliopause propagation computed from primary literature', () => {
    // Two independent routes to Voyager 1's distance today: this module walks an
    // ephemeris forward from a tracker snapshot, and the heliosphere module walks
    // 121.6 AU forward from the 2012 crossing in Gurnett et al. If they disagree,
    // one of the two is wrong and neither says which.
    const engine = new Engine({ renderer: {} as never })
    const craft = new SpacecraftModule()
    const helio = new HeliosphereModule()
    craft.init(engine)
    helio.init(engine)
    frame(craft, engine, EPOCH)

    const fromEphemeris = distanceAu(engine, 'craft:voyager-1')
    const crossingAu = 121.6
    const years = (EPOCH - Date.parse('2012-08-25T00:00:00Z')) / (365.25 * 86_400_000)
    const fromCrossing = crossingAu + (17.043 / 4.74057) * years
    expect(Math.abs(fromEphemeris - fromCrossing)).toBeLessThan(1.5)

    craft.dispose?.()
    helio.dispose?.()
  })
})

describe('what the probes claim', () => {
  it('reports the antenna as measured and the shape as a drawing', () => {
    const { engine, module } = boot()
    for (const spec of ESCAPING_SPACECRAFT) {
      const node = engine.node(spec.id) as
        | { radiusMetres: number; shapeIsIllustration?: boolean; provenance?: string }
        | null
      expect(node?.radiusMetres, spec.name).toBeCloseTo(spec.antennaRadiusMetres, 6)
      expect(node?.shapeIsIllustration, spec.name).toBe(true)
      expect(node?.provenance, spec.name).toBe('derived')
    }
    module.dispose?.()
  })

  it('says plainly that nobody has heard from the Pioneers', () => {
    const { engine, module } = boot()
    for (const id of ['craft:pioneer-10', 'craft:pioneer-11']) {
      const node = engine.node(id) as { caveat?: string } | null
      expect(node?.caveat, id).toMatch(/Nothing has been heard/)
    }
    // The three that still transmit must NOT carry that caveat.
    for (const id of ['craft:voyager-1', 'craft:voyager-2', 'craft:new-horizons']) {
      expect((engine.node(id) as { caveat?: string } | null)?.caveat, id).toBeUndefined()
    }
    module.dispose?.()
  })
})

describe('what the probes look like', () => {
  function groupOf(engine: Engine, id: string): THREE.Object3D {
    const node = engine.node(id)
    if (!node?.object3D) throw new Error(`no object3D for ${id}`)
    return node.object3D
  }

  it('draws in the system layer, not helio', () => {
    const { engine, module } = boot()
    // helio's unit is the AU, so its near plane cannot go below 1e-9 AU = 150 metres.
    // A 3.7 m spacecraft is inside that at every distance it could be seen from, and
    // the first version of this drew an inspector panel over empty space because of it.
    expect(engine.node('craft:voyager-1')?.layer).toBe('system')
    let found = false
    engine.layer('system').scene.traverse((object) => {
      if (object.name === 'spacecraft:voyager-1') found = true
    })
    expect(found).toBe(true)
    module.dispose?.()
  })

  it('builds the booms that make a Voyager recognisable', () => {
    const { engine, module } = boot()
    const group = groupOf(engine, 'craft:voyager-1')
    let longest = 0
    group.traverse((object) => {
      const geometry = (object as THREE.LineSegments).geometry
      const position = geometry?.getAttribute?.('position')
      if (!position) return
      const array = position.array as Float32Array
      for (let i = 0; i < array.length; i += 3) {
        longest = Math.max(longest, Math.hypot(array[i], array[i + 1], array[i + 2]))
      }
    })
    // In units of the 1.85 m antenna radius, the 13 m magnetometer boom is 7.0 and the
    // 10 m whips are 5.4. Anything under about 5 means the booms are missing and the
    // thing is a saucer with a box on it, which is exactly what the first one was.
    expect(longest).toBeGreaterThan(5)
    module.dispose?.()
  })

  it('keeps every vertex inside the float32 range the layer guarantees', () => {
    const { engine, module } = boot()
    for (const spec of ESCAPING_SPACECRAFT) {
      groupOf(engine, spec.id).traverse((object) => {
        const position = (object as THREE.Mesh).geometry?.getAttribute?.('position')
        if (!position) return
        for (const value of position.array as Float32Array) {
          expect(Math.abs(value), `${spec.name} ${object.name}`).toBeLessThan(1e4)
        }
      })
    }
    module.dispose?.()
  })

  it('gives everything back on dispose', () => {
    const { engine, module } = boot()
    module.dispose?.()
    for (const spec of ESCAPING_SPACECRAFT) {
      expect(engine.registry.has(spec.id), spec.name).toBe(false)
    }
    let remaining = 0
    engine.layer('system').scene.traverse((object) => {
      if (object.name.startsWith('spacecraft:')) remaining++
    })
    expect(remaining).toBe(0)
  })
})
