import { Body, GeoVector, HelioVector, JupiterMoons, MoonPhase, RotationAxis } from 'astronomy-engine'
import * as THREE from 'three'
import {
  AU_IN_EARTH_RADII,
  AU_KM,
  SUN_RADIUS_KM,
  explorationDistanceForAu,
  explorationMoonDistance,
  explorationRadiusUnits,
  kmToUnits,
} from '../data/constants'
import { NOTABLE_SMALL_BODIES } from '../data/asteroidBelt'
import { DWARF_PLANETS, PLANETS, findPlanet } from '../data/planets'
import { MOONS, MOON_ENGINE_SOURCE, moonsOf } from '../data/moons'
import type { AtlasEntity } from '../data/types'
import type { DistanceMode } from '../store/useExplorerStore'
import { keplerianPosition } from './orbit'

const JUPITER_MOON_KEYS = ['io', 'europa', 'ganymede', 'callisto'] as const

export interface BodyState {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  radiusUnits: number
}

export interface SolarSystemEphemeris {
  date: Date
  distanceMode: DistanceMode
  bodies: Map<string, BodyState>
  moonDistanceKm: number
  sunDistanceKm: number
  moonPhaseAngle: number
}

function eqjToScene(vector: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(vector.x, vector.z, -vector.y)
}

function engineBodyOf(entity: AtlasEntity | null | undefined): Body | null {
  if (!entity?.engineBody) return null
  const body = Body[entity.engineBody as keyof typeof Body]
  return body ?? null
}

function bodyOrientation(body: Body, date: Date): THREE.Quaternion {
  const axis = RotationAxis(body, date)
  const northEqj = new THREE.Vector3(axis.north.x, axis.north.y, axis.north.z).normalize()
  const poleRightAscension = THREE.MathUtils.degToRad(axis.ra * 15)
  const primeAtZero = new THREE.Vector3(
    -Math.sin(poleRightAscension),
    Math.cos(poleRightAscension),
    0,
  ).normalize()
  const primeMeridian = primeAtZero.applyAxisAngle(
    northEqj,
    THREE.MathUtils.degToRad(axis.spin),
  )
  const east = new THREE.Vector3().crossVectors(northEqj, primeMeridian).normalize()

  const localX = eqjToScene(primeMeridian).normalize()
  const localY = eqjToScene(northEqj).normalize()
  const localZ = eqjToScene(east).multiplyScalar(-1).normalize()
  const matrix = new THREE.Matrix4().makeBasis(localX, localY, localZ)

  return new THREE.Quaternion().setFromRotationMatrix(matrix).normalize()
}

/**
 * A slowly-precessing frame anchored to a parent body's rotation pole, used to orient
 * Keplerian moon orbits. Unlike `bodyOrientation`, this deliberately omits the fast
 * prime-meridian spin term — an orbital plane does not rotate with its planet's spin.
 * The equatorial reference (zero-node) direction is an arbitrary-but-fixed axis, not
 * the true astronomical node epoch, so absolute orbital phase for these moons is a
 * documented approximation; period, radius, and inclination magnitude are accurate.
 */
function parentEquatorialFrame(body: Body, date: Date): THREE.Quaternion {
  const axis = RotationAxis(body, date)
  const northEqj = new THREE.Vector3(axis.north.x, axis.north.y, axis.north.z).normalize()
  const pole = eqjToScene(northEqj).normalize()
  const reference = Math.abs(pole.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)
  const equatorialX = reference.clone().projectOnPlane(pole).normalize()
  const equatorialY = new THREE.Vector3().crossVectors(pole, equatorialX).normalize()
  const matrix = new THREE.Matrix4().makeBasis(equatorialX, equatorialY, pole)
  return new THREE.Quaternion().setFromRotationMatrix(matrix).normalize()
}

/** True radius in physical mode; compressed (but order-preserving) in exploration mode. */
function displayRadiusUnits(trueRadiusKm: number, distanceMode: DistanceMode): number {
  const trueRadiusUnits = kmToUnits(trueRadiusKm)
  return distanceMode === 'physical' ? trueRadiusUnits : explorationRadiusUnits(trueRadiusUnits)
}

function tidalLockQuaternion(offsetFromParent: THREE.Vector3): THREE.Quaternion {
  const direction = offsetFromParent.lengthSq() > 0 ? offsetFromParent.clone().normalize() : new THREE.Vector3(0, 0, 1)
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction)
}

function planetPosition(entity: AtlasEntity, date: Date, distanceMode: DistanceMode): THREE.Vector3 {
  const body = engineBodyOf(entity)
  if (!body) return new THREE.Vector3()
  const helio = HelioVector(body, date)
  const sceneVector = eqjToScene(helio)
  if (distanceMode === 'physical') return sceneVector.multiplyScalar(AU_IN_EARTH_RADII)
  const auDistance = sceneVector.length()
  if (auDistance < 1e-9) return new THREE.Vector3()
  return sceneVector.normalize().multiplyScalar(explorationDistanceForAu(auDistance))
}

