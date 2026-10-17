import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  drawnRadiusMetres,
  galaxyForm,
  immersionFactor,
  lumpySphere,
  photosphereColours,
  shadowApparentRadius,
} from '../../src/modules/proxy/index'

/**
 * The three pure pieces of the proxy module.
 *
 * `galaxyForm` and `shadowApparentRadius` decide what a galaxy and a black hole look
 * like and neither had a test. `lumpySphere` is here for a different reason: the
 * faceting it fixes (`IcosahedronGeometry` is non-indexed, so `computeVertexNormals`
 * can only write one normal per face and Ceres arrived as a 720-sided solid) comes
 * straight back the moment someone drops the weld, and it is invisible in a diff.
 */

/** The critical impact parameter, 3*sqrt(3)/2 — the radius of the shadow far away. */
const B_CRIT = (3 * Math.sqrt(3)) / 2
/** Must agree with SHADOW_THETA_MAX in the module. */
const THETA_MAX = 0.64

describe('galaxyForm', () => {
  it('maps the morphology strings the shipped catalogue actually contains', () => {
    // Every distinct `morphology` value in public/data/galaxy/localgroup.json.
    expect(galaxyForm('E (dSph/dE)')).toBe('elliptical')
    expect(galaxyForm('E/S0')).toBe('elliptical')
    expect(galaxyForm('Im / Ir')).toBe('irregular')
    expect(galaxyForm('Sm')).toBe('irregular')
    expect(galaxyForm('S0')).toBe('lenticular')
    expect(galaxyForm('Sb')).toBe('spiral')
    expect(galaxyForm('Sbc')).toBe('spiral')
    expect(galaxyForm('Sc')).toBe('spiral')
    expect(galaxyForm('Sdm')).toBe('spiral')
  })

  it('maps the rest of the de Vaucouleurs classes the registry can reach', () => {
    for (const e of ['E0', 'E7', 'cE', 'dE3', 'dSph', 'cD']) expect(galaxyForm(e)).toBe('elliptical')
    for (const l of ['SB0', 'S0-a', 'L']) expect(galaxyForm(l)).toBe('lenticular')
    for (const i of ['Im', 'IBm', 'Irr', 'SBm', 'dIrr', 'BCD', 'Pec', 'I']) expect(galaxyForm(i)).toBe('irregular')
    for (const s of ['Sa', 'SBc', 'Sd', 'SAB(rs)bc']) expect(galaxyForm(s)).toBe('spiral')
  })

  it('falls through to a spiral when the catalogue has no class, which most of them do not', () => {
    expect(galaxyForm(undefined)).toBe('spiral')
    expect(galaxyForm('')).toBe('spiral')
    // Leading whitespace survives a few of the catalogue joins.
    expect(galaxyForm('  E0')).toBe('elliptical')
  })
})

describe('shadowApparentRadius', () => {
  it('tends to the critical impact parameter far from the hole', () => {
    expect(shadowApparentRadius(1000)).toBeCloseTo(B_CRIT, 2)
    expect(shadowApparentRadius(1e4)).toBeCloseTo(B_CRIT, 3)
  })

  it('never draws a shadow wider than the capture cross-section, and shrinks with distance', () => {
    // The returned quantity is a RADIUS at the hole, not an angle, and d * tan(theta)
    // is not monotone in d — it peaks around 4 r_s. What has to hold is the physics:
    // the shadow is never wider than the critical impact parameter, and the angle it
    // subtends falls off all the way out.
    let previous = Infinity
    for (const d of [3, 4, 6, 10, 20, 50, 200, 1000, 1e4]) {
      const r = shadowApparentRadius(d)
      expect(r).toBeLessThan(B_CRIT)
      const angle = Math.atan(r / d)
      expect(angle).toBeLessThan(previous)
      previous = angle
    }
  })

  it('stays finite and positive everywhere the camera can go, including inside the horizon', () => {
    for (let d = 1; d <= 1e4; d *= 1.07) {
      const r = shadowApparentRadius(d)
      expect(Number.isFinite(r)).toBe(true)
      expect(r).toBeGreaterThan(0)
    }
  })

  it('never lets the shadow grow past the soft cap, which is what keeps the ring on screen', () => {
    // The quad cannot draw more than half the sky, and the true angle passes 90
    // degrees at the photon sphere and keeps going. atan(radius/d) is the angle the
    // frame actually sees, and the cap is a strict upper bound on it.
    for (const d of [1.0001, 1.05, 1.2, 1.4999, 1.5, 1.6, 2, 2.6, 4, 10]) {
      expect(Math.atan(shadowApparentRadius(d) / d)).toBeLessThan(THETA_MAX)
    }
  })

  it('is continuous across the photon sphere, where the solution switches branch', () => {
    // Below d = 1.5 the observer is inside the photon sphere and the shadow is the
    // theta > 90 branch, pi - asin(...). The two branches have to meet exactly at
    // sin(theta) = 1 or the shadow jumps a frame before the horizon.
    const below = shadowApparentRadius(1.5 - 1e-9) / (1.5 - 1e-9)
    const above = shadowApparentRadius(1.5 + 1e-9) / (1.5 + 1e-9)
    expect(below).toBeCloseTo(above, 6)
  })
})

