/**
 * The float64 world model.
 *
 * Every canonical position in OmniAtlas is a `Vec3d` in **SI metres**, double precision,
 * in one of the four reference frames below. Nothing in this file knows about Three.js,
 * render units, or the screen.
 *
 * Why this exists: float32 has a 24-bit mantissa, so a coordinate of magnitude `m` carries
 * an error of `m * 2^-23`. The previous architecture wrote absolute heliocentric positions
 * straight into `THREE.Vector3`, putting Neptune at ~7.1e5 render units where one ULP is
 * ~535 km — larger than many of the moons being drawn. At one parsec the error reaches
 * ~1e9 km. No stellar layer can be built on that. Positions therefore stay here, in float64,
 * and are converted to small camera-relative floats exactly once, in `Layer.ts`.
 */

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** Astronomical unit (IAU 2012 definition, exact). */
export const AU_M = 1.495978707e11
/** Parsec, derived from the AU and the arcsecond (exact under IAU 2015). */
// 3.0856775814913673e16 to full published precision; written as the shortest literal
// that round-trips to the same float64, so the source says exactly what runs.
export const PC_M = 3.085677581491367e16
/** Light-year (IAU: Julian year x c, exact). */
export const LY_M = 9.4607304725808e15
/** Kiloparsec. */
export const KPC_M = PC_M * 1e3
/** Megaparsec. */
export const MPC_M = PC_M * 1e6
/** Gigaparsec. */
export const GPC_M = PC_M * 1e9
/** Speed of light in vacuum (exact). */
export const C_M_S = 299_792_458
/** Julian year in seconds (exact). */
export const JULIAN_YEAR_S = 31_557_600

/** Mean Earth radius (IUGG), the historical display unit of the old renderer. */
export const EARTH_RADIUS_M = 6_371_000
/** Equatorial solar radius (IAU 2015 nominal). */
export const SUN_RADIUS_M = 6.957e8
/** Mean lunar radius. */
export const MOON_RADIUS_M = 1_737_400

// ---------------------------------------------------------------------------
// Vec3d — a plain float64 triple. Deliberately not a class: these are created in
// hot loops and we want them to stay monomorphic, allocation-cheap, and trivially
// structured-cloneable across the worker boundary.
// ---------------------------------------------------------------------------

export interface Vec3d {
  x: number
  y: number
  z: number
}

export function vec3d(x = 0, y = 0, z = 0): Vec3d {
  return { x, y, z }
}

export function clone3d(a: Vec3d): Vec3d {
  return { x: a.x, y: a.y, z: a.z }
}

export function set3d(out: Vec3d, x: number, y: number, z: number): Vec3d {
  out.x = x
  out.y = y
  out.z = z
  return out
}

export function copy3d(out: Vec3d, a: Vec3d): Vec3d {
  out.x = a.x
  out.y = a.y
  out.z = a.z
  return out
}

export function add3d(out: Vec3d, a: Vec3d, b: Vec3d): Vec3d {
  out.x = a.x + b.x
  out.y = a.y + b.y
  out.z = a.z + b.z
  return out
}

export function sub3d(out: Vec3d, a: Vec3d, b: Vec3d): Vec3d {
  out.x = a.x - b.x
  out.y = a.y - b.y
  out.z = a.z - b.z
  return out
}

export function scale3d(out: Vec3d, a: Vec3d, s: number): Vec3d {
  out.x = a.x * s
  out.y = a.y * s
  out.z = a.z * s
  return out
}

/** `out = a + b * s`. The workhorse of orbit accumulation. */
export function addScaled3d(out: Vec3d, a: Vec3d, b: Vec3d, s: number): Vec3d {
  out.x = a.x + b.x * s
  out.y = a.y + b.y * s
  out.z = a.z + b.z * s
  return out
}

export function dot3d(a: Vec3d, b: Vec3d): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

