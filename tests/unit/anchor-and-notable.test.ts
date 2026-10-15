import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/core/Engine'
import { PC_M, convertFrame, distance3d, vec3d } from '../../src/core/world'
import { spanVisibility } from '../../src/core/render/spanFade'
import { literatureDistancePc } from '../../src/data/deepSkyDistances'
import { NOTABLE_OBJECTS, notableRadiusMetres, schwarzschildRadiusMetres } from '../../src/data/notableObjects'

describe('anchor distance', () => {
  /**
   * The bug this exists to prevent: the engine copied an anchor's position into the
   * camera frame without converting it. Every node happened to be stated in the
   * camera's own frame until named stars were registered in ICRF, at which point
   * anchoring on Betelgeuse reported it 62 pc away instead of 152 — a 23.4 degree
   * rotation read as distance. The near plane, the scale ladder, the layer bands and
   * the proxy's size fade all consume that number.
   */
  it('converts the anchor position out of the node frame before measuring', () => {
    const engine = new Engine({ renderer: {} as never })

    // A point on the ICRF x-axis, where the ecliptic rotation has the most to do.
    const distancePc = 152
    const icrfPosition = vec3d()
    icrfPosition.x = 0
    icrfPosition.y = distancePc * PC_M
    icrfPosition.z = 0

    engine.register({
      id: 'probe',
      worldPosition: icrfPosition,
      frame: 'icrf',
      radiusMetres: 1e9,
      layer: 'stellar',
      objectClass: 'star',
      name: 'Probe',
      parentId: null,
    })

    // Put the camera exactly on the object, stated in the camera's own frame.
    engine.cameraFrame = 'ecliptic'
    convertFrame(engine.cameraWorld, icrfPosition, 'icrf', 'ecliptic')
    engine.setAnchor('probe')

    expect(distance3d(engine.cameraWorld, engine.anchorWorld)).toBeLessThan(1)

    // And the unconverted comparison is wrong by the obliquity, which is the whole
    // point: if this ever stops being true the test has lost its subject.
    expect(distance3d(engine.cameraWorld, icrfPosition)).toBeGreaterThan(50 * PC_M)
  })
})

describe('span visibility', () => {
  it('hides a structure the view is far inside', () => {
    // Earth's orbit, 2 AU across, seen in a 42,000 km view from low orbit.
    expect(spanVisibility(4.2e7, 3e11)).toBe(0)
  })

  it('shows a structure the view frames', () => {
    expect(spanVisibility(6e11, 3e11)).toBeGreaterThan(0.9)
  })

  it('hides a structure that has collapsed to a point', () => {
    // The same orbit from the Oort cloud.
    expect(spanVisibility(1e16, 3e11)).toBe(0)
  })

  it('is continuous across the band', () => {
    let previous = 0
    let rose = false
    let fell = false
    for (let log = 9; log <= 17; log += 0.1) {
      const v = spanVisibility(10 ** log, 3e11)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      if (v > previous + 1e-9) rose = true
      if (rose && v < previous - 1e-9) fell = true
      previous = v
    }
    expect(rose && fell, 'visibility should rise then fall').toBe(true)
  })
})

describe('published deep-sky distances', () => {
  it('puts the Orion Nebula inside the galaxy', () => {
    const pc = literatureDistancePc('NGC1976', 42)
    expect(pc).not.toBeNull()
    // 1,344 ly. Anything near the 100 kpc direction-only shell is the bug returning.
    expect(pc!).toBeGreaterThan(350)
    expect(pc!).toBeLessThan(460)
  })

  it('places Andromeda by either of its catalogue designations', () => {
    const byMessier = literatureDistancePc('NGC0224', 31)
    const byDesignation = literatureDistancePc('NGC0224')
    expect(byMessier).toBeCloseTo(byDesignation!, 0)
    expect(byMessier! / 1e6).toBeCloseTo(0.778, 2)
  })

  it('returns null for an object it does not cover', () => {
    expect(literatureDistancePc('NGC9999')).toBeNull()
  })
})

describe('notable objects', () => {
  it('gives every object exactly one kind of distance', () => {
    for (const object of NOTABLE_OBJECTS) {
      const hasOne = (object.distancePc !== undefined) !== (object.redshift !== undefined)
      expect(hasOne, `${object.name} needs a distance or a redshift, not both or neither`).toBe(true)
    }
  })

  it('gives every object a size to be framed by', () => {
    for (const object of NOTABLE_OBJECTS) {
      expect(notableRadiusMetres(object), `${object.name} has no radius`).toBeGreaterThan(0)
    }
  })

  it('has unique ids and sane sky coordinates', () => {
    const ids = new Set<string>()
    for (const object of NOTABLE_OBJECTS) {
      expect(ids.has(object.id), `duplicate id ${object.id}`).toBe(false)
      ids.add(object.id)
      expect(object.raDeg).toBeGreaterThanOrEqual(0)
      expect(object.raDeg).toBeLessThan(360)
      expect(Math.abs(object.decDeg)).toBeLessThanOrEqual(90)
    }
  })

  it('computes the Schwarzschild radius to the published values', () => {
    // The Sun's would be 2.95 km, which is the standard textbook figure.
    expect(schwarzschildRadiusMetres(1) / 1000).toBeCloseTo(2.95, 2)
    // Sagittarius A*, 4.297e6 solar masses: 0.085 AU.
    expect(schwarzschildRadiusMetres(4.297e6) / 1.495978707e11).toBeCloseTo(0.085, 3)
    // TON 618's horizon, which its own description claims is about 1,300 AU across.
    const ton618 = NOTABLE_OBJECTS.find((o) => o.id === 'bh:ton618')!
    expect(notableRadiusMetres(ton618) / 1.495978707e11).toBeCloseTo(1303, -1)
  })
})