describe('lumpySphere', () => {
  const random = () => 0.5

  it('welds the icosahedron so the body shades smoothly instead of as loose facets', () => {
    const geometry = lumpySphere(random, 0.1)
    // Non-indexed, PolyhedronGeometry at detail 24 is 12,500 triangles and 37,500
    // loose vertices. Welded it is the same 12,500 triangles over 6,252 shared ones —
    // Euler's formula, and the resolution the craters need to be craters rather than
    // three dark triangles. One proxy exists at a time, so this is the whole cost.
    expect(geometry.index).not.toBeNull()
    expect(geometry.index!.count).toBe(12500 * 3)
    expect(geometry.attributes.position.count).toBe(6252)
    geometry.dispose()
  })

  it('carves craters into the surface rather than leaving it smooth', () => {
    // A surface built from six low-frequency sine octaves has no local pits: every
    // vertex sits within a hair of the average of its neighbours. A crater is exactly
    // a local pit, so count vertices sitting well below their own one-ring. Before
    // craters this count was zero, and a comet nucleus arrived as a grey pebble.
    // A real sequence, not the constant above: with every draw equal the crater axes
    // all collapse to the same degenerate direction and nothing is carved at all.
    let seed = 0x9e3779b9
    const varied = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const geometry = lumpySphere(varied, 0.26)
    const position = geometry.attributes.position
    const index = geometry.index!
    const radius = (i: number) => Math.hypot(position.getX(i), position.getY(i), position.getZ(i))
    const ring = new Map<number, Set<number>>()
    for (let t = 0; t < index.count; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = index.getX(t + k)
        const b = index.getX(t + ((k + 1) % 3))
        if (!ring.has(a)) ring.set(a, new Set())
        if (!ring.has(b)) ring.set(b, new Set())
        ring.get(a)!.add(b)
        ring.get(b)!.add(a)
      }
    }
    let pits = 0
    for (const [i, neighbours] of ring) {
      let sum = 0
      for (const n of neighbours) sum += radius(n)
      if (radius(i) < (sum / neighbours.size) * 0.99) pits++
    }
    expect(pits).toBeGreaterThan(80)
    geometry.dispose()
  })

  it('gives a nearly round body normals that point along its own radius', () => {
    // Flat shading on a near-sphere puts the face normal on all three corners, which
    // is off the radial direction by half the facet's angular size — about 6 degrees
    // at detail 6. Smooth shading is within a small fraction of a degree of radial.
    const geometry = lumpySphere(random, 0.02)
    const position = geometry.attributes.position
    const normal = geometry.attributes.normal
    let worst = 0
    for (let i = 0; i < position.count; i++) {
      const length = Math.hypot(position.getX(i), position.getY(i), position.getZ(i))
      const dot =
        (position.getX(i) * normal.getX(i) + position.getY(i) * normal.getY(i) + position.getZ(i) * normal.getZ(i)) /
        length
      worst = Math.max(worst, Math.acos(Math.min(dot, 1)))
    }
    expect(worst).toBeLessThan(0.02)
    geometry.dispose()
  })
})

/**
 * Rec.709 luminance, which is the quantity PostStack's bright pass thresholds on.
 * Kept here rather than imported so the test fails if the renderer's definition
 * drifts away from the one the star was tuned against.
 */
function luminance(c: THREE.Color): number {
  return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722
}

/** Must agree with AtlasViewer's PostStack options. */
const BLOOM_THRESHOLD = 1.9