export function cross3d(out: Vec3d, a: Vec3d, b: Vec3d): Vec3d {
  const x = a.y * b.z - a.z * b.y
  const y = a.z * b.x - a.x * b.z
  const z = a.x * b.y - a.y * b.x
  out.x = x
  out.y = y
  out.z = z
  return out
}

export function lengthSq3d(a: Vec3d): number {
  return a.x * a.x + a.y * a.y + a.z * a.z
}

export function length3d(a: Vec3d): number {
  return Math.hypot(a.x, a.y, a.z)
}

/** Distance between two world points, in metres. Uses hypot to avoid overflow at cosmic magnitudes. */
export function distance3d(a: Vec3d, b: Vec3d): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

export function normalize3d(out: Vec3d, a: Vec3d): Vec3d {
  const len = length3d(a)
  if (len === 0) return set3d(out, 0, 0, 0)
  return scale3d(out, a, 1 / len)
}

/** Linear interpolation. Only meaningful for points in the same frame. */
export function lerp3d(out: Vec3d, a: Vec3d, b: Vec3d, t: number): Vec3d {
  out.x = a.x + (b.x - a.x) * t
  out.y = a.y + (b.y - a.y) * t
  out.z = a.z + (b.z - a.z) * t
  return out
}

export function isFinite3d(a: Vec3d): boolean {
  return Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z)
}

export const ZERO3D: Readonly<Vec3d> = Object.freeze({ x: 0, y: 0, z: 0 })

// ---------------------------------------------------------------------------
// Reference frames
// ---------------------------------------------------------------------------

/**
 * The orientation frames OmniAtlas works in. Positions are always metres; a frame
 * only fixes which way the axes point.
 *
 * - `icrf`     ICRS / J2000 equatorial. What astronomy-engine and the star catalogues emit.
 * - `ecliptic` J2000 ecliptic. The natural frame for heliocentric orbits — planets sit
 *              within a few degrees of its XY plane.
 * - `galactic` IAU 1958 galactic. X toward the galactic centre, Z toward the north
 *              galactic pole.
 * - `supergalactic` de Vaucouleurs. The natural frame for large-scale structure; the
 *              local sheet of galaxies lies near its XY plane.
 */
export type FrameId = 'icrf' | 'ecliptic' | 'galactic' | 'supergalactic'

/** Obliquity of the ecliptic at J2000.0 = 23 deg 26' 21.448" (IAU 1976 / Lieske). */
export const OBLIQUITY_J2000_DEG = 23.43929111111111
const OBLIQUITY_J2000_RAD = (OBLIQUITY_J2000_DEG * Math.PI) / 180

/**
 * A 3x3 rotation matrix in row-major order, float64.
 * `m[row * 3 + col]`. Rotations only — never scale, never translation.
 */
export type Mat3 = Float64Array

export function mat3Identity(): Mat3 {
  return new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
}

/** `out = a * b` (apply b first, then a). */
export function mat3Multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Float64Array(9)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
    }
  }
  return out
}

/** Transpose, which for a rotation matrix is also its inverse. */
export function mat3Transpose(m: Mat3): Mat3 {
  return new Float64Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]])
}

export function applyMat3(out: Vec3d, m: Mat3, v: Vec3d): Vec3d {
  const { x, y, z } = v
  out.x = m[0] * x + m[1] * y + m[2] * z
  out.y = m[3] * x + m[4] * y + m[5] * z
  out.z = m[6] * x + m[7] * y + m[8] * z
  return out
}

function rotationX(theta: number): Mat3 {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  return new Float64Array([1, 0, 0, 0, c, s, 0, -s, c])
}

function rotationZ(theta: number): Mat3 {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  return new Float64Array([c, s, 0, -s, c, 0, 0, 0, 1])
}

const DEG = Math.PI / 180

// --- ICRF -> ecliptic -------------------------------------------------------
// A single rotation about the shared X axis (the vernal equinox) by the obliquity.
const M_ICRF_TO_ECLIPTIC = rotationX(OBLIQUITY_J2000_RAD)

