import { describe, expect, it } from 'vitest'
import {
  AU_M,
  LY_M,
  MPC_M,
  OBLIQUITY_J2000_DEG,
  PC_M,
  applyMat3,
  cartesianToSpherical,
  convertFrame,
  distance3d,
  frameRotation,
  sphericalToCartesian,
  vec3d,
  worldToSceneBasis,
} from '../../src/core/world'

/**
 * The published ICRS -> galactic rotation (ESA SP-1200, the Hipparcos and Tycho
 * catalogues, vol. 1 sect. 1.5.3). `world.ts` builds its matrix from the three
 * defining angles instead of pasting these numbers, so this test is what proves
 * the construction — including the sign convention of the longitude term, which
 * is easy to get backwards and silently rotates the entire galaxy.
 */
const ICRF_TO_GALACTIC_REFERENCE = [
  -0.0548755604162154, -0.873437090234885, -0.4838350155487132, 0.4941094278755837, -0.4448296299600112,
  0.7469822444972189, -0.8676661490190047, -0.1980763734312015, 0.4559837761750669,
]

/** de Vaucouleurs galactic -> supergalactic. */
const GALACTIC_TO_SUPERGALACTIC_REFERENCE = [
  -0.7357425748, 0.6772612298, 0.0, -0.0745283361, -0.0809559643, 0.9939225904, 0.6731453949, 0.7312711858,
  0.1100812618,
]

describe('units', () => {
  it('uses the exact IAU astronomical unit', () => {
    expect(AU_M).toBe(1.495978707e11)
  })

  it('derives the parsec consistently with the AU and the arcsecond', () => {
    // 1 pc is the distance at which 1 AU subtends 1 arcsecond.
    const arcsecond = Math.PI / (180 * 3600)
    // Compare relatively: these are 1e16-magnitude numbers, so an absolute
    // tolerance is meaningless. The two definitions agree to ~1e-11.
    expect(Math.abs(PC_M / (AU_M / Math.tan(arcsecond)) - 1)).toBeLessThan(1e-10)
  })

  it('relates the parsec and the light-year', () => {
    expect(PC_M / LY_M).toBeCloseTo(3.26156, 4)
  })

  it('scales the megaparsec from the parsec exactly', () => {
    expect(MPC_M).toBe(PC_M * 1e6)
  })
})

describe('frame rotations', () => {
  it('matches the published ICRS to galactic matrix', () => {
    const m = frameRotation('icrf', 'galactic')
    for (let i = 0; i < 9; i++) {
      expect(m[i]).toBeCloseTo(ICRF_TO_GALACTIC_REFERENCE[i], 9)
    }
  })

  it('matches the published galactic to supergalactic matrix', () => {
    const m = frameRotation('galactic', 'supergalactic')
    // Tolerance is 1e-4, not 1e-9: the supergalactic pole and longitude origin are
    // themselves published to only two decimal places, so this is the full precision
    // the definition carries. See frameFromPoleAndOrigin in world.ts.
    for (let i = 0; i < 9; i++) {
      expect(m[i]).toBeCloseTo(GALACTIC_TO_SUPERGALACTIC_REFERENCE[i], 4)
    }
  })

  it('places Sgr A* at the galactic origin', () => {
    // Sgr A* — the galactic centre — sits at ICRS (266.41683, -29.00781) and by
    // construction defines galactic (l, b) ~ (0, 0).
    const v = sphericalToCartesian(vec3d(), 266.41683, -29.00781, 1)
    const g = convertFrame(vec3d(), v, 'icrf', 'galactic')
    const { lonDeg, latDeg } = cartesianToSpherical(g)
    expect(Math.min(lonDeg, 360 - lonDeg)).toBeLessThan(0.1)
    expect(Math.abs(latDeg)).toBeLessThan(0.1)
  })

  it('places the north celestial pole at the expected galactic longitude', () => {
    const ncp = vec3d(0, 0, 1)
    const g = convertFrame(vec3d(), ncp, 'icrf', 'galactic')
    const { lonDeg, latDeg } = cartesianToSpherical(g)
    expect(lonDeg).toBeCloseTo(122.93192, 3)
    // The NCP sits 90 - dec_NGP = 62.87 deg away from the galactic pole, so its
    // galactic LATITUDE is the complement of that: 27.12825 deg.
    expect(latDeg).toBeCloseTo(27.12825, 3)
  })

  it('tilts the ecliptic from the equator by the obliquity', () => {
    // The north ecliptic pole, seen from the equatorial frame, is inclined by eps.
    const nep = convertFrame(vec3d(), vec3d(0, 0, 1), 'ecliptic', 'icrf')
    const { latDeg } = cartesianToSpherical(nep)
    expect(90 - latDeg).toBeCloseTo(OBLIQUITY_J2000_DEG, 9)
  })

  it('leaves the vernal equinox fixed between equatorial and ecliptic', () => {
    // The shared X axis is the rotation axis, so it must be invariant.
    const equinox = vec3d(1, 0, 0)
    const e = convertFrame(vec3d(), equinox, 'icrf', 'ecliptic')
    expect(e.x).toBeCloseTo(1, 12)
    expect(e.y).toBeCloseTo(0, 12)
    expect(e.z).toBeCloseTo(0, 12)
  })

  it('round-trips through every frame pair without drift', () => {
    const frames = ['icrf', 'ecliptic', 'galactic', 'supergalactic'] as const
    const v = vec3d(0.3, -0.7, 0.4)
    for (const from of frames) {
      for (const to of frames) {
        const there = convertFrame(vec3d(), v, from, to)
        const back = convertFrame(vec3d(), there, to, from)
        expect(distance3d(back, v)).toBeLessThan(1e-14)
      }
    }
  })

  it('preserves length under every frame rotation', () => {
    const v = sphericalToCartesian(vec3d(), 73.2, -41.9, 12345.678)
    for (const to of ['ecliptic', 'galactic', 'supergalactic'] as const) {
      const r = convertFrame(vec3d(), v, 'icrf', to)
      expect(Math.hypot(r.x, r.y, r.z)).toBeCloseTo(12345.678, 9)
    }
  })

  it('builds proper rotations with determinant +1', () => {
    for (const to of ['ecliptic', 'galactic', 'supergalactic'] as const) {
      const m = frameRotation('icrf', to)
      const det =
        m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
      expect(det).toBeCloseTo(1, 12)
    }
  })
})

