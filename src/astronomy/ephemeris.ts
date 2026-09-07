import {
  Body,
  GeoVector,
  MoonPhase,
  RotationAxis,
  type Vector as AstronomyVector,
} from 'astronomy-engine'
import * as THREE from 'three'
import {
  EARTH_RADIUS_KM,
  EXPLORATION_DISTANCE_UNITS,
} from '../data/catalog'
import type { DistanceMode } from '../store/useExplorerStore'

const AU_KM = 149_597_870.7

export interface SceneEphemeris {
  date: Date
  moonPosition: THREE.Vector3
  sunPosition: THREE.Vector3
  sunDirection: THREE.Vector3
  earthQuaternion: THREE.Quaternion
  moonQuaternion: THREE.Quaternion
  sunQuaternion: THREE.Quaternion
  moonDistanceKm: number
  sunDistanceKm: number
  moonPhaseAngle: number
}

function eqjToScene(vector: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(vector.x, vector.z, -vector.y)
}

function axisVectorToScene(vector: AstronomyVector): THREE.Vector3 {
  return eqjToScene(vector).normalize()
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

export function calculateSceneEphemeris(
  date: Date,
  distanceMode: DistanceMode,
): SceneEphemeris {
  const moonVector = GeoVector(Body.Moon, date, true)
  const sunVector = GeoVector(Body.Sun, date, true)
  const moonDistanceKm = moonVector.Length() * AU_KM
  const sunDistanceKm = sunVector.Length() * AU_KM
  const moonDirection = axisVectorToScene(moonVector)
  const sunDirection = axisVectorToScene(sunVector)
  const moonRenderDistance =
    distanceMode === 'physical'
      ? moonDistanceKm / EARTH_RADIUS_KM
      : EXPLORATION_DISTANCE_UNITS
  const sunRenderDistance =
    distanceMode === 'physical'
      ? sunDistanceKm / EARTH_RADIUS_KM
      : moonRenderDistance * 1.25

  return {
    date,
    moonPosition: moonDirection.multiplyScalar(moonRenderDistance),
    // Exploration mode compresses the Sun into the local scene. Physical mode uses
    // the live geocentric distance in the same Earth-radius units as every body.
    sunPosition: sunDirection.clone().multiplyScalar(sunRenderDistance),
    sunDirection,
    earthQuaternion: bodyOrientation(Body.Earth, date),
    moonQuaternion: bodyOrientation(Body.Moon, date),
    sunQuaternion: bodyOrientation(Body.Sun, date),
    moonDistanceKm,
    sunDistanceKm,
    moonPhaseAngle: MoonPhase(date),
  }
}