// --- ICRF -> galactic -------------------------------------------------------
// Built from the three defining angles rather than pasted as magic numbers, so the
// construction is auditable. The result is asserted against the published Hipparcos
// matrix in tests/unit/frames.test.ts.
//
//   alpha_NGP = 192.85948 deg   right ascension of the north galactic pole
//   delta_NGP =  27.12825 deg   declination of the north galactic pole
//   l_NCP     = 122.93192 deg   galactic longitude of the north celestial pole
export const GALACTIC_POLE_RA_DEG = 192.85948
export const GALACTIC_POLE_DEC_DEG = 27.12825
export const GALACTIC_LON_NCP_DEG = 122.93192

const M_ICRF_TO_GALACTIC = mat3Multiply(
  rotationZ(Math.PI / 2 - GALACTIC_LON_NCP_DEG * DEG),
  mat3Multiply(rotationX(Math.PI / 2 - GALACTIC_POLE_DEC_DEG * DEG), rotationZ(GALACTIC_POLE_RA_DEG * DEG + Math.PI / 2)),
)

// --- galactic -> supergalactic ---------------------------------------------
// The supergalactic pole lies at galactic (l, b) = (47.37, +6.32); supergalactic
// longitude is measured from galactic (l, b) = (137.37, 0).
export const SUPERGALACTIC_POLE_L_DEG = 47.37
export const SUPERGALACTIC_POLE_B_DEG = 6.32
export const SUPERGALACTIC_LON_ORIGIN_L_DEG = 137.37

/**
 * Build a frame rotation from its pole and its longitude origin, both expressed as
 * directions in the source frame.
 *
 * Unlike the galactic case, the supergalactic defining constants are not mutually
 * exact: the published SGL=0 direction (l=137.37, b=0) is not precisely perpendicular
 * to the published pole (l=47.37, b=+6.32), because both are quoted to only two
 * decimals. Composing Euler angles from them therefore produces a matrix that is
 * visibly wrong (0.73 absolute error against the de Vaucouleurs matrix). Projecting
 * the longitude origin onto the plane perpendicular to the pole and completing the
 * basis reproduces the published matrix to ~4e-5, which is the actual precision the
 * defining constants carry.
 */
function frameFromPoleAndOrigin(poleLonDeg: number, poleLatDeg: number, originLonDeg: number): Mat3 {
  const z = sphericalToCartesian(vec3d(), poleLonDeg, poleLatDeg, 1)
  const rawX = sphericalToCartesian(vec3d(), originLonDeg, 0, 1)
  const x = normalize3d(vec3d(), addScaled3d(vec3d(), rawX, z, -dot3d(rawX, z)))
  const y = normalize3d(vec3d(), cross3d(vec3d(), z, x))
  // Rows of a rotation matrix are the target frame's basis vectors in source coordinates.
  return new Float64Array([x.x, x.y, x.z, y.x, y.y, y.z, z.x, z.y, z.z])
}

const M_GALACTIC_TO_SUPERGALACTIC = frameFromPoleAndOrigin(
  SUPERGALACTIC_POLE_L_DEG,
  SUPERGALACTIC_POLE_B_DEG,
  SUPERGALACTIC_LON_ORIGIN_L_DEG,
)

const M_ICRF_TO_SUPERGALACTIC = mat3Multiply(M_GALACTIC_TO_SUPERGALACTIC, M_ICRF_TO_GALACTIC)

/** Rotation from each frame into ICRF (the hub frame). */
const TO_ICRF: Record<FrameId, Mat3> = {
  icrf: mat3Identity(),
  ecliptic: mat3Transpose(M_ICRF_TO_ECLIPTIC),
  galactic: mat3Transpose(M_ICRF_TO_GALACTIC),
  supergalactic: mat3Transpose(M_ICRF_TO_SUPERGALACTIC),
}

