import type * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/core/Engine'
import { HeliosphereModule } from '../../src/modules/heliosphere'
import { AU_M } from '../../src/core/world'

/**
 * The heliosphere is a surface known at four points and modelled everywhere else.
 *
 * Every assertion here is about that gap. The four crossings are measurements and must
 * arrive unaltered; the surfaces through them are a model and must say so, must be
 * fitted to one spacecraft rather than smeared between two, and must report how badly
 * they miss the other one. The number they miss by is the physics: Voyager 2 crossed
 * FURTHER from the nose and NEARER the Sun than Voyager 1, which no axisymmetric
 * surface can do, and a model that quietly averaged the two would hide exactly that.
 */

function boot(): { engine: Engine; module: HeliosphereModule } {
  const engine = new Engine({ renderer: {} as never })
  const module = new HeliosphereModule()
  module.init(engine)
  return { engine, module }
}

/** Heliocentric distance of a registered node, in AU. */
function distanceAu(engine: Engine, id: string): number {
  const node = engine.node(id)
  if (!node) throw new Error(`no node ${id}`)
  const { x, y, z } = node.worldPosition
  return Math.hypot(x, y, z) / AU_M
}

describe('the measured crossings', () => {
  it('places each one at the distance its instrument reported', () => {
    const { engine, module } = boot()
    // Four crossings, four published distances. These are the whole in-situ record of
    // where this object is; nothing in the module may round or adjust them.
    expect(distanceAu(engine, 'helio:v1-termination-shock')).toBeCloseTo(94, 6)
    expect(distanceAu(engine, 'helio:v2-termination-shock')).toBeCloseTo(84, 6)
    expect(distanceAu(engine, 'helio:v1-heliopause')).toBeCloseTo(121.6, 6)
    expect(distanceAu(engine, 'helio:v2-heliopause')).toBeCloseTo(119.0, 6)
    module.dispose?.()
  })

  it('badges them measured, and carries the instrument that saw them', () => {
    const { engine, module } = boot()
    for (const id of ['helio:v1-heliopause', 'helio:v2-heliopause']) {
      const node = engine.node(id) as { provenance?: string; provenanceNote?: string } | null
      expect(node?.provenance, id).toBe('measured')
      // A crossing is an instrument reading on a date, not a position report.
      expect(node?.provenanceNote, id).toMatch(/\d{4}-\d{2}-\d{2}/)
      expect(node?.provenanceNote, id).toMatch(/Plasma/)
    }
    module.dispose?.()
  })

  it('does not claim a crossing is an object with a size', () => {
    const { engine, module } = boot()
    const node = engine.node('helio:v1-heliopause')
    // An event has no radius, and nothing is drawn at one: the spacecraft passed
    // through and kept going. The arrival distance is therefore chosen to frame the
    // BOUNDARY the event sits on, whose curvature radius is of order 100 AU. Framing
    // it at an AU lands the camera in empty space looking at a dot.
    expect(node?.radiusMetres).toBe(0)
    expect(node?.framingRadiusMetres).toBeGreaterThan(5 * AU_M)
    module.dispose?.()
  })
})

describe('the modelled surfaces', () => {
  it('passes exactly through Voyager 1 and misses Voyager 2 by about 13 AU', () => {
    const { engine, module } = boot()
    const node = engine.node('helio:heliopause') as { provenanceNote?: string } | null
    const note = node?.provenanceNote ?? ''

    // The fit is anchored on Voyager 1, so the surface is exact there by construction.
    // Voyager 2 is the test of the SHAPE, and the shape fails: an axisymmetric surface
    // about the nose must grow with angle from the nose, and Voyager 2 crossed at a
    // larger angle and a smaller radius. The model therefore overshoots.
    const miss = Number(note.match(/by ([\d.]+) AU/)?.[1])
    expect(miss).toBeGreaterThan(8)
    expect(miss).toBeLessThan(20)
    expect(note).toMatch(/Voyager 2/)
    expect(note).toMatch(/further out/)
    module.dispose?.()
  })

  it('says derived, and does not report a radius for a thing with no radius', () => {
    const { engine, module } = boot()
    for (const id of ['helio:heliopause', 'helio:termination-shock']) {
      const node = engine.node(id) as { provenance?: string } | null
      expect(node?.provenance, id).toBe('derived')
      // The heliosphere is not a sphere and nobody has published a radius for it. The
      // camera still has to stop somewhere, which is what framing is for.
      expect(engine.node(id)?.radiusMetres, id).toBe(0)
      expect(engine.node(id)?.framingRadiusMetres, id).toBeGreaterThan(50 * AU_M)
    }
    module.dispose?.()
  })

  it('nests the termination shock inside the heliopause', () => {
    const { engine, module } = boot()
    // Both are fitted to Voyager 1, at 94 AU and 121.6 AU on the same bearing, so the
    // ordering is inherited from the measurements rather than imposed.
    expect(distanceAu(engine, 'helio:termination-shock')).toBeLessThan(distanceAu(engine, 'helio:heliopause'))
    module.dispose?.()
  })
})

