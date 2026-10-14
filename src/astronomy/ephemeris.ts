import { Body, GeoVector, HelioVector, JupiterMoons, MoonPhase, RotationAxis } from 'astronomy-engine'
import { keplerianPosition, type KeplerianElements } from './orbit'
import { AU_M, type FrameId, type Vec3d, convertFrame, vec3d } from '../core/world'

/**
 * Ephemeris: astronomy-engine in, float64 SI metres out.
 *
 * This module knows nothing about Three.js, render units, or the camera. It answers one
 * question — where is this body, and which way is it pointing, at this instant — in the
 * canonical world model. Everything that used to live here about display scaling has
 * moved to the renderer, where it belongs, and the compression laws it used to apply are
 * gone entirely.
 */

/** astronomy-engine emits positions in AU in the EQJ (ICRF/J2000 equatorial) frame. */
const ENGINE_FRAME: FrameId = 'icrf'

export interface BodyPose {
  /** Position in metres, in `frame`. */
  position: Vec3d
  frame: FrameId
  /**
   * Orientation as an axis-angle triple describing the body-fixed frame:
   * `north` is the rotation pole and `spinRadians` the prime-meridian angle about it.
   * Both are expressed in ICRF. The renderer turns this into a quaternion; keeping it
   * as geometry here means this file never imports a matrix library.
   */
  north: Vec3d
  spinRadians: number
}

/** Map our catalogue ids onto astronomy-engine's Body enum. */
export function engineBody(key: string | undefined): Body | null {
  if (!key) return null
  const body = Body[key as keyof typeof Body]
  return typeof body === 'string' ? body : null
}

/** Heliocentric position of a body, in metres. */
export function heliocentricPosition(key: string, date: Date, frame: FrameId = 'ecliptic'): Vec3d | null {
  const body = engineBody(key)
  if (!body) return null
  const v = HelioVector(body, date)
  const icrf = vec3d(v.x * AU_M, v.y * AU_M, v.z * AU_M)
  return convertFrame(vec3d(), icrf, ENGINE_FRAME, frame)
}

/** Geocentric position of a body, in metres. Used for the Moon and for Sun direction. */
export function geocentricPosition(key: string, date: Date, frame: FrameId = 'ecliptic'): Vec3d | null {
  const body = engineBody(key)
  if (!body) return null
  const v = GeoVector(body, date, true)
  const icrf = vec3d(v.x * AU_M, v.y * AU_M, v.z * AU_M)
  return convertFrame(vec3d(), icrf, ENGINE_FRAME, frame)
}

/**
 * IAU 2015 rotation elements for a body: its pole direction and prime-meridian angle.
 * Returned in ICRF; the caller converts.
 */
export function bodyOrientation(key: string, date: Date): { north: Vec3d; spinRadians: number } | null {
  const body = engineBody(key)
  if (!body) return null
  try {
    const axis = RotationAxis(body, date)
    return {
      north: vec3d(axis.north.x, axis.north.y, axis.north.z),
      spinRadians: (axis.spin * Math.PI) / 180,
    }
  } catch {
    // astronomy-engine has no rotation model for some bodies; the caller falls back.
    return null
  }
}

/** The four Galilean moons, positioned relative to Jupiter, in metres. */
export function galileanMoonOffsets(date: Date, frame: FrameId = 'ecliptic'): Record<string, Vec3d> {
  const moons = JupiterMoons(date)
  const out: Record<string, Vec3d> = {}
  const pairs: [string, { x: number; y: number; z: number }][] = [
    ['io', moons.io],
    ['europa', moons.europa],
    ['ganymede', moons.ganymede],
    ['callisto', moons.callisto],
  ]
  for (const [id, v] of pairs) {
    const icrf = vec3d(v.x * AU_M, v.y * AU_M, v.z * AU_M)
    out[id] = convertFrame(vec3d(), icrf, ENGINE_FRAME, frame)
  }
  return out
}

/**
 * Position of a Keplerian satellite relative to its parent, in metres.
 *
 * The elements are referred to the parent's equatorial plane, which is the convention
 * JPL publishes mean elements in. `parentNorth` supplies that plane.
 */
export function keplerianOffset(
  elements: KeplerianElements,
  date: Date,
  parentNorth: Vec3d,
  frame: FrameId = 'ecliptic',
): Vec3d {
  const local = keplerianPosition(elements, date)
  // Build an orthonormal basis with +Z along the parent's pole. The zero-longitude
  // direction is arbitrary but fixed, so the orbit's plane, period and inclination are
  // right while its absolute phase is a documented approximation.
  const z = normalise(parentNorth)
  const seed = Math.abs(z.z) < 0.9 ? vec3d(0, 0, 1) : vec3d(1, 0, 0)
  const x = normalise(reject(seed, z))
  const y = cross(z, x)

  const icrf = vec3d(
    (x.x * local.x + y.x * local.y + z.x * local.z) * 1000,
    (x.y * local.x + y.y * local.y + z.y * local.z) * 1000,
    (x.z * local.x + y.z * local.y + z.z * local.z) * 1000,
  )
  return convertFrame(vec3d(), icrf, ENGINE_FRAME, frame)
}

/** Lunar phase angle in degrees, 0 = new, 180 = full. */
export function lunarPhaseAngle(date: Date): number {
  return MoonPhase(date)
}

// --- small vector helpers, local so this file imports no matrix library ---

function normalise(v: Vec3d): Vec3d {
  const len = Math.hypot(v.x, v.y, v.z)
  return len === 0 ? vec3d(0, 0, 1) : vec3d(v.x / len, v.y / len, v.z / len)
}

function reject(v: Vec3d, onto: Vec3d): Vec3d {
  const d = v.x * onto.x + v.y * onto.y + v.z * onto.z
  return vec3d(v.x - onto.x * d, v.y - onto.y * d, v.z - onto.z * d)
}

function cross(a: Vec3d, b: Vec3d): Vec3d {
  return vec3d(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
}

export type { KeplerianElements }