function keplerianMoonOffset(
  moon: AtlasEntity,
  parentBody: Body,
  parentRadiusUnits: number,
  date: Date,
  distanceMode: DistanceMode,
): THREE.Vector3 {
  if (!moon.elements) return new THREE.Vector3()
  const localKm = keplerianPosition(moon.elements, date)
  const frame = parentEquatorialFrame(parentBody, date)
  const physicalUnits = new THREE.Vector3(localKm.x, localKm.y, localKm.z)
    .multiplyScalar(1 / 6_371)
    .applyQuaternion(frame)
  if (distanceMode === 'physical') return physicalUnits
  const orderIndex = moon.orderIndex ?? 0
  return physicalUnits.clone().normalize().multiplyScalar(explorationMoonDistance(parentRadiusUnits, orderIndex))
}

/** Heliocentric variant of `keplerianMoonOffset` — exploration mode compresses by true
 * AU distance (like the planets) rather than by parent-radius multiples. */
function heliocentricKeplerianOffset(
  body: AtlasEntity,
  date: Date,
  distanceMode: DistanceMode,
): THREE.Vector3 {
  if (!body.elements) return new THREE.Vector3()
  const localKm = keplerianPosition(body.elements, date)
  const frame = parentEquatorialFrame(Body.Sun, date)
  const physicalUnits = new THREE.Vector3(localKm.x, localKm.y, localKm.z)
    .multiplyScalar(1 / 6_371)
    .applyQuaternion(frame)
  if (distanceMode === 'physical') return physicalUnits
  const auDistance = physicalUnits.length() / AU_IN_EARTH_RADII
  if (auDistance < 1e-9) return new THREE.Vector3()
  return physicalUnits.clone().normalize().multiplyScalar(explorationDistanceForAu(auDistance))
}

function jupiterMoonOffset(
  rawAuOffset: { x: number; y: number; z: number },
  orderIndex: number,
  parentRadiusUnits: number,
  distanceMode: DistanceMode,
): THREE.Vector3 {
  const sceneVector = eqjToScene(rawAuOffset)
  if (distanceMode === 'physical') return sceneVector.multiplyScalar(AU_IN_EARTH_RADII)
  const auDistance = sceneVector.length()
  if (auDistance < 1e-12) return new THREE.Vector3()
  return sceneVector.normalize().multiplyScalar(explorationMoonDistance(parentRadiusUnits, orderIndex))
}

export function calculateSolarSystemEphemeris(
  date: Date,
  distanceMode: DistanceMode,
): SolarSystemEphemeris {
  const bodies = new Map<string, BodyState>()

  bodies.set('sun', {
    position: new THREE.Vector3(),
    quaternion: bodyOrientation(Body.Sun, date),
    radiusUnits: displayRadiusUnits(SUN_RADIUS_KM, distanceMode),
  })

  for (const planet of [...PLANETS, ...DWARF_PLANETS]) {
    const body = engineBodyOf(planet)
    if (!body || !planet.radiusKm) continue
    bodies.set(planet.id, {
      position: planetPosition(planet, date, distanceMode),
      quaternion: bodyOrientation(body, date),
      radiusUnits: displayRadiusUnits(planet.radiusKm, distanceMode),
    })
  }

  // Earth's Moon — full-precision geocentric ephemeris, unchanged from the milestone-1 model.
  const moonVectorAu = GeoVector(Body.Moon, date, true)
  const moonDistanceKm = moonVectorAu.Length() * AU_KM
  const moonDirection = eqjToScene(moonVectorAu).normalize()
  const earthState = bodies.get('earth')
  if (earthState) {
    const moonOffsetUnits =
      distanceMode === 'physical'
        ? moonDirection.clone().multiplyScalar(kmToUnits(moonDistanceKm))
        : moonDirection.clone().multiplyScalar(explorationMoonDistance(earthState.radiusUnits, 0))
    bodies.set('moon', {
      position: earthState.position.clone().add(moonOffsetUnits),
      quaternion: bodyOrientation(Body.Moon, date),
      radiusUnits: displayRadiusUnits(1_737.5, distanceMode),
    })
  }

  const sunVectorAu = GeoVector(Body.Sun, date, true)
  const sunDistanceKm = sunVectorAu.Length() * AU_KM

  // Jupiter's four Galilean moons, propagated directly by astronomy-engine.
  const jupiterState = bodies.get('jupiter')
  if (jupiterState) {
    const jupiterMoons = JupiterMoons(date)
    JUPITER_MOON_KEYS.forEach((key, index) => {
      const moon = MOONS.find((entity) => entity.id === key)
      if (!moon?.radiusKm) return
      const raw = jupiterMoons[key]
      const offset = jupiterMoonOffset(raw, index, jupiterState.radiusUnits, distanceMode)
      bodies.set(key, {
        position: jupiterState.position.clone().add(offset),
        quaternion: tidalLockQuaternion(offset),
        radiusUnits: displayRadiusUnits(moon.radiusKm, distanceMode),
      })
    })
  }

  // All other curated moons, propagated with two-body Keplerian elements.
  for (const moon of MOONS) {
    if (MOON_ENGINE_SOURCE[moon.id] !== 'keplerian' || !moon.radiusKm) continue
    const parent = findPlanet(moon.parentId)
    const parentBody = engineBodyOf(parent)
    const parentState = parent ? bodies.get(parent.id) : undefined
    if (!parentBody || !parentState) continue
    const offset = keplerianMoonOffset(moon, parentBody, parentState.radiusUnits, date, distanceMode)
    bodies.set(moon.id, {
      position: parentState.position.clone().add(offset),
      quaternion: tidalLockQuaternion(offset),
      radiusUnits: displayRadiusUnits(moon.radiusKm, distanceMode),
    })
  }

  // Notable named main-belt bodies — heliocentric Keplerian orbits, using the Sun's
  // near-ecliptic rotation pole (~7° from the ecliptic) as the closest available
  // reference frame without a dedicated ecliptic transform.
  const sunState = bodies.get('sun')
  if (sunState) {
    for (const body of NOTABLE_SMALL_BODIES) {
      if (!body.elements || !body.radiusKm) continue
      const offset = heliocentricKeplerianOffset(body, date, distanceMode)
      bodies.set(body.id, {
        position: sunState.position.clone().add(offset),
        quaternion: tidalLockQuaternion(offset),
        radiusUnits: displayRadiusUnits(body.radiusKm, distanceMode),
      })
    }
  }

  return {
    date,
    distanceMode,
    bodies,
    moonDistanceKm,
    sunDistanceKm,
    moonPhaseAngle: MoonPhase(date),
  }
}

