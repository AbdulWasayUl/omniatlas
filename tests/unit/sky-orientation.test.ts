import { describe, expect, it } from 'vitest'
import { discBasis } from '../../src/core/skyOrientation'
import { type Vec3d, sphericalToCartesian, vec3d } from '../../src/core/world'

/**
 * The contract: a disc built from a catalogue ellipse must project back to that ellipse.
 *
 * Everything the atlas draws from `discBasis` rests on this one property, and it is the
 * property that can be checked without believing any of the derivation. If the rim
 * projects to a semi-major axis of the catalogued length at the catalogued position
 * angle, and a semi-minor axis shorter by exactly the catalogued axis ratio, then the
 * reconstruction agrees with the measurement and the only thing left uncertain is the
 * part the data genuinely cannot settle.
 */

const dot = (a: Vec3d, b: Vec3d) => a.x * b.x + a.y * b.y + a.z * b.z
const norm = (a: Vec3d) => Math.hypot(a.x, a.y, a.z)

/** The local sky frame, derived independently of the module under test. */
function skyFrame(raDeg: number, decDeg: number) {
  const ra = (raDeg * Math.PI) / 180
  const dec = (decDeg * Math.PI) / 180
  return {
    dir: sphericalToCartesian(vec3d(), raDeg, decDeg, 1),
    east: vec3d(-Math.sin(ra), Math.cos(ra), 0),
    north: vec3d(-Math.sin(dec) * Math.cos(ra), -Math.sin(dec) * Math.sin(ra), Math.cos(dec)),
  }
}

/**
 * Walk the rim, drop the line-of-sight component, and report the projected ellipse.
 *
 * Measured in the sky frame rather than analytically, so the test exercises the vectors
 * the renderer will actually use rather than re-deriving the formula it is checking.
 */
function projectRim(raDeg: number, decDeg: number, axisRatio: number, posAngDeg: number, radius = 1) {
  const { u, v } = discBasis(raDeg, decDeg, axisRatio, posAngDeg)
  const { dir, east, north } = skyFrame(raDeg, decDeg)
  let maxExtent = 0
  let maxAngleDeg = 0
  let minExtent = Infinity
  for (let i = 0; i < 2048; i++) {
    const t = (i / 2048) * 2 * Math.PI
    const p = vec3d(
      radius * (Math.cos(t) * u.x + Math.sin(t) * v.x),
      radius * (Math.cos(t) * u.y + Math.sin(t) * v.y),
      radius * (Math.cos(t) * u.z + Math.sin(t) * v.z),
    )
    // Project onto the sky plane at this direction.
    const along = dot(p, dir)
    const sky = vec3d(p.x - along * dir.x, p.y - along * dir.y, p.z - along * dir.z)
    const n = dot(sky, north)
    const e = dot(sky, east)
    const extent = Math.hypot(n, e)
    if (extent > maxExtent) {
      maxExtent = extent
      // Position angle of the furthest rim point: North towards East, mod 180.
      maxAngleDeg = ((Math.atan2(e, n) * 180) / Math.PI + 360) % 180
    }
    if (extent < minExtent) minExtent = extent
  }
  return { semiMajor: maxExtent, semiMinor: minExtent, posAngDeg: maxAngleDeg }
}