describe('the drawn surface', () => {
  function surfaces(engine: Engine): THREE.LineSegments[] {
    const found: THREE.LineSegments[] = []
    engine.layer('helio').scene.traverse((object) => {
      if (object.name.startsWith('heliosphere:')) found.push(object as THREE.LineSegments)
    })
    return found
  }

  it('keeps every vertex well inside the float32 range the layer guarantees', () => {
    const { engine, module } = boot()
    const drawn = surfaces(engine)
    expect(drawn.length).toBe(2)

    // Layer.ts: every geometry keeps its coordinates within ~1e4 of its object origin,
    // because the GPU sees float32. The tail cutoff is what sets the largest value
    // here, and it must stay far below that bound.
    for (const object of drawn) {
      const position = object.geometry.getAttribute('position').array as Float32Array
      let largest = 0
      for (const value of position) largest = Math.max(largest, Math.abs(value))
      expect(largest, object.name).toBeGreaterThan(0)
      expect(largest, object.name).toBeLessThan(1e4)
    }
    module.dispose?.()
  })

  it('is solid where a spacecraft flew and faint where none did', () => {
    const { engine, module } = boot()
    const heliopause = surfaces(engine).find((object) => object.name.endsWith('heliopause'))
    const confidence = heliopause?.geometry.getAttribute('aConfidence').array as Float32Array

    // This attribute IS the honesty claim: it is how much of the surface a measurement
    // reaches. If it were uniform, the picture would assert the tail as confidently as
    // the two bearings something actually crossed.
    let full = 0
    let floor = 0
    for (const value of confidence) {
      if (value > 0.99) full++
      if (value < 0.2) floor++
    }
    expect(full).toBeGreaterThan(0)
    expect(floor).toBeGreaterThan(0)
    module.dispose?.()
  })

  it('gives everything back on dispose', () => {
    const { engine, module } = boot()
    expect(engine.registry.size).toBeGreaterThan(0)
    module.dispose?.()
    expect(surfaces(engine).length).toBe(0)
    for (const id of ['helio:heliopause', 'helio:v1-heliopause']) {
      expect(engine.registry.has(id), id).toBe(false)
    }
  })
})

describe('the spacecraft', () => {
  /** Drive one frame, which is what moves them. */
  function propagate(module: HeliosphereModule, engine: Engine, epochMs: number): void {
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
      viewSpanMetres: 1e13,
      inTransit: false,
      transitFromId: null,
      engine,
    })
  }

  it('puts them where the published distance and speed say, not where a tracker says', () => {
    const { engine, module } = boot()
    propagate(module, engine, Date.parse('2026-11-06T00:00:00Z'))

    // Propagated from the heliopause crossings, which are the most recent dated
    // HELIOCENTRIC distances in the literature. The widely quoted 172.5 and 143 AU
    // are distances from EARTH and are a different number; this is the cross-check
    // against them, loose enough to allow the Earth-Sun baseline and the drift.
    expect(distanceAu(engine, 'helio:voyager-1')).toBeGreaterThan(168)
    expect(distanceAu(engine, 'helio:voyager-1')).toBeLessThan(176)
    expect(distanceAu(engine, 'helio:voyager-2')).toBeGreaterThan(140)
    expect(distanceAu(engine, 'helio:voyager-2')).toBeLessThan(149)
    module.dispose?.()
  })

  it('has each one outside the heliopause it crossed', () => {
    const { engine, module } = boot()
    propagate(module, engine, Date.parse('2026-11-06T00:00:00Z'))
    // They crossed and kept going. If this ever inverts, the propagation has the sign
    // of time wrong.
    expect(distanceAu(engine, 'helio:voyager-1')).toBeGreaterThan(121.6)
    expect(distanceAu(engine, 'helio:voyager-2')).toBeGreaterThan(119.0)
    module.dispose?.()
  })

  it('moves them with the clock', () => {
    const { engine, module } = boot()
    propagate(module, engine, Date.parse('2026-01-01T00:00:00Z'))
    const before = distanceAu(engine, 'helio:voyager-1')
    propagate(module, engine, Date.parse('2036-01-01T00:00:00Z'))
    const after = distanceAu(engine, 'helio:voyager-1')
    // 17.043 km/s is 3.595 AU/yr, so ten years is about 36 AU.
    expect(after - before).toBeGreaterThan(34)
    expect(after - before).toBeLessThan(38)
    module.dispose?.()
  })

  it('says the size is real and the shape is not', () => {
    const { engine, module } = boot()
    const node = engine.node('helio:voyager-1') as
      | { radiusMetres: number; shapeIsIllustration?: boolean; provenance?: string; object3D?: unknown }
      | null
    // The antenna is 3.66 m across and that is published, so the SIZE is a
    // measurement — nearly the only one in this module that is about an object
    // rather than an event. The shape is drawn from dimensions, not a shape model,
    // and owning the mesh must not be read as evidence that the mesh is measured.
    expect(node?.radiusMetres).toBeCloseTo(1.83, 6)
    expect(node?.shapeIsIllustration).toBe(true)
    expect(node?.provenance).toBe('derived')
    // Owning an object3D is also what keeps the proxy module's hashed blob away.
    expect(node?.object3D).toBeTruthy()
    module.dispose?.()
  })
})