/**
 * Frame-rate-accurate offset for a single fast-moving moon, reusing its parent's
 * position from the coarse (≈1 Hz) ephemeris snapshot. Planets barely move within a
 * second, so only the focused moon's own fast local motion needs a fresh sample —
 * this is the "only do it when focused" optimization: continuous, un-throttled
 * updates are reserved for whichever single body the camera is currently tracking.
 */
export function refineFocusedMoonPosition(
  moonId: string,
  date: Date,
  distanceMode: DistanceMode,
  coarse: SolarSystemEphemeris,
): THREE.Vector3 | null {
  if (moonId === 'moon') {
    const earthState = coarse.bodies.get('earth')
    if (!earthState) return null
    const moonVectorAu = GeoVector(Body.Moon, date, true)
    const direction = eqjToScene(moonVectorAu).normalize()
    const offset =
      distanceMode === 'physical'
        ? direction.multiplyScalar(kmToUnits(moonVectorAu.Length() * AU_KM))
        : direction.multiplyScalar(explorationMoonDistance(earthState.radiusUnits, 0))
    return earthState.position.clone().add(offset)
  }

  const jupiterIndex = JUPITER_MOON_KEYS.indexOf(moonId as (typeof JUPITER_MOON_KEYS)[number])
  if (jupiterIndex >= 0) {
    const jupiterState = coarse.bodies.get('jupiter')
    if (!jupiterState) return null
    const raw = JupiterMoons(date)[moonId as (typeof JUPITER_MOON_KEYS)[number]]
    const offset = jupiterMoonOffset(raw, jupiterIndex, jupiterState.radiusUnits, distanceMode)
    return jupiterState.position.clone().add(offset)
  }

  const moon = MOONS.find((entity) => entity.id === moonId)
  if (!moon || MOON_ENGINE_SOURCE[moonId] !== 'keplerian') return null
  const parent = findPlanet(moon.parentId)
  const parentBody = engineBodyOf(parent)
  const parentState = parent ? coarse.bodies.get(parent.id) : undefined
  if (!parentBody || !parentState) return null
  const offset = keplerianMoonOffset(moon, parentBody, parentState.radiusUnits, date, distanceMode)
  return parentState.position.clone().add(offset)
}

export function isRefinableMoon(id: string): boolean {
  return id === 'moon' || MOONS.some((moon) => moon.id === id)
}

/**
 * The body's true heliocentric path, sampled directly from the same `HelioVector`
 * model used for its live position — not an idealized circle. This is what makes
 * eccentric/inclined orbits (Mercury, Pluto) actually pass through the rendered
 * planet instead of a generic reference ring drifting away from it.
 */
export function sampleHeliocentricOrbitPath(
  entity: AtlasEntity,
  referenceDate: Date,
  distanceMode: DistanceMode,
  segments = 180,
): THREE.Vector3[] {
  if (!entity.semiMajorAxisAu || !engineBodyOf(entity)) return []
  const periodDays = 365.25 * entity.semiMajorAxisAu ** 1.5
  const points: THREE.Vector3[] = []
  for (let index = 0; index <= segments; index += 1) {
    const date = new Date(referenceDate.getTime() + (index / segments) * periodDays * 86_400_000)
    points.push(planetPosition(entity, date, distanceMode))
  }
  return points
}

export { moonsOf }