describe('spherical conversion', () => {
  it('round-trips longitude and latitude', () => {
    for (const [lon, lat] of [
      [0, 0],
      [359.9, -89.5],
      [180, 45],
      [97.3, -12.8],
    ]) {
      const v = sphericalToCartesian(vec3d(), lon, lat, 7)
      const s = cartesianToSpherical(v)
      expect(s.lonDeg).toBeCloseTo(lon, 9)
      expect(s.latDeg).toBeCloseTo(lat, 9)
      expect(s.radius).toBeCloseTo(7, 9)
    }
  })

  it('returns longitude in [0, 360)', () => {
    const v = sphericalToCartesian(vec3d(), -30, 10, 1)
    expect(cartesianToSpherical(v).lonDeg).toBeCloseTo(330, 9)
  })
})

describe('scene basis', () => {
  it('is a proper rotation: Z-up world to Y-up scene', () => {
    // toBeCloseTo rather than toEqual: negating a zero component yields -0, which
    // Object.is distinguishes from +0 while the geometry does not.
    const up = worldToSceneBasis(vec3d(), vec3d(0, 0, 1))
    expect(up.x).toBeCloseTo(0, 12)
    expect(up.y).toBeCloseTo(1, 12)
    expect(up.z).toBeCloseTo(0, 12)
    const y = worldToSceneBasis(vec3d(), vec3d(0, 1, 0))
    expect(y.x).toBeCloseTo(0, 12)
    expect(y.y).toBeCloseTo(0, 12)
    expect(y.z).toBeCloseTo(-1, 12)
  })

  it('preserves length', () => {
    const v = worldToSceneBasis(vec3d(), vec3d(3, -4, 12))
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(13, 12)
  })
})

describe('precision at scale', () => {
  it('keeps metre-scale resolution at interstellar distance in float64', () => {
    // Proxima Centauri is ~1.30 pc away. Float64's 52-bit mantissa gives an ULP of
    // roughly 8 m there - about 2e-16 of the distance. Float32 would give ~5e9 m.
    const d = 1.3 * PC_M
    let ulp = 1
    while (d + ulp === d) ulp *= 2
    expect(ulp).toBeLessThan(16)
    // The same distance in float32: one ULP is ~4.8e9 m, i.e. ~0.16 light-years.
    let ulp32 = 1
    while (Math.fround(Math.fround(d) + ulp32) === Math.fround(d)) ulp32 *= 2
    expect(ulp32).toBeGreaterThan(1e9)
  })

  it('demonstrates the float32 failure this architecture exists to avoid', () => {
    // Neptune at 30 AU expressed in Earth radii — the old render unit — then
    // rounded to float32, loses hundreds of kilometres.
    const neptuneInEarthRadii = (30 * AU_M) / 6_371_000
    const asFloat32 = Math.fround(neptuneInEarthRadii)
    const errorMetres = Math.abs(asFloat32 - neptuneInEarthRadii) * 6_371_000
    expect(errorMetres).toBeGreaterThan(1000)
  })

  it('resolves a kilometre on a moon-sized body placed at 30 AU, camera-relative', () => {
    // The architecture's actual claim: a vertex 1353 km from its own object origin
    // survives the float32 downcast, because the origin is subtracted in float64 first.
    const bodyOrigin = vec3d(30 * AU_M, 0, 0)
    const camera = vec3d(30 * AU_M + 5e7, 0, 0)
    const relativeMetres = bodyOrigin.x - camera.x
    const unitMetres = 1e6 // the `system` layer: 1 unit = 1000 km
    const local = Math.fround(relativeMetres / unitMetres)
    const vertex = Math.fround(local + 1_353_000 / unitMetres)
    const errorMetres = Math.abs((vertex - local) * unitMetres - 1_353_000)
    expect(errorMetres).toBeLessThan(1000)
  })
})

describe('matrix helpers', () => {
  it('applies a rotation to a vector the same way for identity', () => {
    const v = vec3d(1, 2, 3)
    const out = applyMat3(vec3d(), frameRotation('icrf', 'icrf'), v)
    expect([out.x, out.y, out.z]).toEqual([1, 2, 3])
  })
})
