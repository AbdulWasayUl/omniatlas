import { type Vec3d, vec3d } from '../core/world'

export interface KeplerianElements {
  /** Semi-major axis in kilometres. */
  semiMajorAxisKm: number
  eccentricity: number
  /** Inclination in degrees, relative to the parent body's equatorial plane. */
  inclinationDeg: number
  /** Longitude of the ascending node in degrees, relative to the parent's prime meridian at epoch. */
  nodeDeg: number
  /** Argument of periapsis in degrees. */
  periapsisDeg: number
  /** Mean anomaly in degrees at the reference epoch. */
  meanAnomalyDegAtEpoch: number
  /** Reference epoch as a JS Date. */
  epoch: Date
  /** Sidereal orbital period in days. Negative for retrograde orbits. */
  periodDays: number
}

const TWO_PI = Math.PI * 2
const DEG = Math.PI / 180

/**
 * Newton–Raphson on Kepler's equation. Starting from M is fine for near-circular
 * orbits; starting from pi is the standard remedy for high eccentricity, where the
 * naive guess can overshoot into a different branch.
 */
function solveEccentricAnomaly(meanAnomaly: number, eccentricity: number): number {
  let E = eccentricity < 0.8 ? meanAnomaly : Math.PI
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const delta = (E - eccentricity * Math.sin(E) - meanAnomaly) / (1 - eccentricity * Math.cos(E))
    E -= delta
    if (Math.abs(delta) < 1e-12) break
  }
  return E
}

/**
 * Position on a Keplerian orbit at `date`, in kilometres, expressed in the parent's
 * equatorial frame. Pure float64; the caller rotates it into a world frame.
 *
 * Rotation order is the standard one: argument of periapsis about the orbit normal,
 * then inclination about the node line, then the node about the reference pole.
 */
export function keplerianPosition(elements: KeplerianElements, date: Date): Vec3d {
  const daysSinceEpoch = (date.getTime() - elements.epoch.getTime()) / 86_400_000
  const meanMotion = TWO_PI / elements.periodDays
  const meanAnomaly = elements.meanAnomalyDegAtEpoch * DEG + meanMotion * daysSinceEpoch
  const normalized = ((meanAnomaly % TWO_PI) + TWO_PI) % TWO_PI

  const E = solveEccentricAnomaly(normalized, elements.eccentricity)
  const trueAnomaly =
    2 *
    Math.atan2(
      Math.sqrt(1 + elements.eccentricity) * Math.sin(E / 2),
      Math.sqrt(1 - elements.eccentricity) * Math.cos(E / 2),
    )
  const radius = elements.semiMajorAxisKm * (1 - elements.eccentricity * Math.cos(E))

  let x = radius * Math.cos(trueAnomaly)
  let y = radius * Math.sin(trueAnomaly)
  let z = 0

  // Rotate by argument of periapsis about Z.
  const w = elements.periapsisDeg * DEG
  let cos = Math.cos(w)
  let sin = Math.sin(w)
  ;[x, y] = [x * cos - y * sin, x * sin + y * cos]

  // Rotate by inclination about X.
  const i = elements.inclinationDeg * DEG
  cos = Math.cos(i)
  sin = Math.sin(i)
  ;[y, z] = [y * cos - z * sin, y * sin + z * cos]

  // Rotate by longitude of ascending node about Z.
  const n = elements.nodeDeg * DEG
  cos = Math.cos(n)
  sin = Math.sin(n)
  ;[x, y] = [x * cos - y * sin, x * sin + y * cos]

  return vec3d(x, y, z)
}

/** Mean orbital period (days) for a circular orbit of the given radius about the given mass. */
export function periodFromSemiMajorAxis(semiMajorAxisKm: number, parentMassKg: number): number {
  const G = 6.6743e-11
  const a = semiMajorAxisKm * 1000
  return (TWO_PI * Math.sqrt((a * a * a) / (G * parentMassKg))) / 86_400
}

/**
 * Sample one full orbit as a closed polyline, in kilometres in the parent's equatorial
 * frame. Sampling is uniform in eccentric anomaly rather than in time, which puts more
 * vertices near periapsis where the curvature is — a uniform-in-time sample of a comet
 * orbit spends almost every vertex out at aphelion where the path is nearly straight.
 */
export function sampleOrbit(elements: KeplerianElements, samples = 256): Vec3d[] {
  const points: Vec3d[] = []
  const { eccentricity: e, semiMajorAxisKm: a } = elements
  const w = elements.periapsisDeg * DEG
  const i = elements.inclinationDeg * DEG
  const n = elements.nodeDeg * DEG

  for (let s = 0; s <= samples; s++) {
    const E = (s / samples) * TWO_PI
    const trueAnomaly = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2))
    const radius = a * (1 - e * Math.cos(E))

    let x = radius * Math.cos(trueAnomaly)
    let y = radius * Math.sin(trueAnomaly)
    let z = 0
    let cos = Math.cos(w)
    let sin = Math.sin(w)
    ;[x, y] = [x * cos - y * sin, x * sin + y * cos]
    cos = Math.cos(i)
    sin = Math.sin(i)
    ;[y, z] = [y * cos - z * sin, y * sin + z * cos]
    cos = Math.cos(n)
    sin = Math.sin(n)
    ;[x, y] = [x * cos - y * sin, x * sin + y * cos]

    points.push(vec3d(x, y, z))
  }
  return points
}