describe('photosphereColours', () => {
  // Every distinct proxyColor the star catalogue hands a proxy, hot to cool.
  const catalogue = ['#dde9ff', '#e6eeff', '#fff3e0', '#fff2e6', '#ffe0c2']

  it('drives the core clear of the bloom threshold for every catalogue colour', () => {
    // The regression this exists for: at a drive of 2.05 the core landed at 1.120,
    // a quarter of the way up a knee that starts at 0.76, so the star you had flown
    // to was the one thing in the frame that did not glare.
    for (const hex of catalogue) {
      expect(luminance(photosphereColours(hex).core)).toBeGreaterThan(BLOOM_THRESHOLD)
    }
  })

  it('leaves the limb below the threshold, which is where the spectral type lives', () => {
    for (const hex of catalogue) {
      expect(luminance(photosphereColours(hex).limb)).toBeLessThan(BLOOM_THRESHOLD)
    }
  })

  it('keeps a hot star and a cool one visibly different colours', () => {
    const hot = photosphereColours('#dde9ff')
    const cool = photosphereColours('#ffc27a')
    // Blue-white against orange: the limb is the annulus that has to carry it.
    expect(hot.limb.b / hot.limb.r).toBeGreaterThan(1.2)
    expect(cool.limb.b / cool.limb.r).toBeLessThan(0.8)
    // ... and the core is tinted the same way, only less, so the glare is not a
    // different colour from the star.
    expect(hot.core.b).toBeGreaterThan(hot.core.r)
    expect(cool.core.b).toBeLessThan(cool.core.r)
  })

  it('takes only the hue from the catalogue, never its brightness', () => {
    // The same chromaticity at two exposures has to give the same photosphere, or
    // the on-screen exposure of a star would depend on which star you flew to.
    // Compared as ratios, because the dim hex can only carry the same chromaticity
    // to the nearest 8-bit sRGB step.
    const bright = photosphereColours('#ffe0c2')
    // The same chromaticity at a quarter of the light, to the nearest 8-bit sRGB
    // step — which is why these are relative tolerances and not toBeCloseTo.
    const dim = photosphereColours('#897867')
    const off = (a: number, b: number) => Math.abs(a - b) / a
    expect(off(bright.core.g / bright.core.r, dim.core.g / dim.core.r)).toBeLessThan(0.01)
    expect(off(bright.core.b / bright.core.r, dim.core.b / dim.core.r)).toBeLessThan(0.01)
    expect(off(bright.core.r, dim.core.r)).toBeLessThan(0.01)
    expect(off(luminance(bright.core), luminance(dim.core))).toBeLessThan(0.01)
  })
})

describe('immersionFactor', () => {
  const H = 805

  it('leaves a cloud alone until it starts to fill the frame', () => {
    expect(immersionFactor(40, H)).toBe(1)
    expect(immersionFactor(112, H)).toBeCloseTo(1, 2)
  })

  it('is already biting at the standard arrival framing, which is the point', () => {
    // 4.2 radii at a 50 degree field in an 805 px frame puts the apparent radius at
    // 205 px. The base opacities in the module are tuned against this number, so if
    // it moves they have to move with it.
    expect(immersionFactor(205, H)).toBeCloseTo(0.55, 2)
  })

  it('floors rather than going to zero, so flying inside leaves something to see', () => {
    expect(immersionFactor(5000, H)).toBe(0.25)
    expect(immersionFactor(1e9, H)).toBe(0.25)
  })

  it('depends on the fraction of the frame filled, not on a pixel count', () => {
    // The same object at the same framing in a window twice as tall used to thin
    // twice as hard.
    expect(immersionFactor(410, 2 * H)).toBeCloseTo(immersionFactor(205, H), 6)
  })
})

describe('drawnRadiusMetres', () => {
  const node = (radiusMetres: number, framingRadiusMetres?: number) =>
    ({
      id: 'x',
      worldPosition: { x: 0, y: 0, z: 0 },
      frame: 'icrf' as const,
      radiusMetres,
      framingRadiusMetres,
      layer: 'helio' as const,
      objectClass: 'comet',
      name: 'x',
      parentId: null,
    })

  it('uses the catalogue radius whenever there is one', () => {
    expect(drawnRadiusMetres(node(5500))).toBe(5500)
    // Even when a framing size is also present: the measurement wins.
    expect(drawnRadiusMetres(node(5500, 1300))).toBe(5500)
  })

  it('falls back to the framing size, so an unmeasured comet is not an empty sky', () => {
    // The 34 comets with no measured nucleus report radius 0, which is the honest
    // catalogue answer and used to mean the proxy drew nothing at all: the camera
    // parked 5.5 km from Pons-Brooks and showed the user stars.
    expect(drawnRadiusMetres(node(0, 1300))).toBe(1300)
  })

  it('still draws nothing for a node with no size of either kind', () => {
    expect(drawnRadiusMetres(node(0))).toBe(0)
  })
})