/** Rotation from ICRF into each frame. */
const FROM_ICRF: Record<FrameId, Mat3> = {
  icrf: mat3Identity(),
  ecliptic: M_ICRF_TO_ECLIPTIC,
  galactic: M_ICRF_TO_GALACTIC,
  supergalactic: M_ICRF_TO_SUPERGALACTIC,
}

const frameCache = new Map<string, Mat3>()

/**
 * The rotation taking a vector expressed in `from` to the same vector expressed in `to`.
 * Composed through ICRF and memoised — there are only sixteen possible answers.
 */
export function frameRotation(from: FrameId, to: FrameId): Mat3 {
  if (from === to) return TO_ICRF.icrf
  const key = `${from}>${to}`
  const hit = frameCache.get(key)
  if (hit) return hit
  const m = mat3Multiply(FROM_ICRF[to], TO_ICRF[from])
  frameCache.set(key, m)
  return m
}

/** Convert a position (or any vector) between frames. Allocation-free when `out` is supplied. */
export function convertFrame(out: Vec3d, v: Vec3d, from: FrameId, to: FrameId): Vec3d {
  if (from === to) return copy3d(out, v)
  return applyMat3(out, frameRotation(from, to), v)
}

// ---------------------------------------------------------------------------
// Spherical <-> cartesian
// ---------------------------------------------------------------------------

/**
 * Spherical direction plus radius to cartesian, in whatever frame the angles are given.
 * `lonDeg` is RA / galactic l / supergalactic SGL; `latDeg` is Dec / b / SGB.
 */
export function sphericalToCartesian(out: Vec3d, lonDeg: number, latDeg: number, radius: number): Vec3d {
  const lon = lonDeg * DEG
  const lat = latDeg * DEG
  const cosLat = Math.cos(lat)
  out.x = radius * cosLat * Math.cos(lon)
  out.y = radius * cosLat * Math.sin(lon)
  out.z = radius * Math.sin(lat)
  return out
}

export interface Spherical {
  /** Degrees, in [0, 360). */
  lonDeg: number
  /** Degrees, in [-90, 90]. */
  latDeg: number
  /** Metres (or whatever unit the input used). */
  radius: number
}

export function cartesianToSpherical(v: Vec3d): Spherical {
  const radius = length3d(v)
  if (radius === 0) return { lonDeg: 0, latDeg: 0, radius: 0 }
  let lonDeg = (Math.atan2(v.y, v.x) * 180) / Math.PI
  if (lonDeg < 0) lonDeg += 360
  return { lonDeg, latDeg: (Math.asin(v.z / radius) * 180) / Math.PI, radius }
}

/** Right ascension given in hours — the convention several star catalogues use. */
export function raHoursToDegrees(hours: number): number {
  return hours * 15
}

// ---------------------------------------------------------------------------
// Scene basis
// ---------------------------------------------------------------------------

/**
 * Astronomical frames are Z-up; Three.js cameras and controls assume Y-up. Rather than
 * fight that everywhere, each `Layer` applies this single swap when it downcasts a world
 * position to render units:
 *
 *     scene.x =  world.x
 *     scene.y =  world.z
 *     scene.z = -world.y
 *
 * This is a proper rotation (determinant +1), so handedness and cross products survive it.
 * It is the ONLY place the two conventions meet.
 */
export function worldToSceneBasis(out: Vec3d, v: Vec3d): Vec3d {
  const { x, y, z } = v
  out.x = x
  out.y = z
  out.z = -y
  return out
}

export function sceneToWorldBasis(out: Vec3d, v: Vec3d): Vec3d {
  const { x, y, z } = v
  out.x = x
  out.y = -z
  out.z = y
  return out
}

// ---------------------------------------------------------------------------
// Light travel
// ---------------------------------------------------------------------------

/** Seconds for light to cross `metres`. */
export function lightTravelSeconds(metres: number): number {
  return metres / C_M_S
}

/** Years for light to cross `metres`. */
export function lightTravelYears(metres: number): number {
  return metres / LY_M
}