describe('discBasis', () => {
  it('returns an orthonormal in-plane basis', () => {
    for (const [ra, dec, ratio, pa] of [
      [0, 0, 1, 0],
      [83.8, -5.4, 0.42, 119],
      [201.4, -43.0, 0.77, 35],
      [10.68, 41.27, 0.32, 38],
      [350, -89.9, 0.05, 174],
    ]) {
      const { u, v } = discBasis(ra, dec, ratio, pa)
      expect(norm(u)).toBeCloseTo(1, 12)
      expect(norm(v)).toBeCloseTo(1, 12)
      expect(dot(u, v)).toBeCloseTo(0, 12)
    }
  })

  it('projects to an ellipse with the catalogued axes and position angle', () => {
    // M31's numbers: a disc 3 degrees across, strongly inclined, at a position angle of
    // 38 degrees. The projected semi-minor must come out at exactly axisRatio times the
    // semi-major, because that is what the axis ratio means.
    const { semiMajor, semiMinor, posAngDeg } = projectRim(10.6847, 41.269, 0.32, 38, 1)
    expect(semiMajor).toBeCloseTo(1, 6)
    expect(semiMinor).toBeCloseTo(0.32, 4)
    expect(posAngDeg).toBeCloseTo(38, 2)
  })

  it('holds the projection across the whole sky, including near the poles', () => {
    for (const [ra, dec, ratio, pa] of [
      [0, 0, 0.5, 0],
      [90, 45, 0.25, 90],
      [180, -60, 0.8, 135],
      [270, 89.5, 0.6, 20],
      [45, -89.5, 0.4, 160],
      [359.9, 0.1, 0.15, 179],
    ]) {
      const { semiMajor, semiMinor, posAngDeg } = projectRim(ra, dec, ratio, pa, 1)
      expect(semiMajor).toBeCloseTo(1, 6)
      expect(semiMinor).toBeCloseTo(ratio, 4)
      // Position angle is a line, not an arrow, so it is only defined mod 180.
      const delta = Math.min(Math.abs(posAngDeg - pa), 180 - Math.abs(posAngDeg - pa))
      expect(delta).toBeLessThan(0.2)
    }
  })

  it('is a circle on the sky when the catalogue says face-on', () => {
    const { semiMajor, semiMinor } = projectRim(123, 17, 1, 72, 1)
    expect(semiMajor).toBeCloseTo(1, 6)
    expect(semiMinor).toBeCloseTo(1, 6)
  })

  it('collapses to a line along the major axis when edge-on', () => {
    const { semiMajor, semiMinor, posAngDeg } = projectRim(200, -12, 0, 64, 1)
    expect(semiMajor).toBeCloseTo(1, 6)
    expect(semiMinor).toBeCloseTo(0, 6)
    expect(posAngDeg).toBeCloseTo(64, 2)
  })

  it('puts the major axis along North at position angle zero, and East at ninety', () => {
    const { north, east } = skyFrame(137, 23)
    expect(Math.abs(dot(discBasis(137, 23, 0.5, 0).u, north))).toBeCloseTo(1, 10)
    expect(Math.abs(dot(discBasis(137, 23, 0.5, 90).u, east))).toBeCloseTo(1, 10)
  })

  it('tilts out of the sky plane by the inclination the axis ratio implies', () => {
    // The line-of-sight component of `v` is sin(inclination); the axis ratio is its
    // cosine. This is the step that turns a 2D measurement into a 3D object, so it is
    // worth pinning separately from the projection it produces.
    for (const ratio of [1, 0.9, 0.5, 0.2, 0]) {
      const { v } = discBasis(44, -9, ratio, 100)
      const { dir } = skyFrame(44, -9)
      expect(Math.abs(dot(v, dir))).toBeCloseTo(Math.sqrt(1 - ratio * ratio), 10)
    }
  })

  it('clamps an axis ratio the catalogue rounds above one, rather than emitting NaN', () => {
    // A minor axis can exceed its major by a hair through independent rounding. A naive
    // sqrt(1 - r*r) would be NaN, and a NaN in a vertex buffer erases the entire draw
    // call silently instead of failing — the worst possible way for this to go wrong.
    for (const ratio of [1.0001, 1.05, -0.01]) {
      const { u, v } = discBasis(60, 30, ratio, 45)
      for (const c of [u.x, u.y, u.z, v.x, v.y, v.z]) expect(Number.isFinite(c)).toBe(true)
      expect(norm(v)).toBeCloseTo(1, 12)
    }
  })

  it('cannot tell the four orientations apart, which is the point', () => {
    // +i and -i project identically, and a position angle is defined mod 180. All four
    // reconstructions produce the same silhouette; the atlas must therefore draw the
    // shape with confidence and claim nothing about which way the disc faces.
    const a = projectRim(77, 12, 0.45, 30, 1)
    const b = projectRim(77, 12, 0.45, 210, 1)
    expect(b.semiMajor).toBeCloseTo(a.semiMajor, 10)
    expect(b.semiMinor).toBeCloseTo(a.semiMinor, 10)
    expect(b.posAngDeg).toBeCloseTo(a.posAngDeg, 6)
  })
})
