import * as THREE from 'three'

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

function solveEccentricAnomaly(meanAnomaly: number, eccentricity: number): number {
  let E = eccentricity < 0.8 ? meanAnomaly : Math.PI
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const delta = (E - eccentricity * Math.sin(E) - meanAnomaly) / (1 - eccentricity * Math.cos(E))
    E -= delta
    if (Math.abs(delta) < 1e-10) break
  }
  return E
}

/**
 * Position of a body on its Keplerian orbit at `date`, expressed in the parent's
 * body-fixed equatorial frame (kilometres). Rotate by the parent's orientation
 * quaternion and add the parent's own position to place it in the scene.
 */
export function keplerianPosition(elements: KeplerianElements, date: Date): THREE.Vector3 {
  const daysSinceEpoch = (date.getTime() - elements.epoch.getTime()) / 86_400_000
  const meanMotion = TWO_PI / elements.periodDays
  const meanAnomaly =
    THREE.MathUtils.degToRad(elements.meanAnomalyDegAtEpoch) + meanMotion * daysSinceEpoch
  const normalizedMeanAnomaly = ((meanAnomaly % TWO_PI) + TWO_PI) % TWO_PI

  const eccentricAnomaly = solveEccentricAnomaly(normalizedMeanAnomaly, elements.eccentricity)
  const trueAnomaly =
    2 *
    Math.atan2(
      Math.sqrt(1 + elements.eccentricity) * Math.sin(eccentricAnomaly / 2),
      Math.sqrt(1 - elements.eccentricity) * Math.cos(eccentricAnomaly / 2),
    )
  const radius = elements.semiMajorAxisKm * (1 - elements.eccentricity * Math.cos(eccentricAnomaly))

  const xOrbitPlane = radius * Math.cos(trueAnomaly)
  const yOrbitPlane = radius * Math.sin(trueAnomaly)

  const position = new THREE.Vector3(xOrbitPlane, yOrbitPlane, 0)
  position.applyAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(elements.periapsisDeg))
  position.applyAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(elements.inclinationDeg))
  position.applyAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(elements.nodeDeg))

  return position
}

/** Mean orbital period (days) for a circular orbit of the given radius around a body of the given mass. */
export function periodFromSemiMajorAxis(semiMajorAxisKm: number, parentMassKg: number): number {
  const G = 6.6743e-11
  const a = semiMajorAxisKm * 1000
  const seconds = TWO_PI * Math.sqrt((a * a * a) / (G * parentMassKg))
  return seconds / 86_400
}
