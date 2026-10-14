import * as THREE from 'three'
import { type FrameId, type Vec3d, convertFrame, cross3d, dot3d, normalize3d, vec3d, worldToSceneBasis } from '../world'

/**
 * Turn an IAU rotation pole and prime-meridian angle into a mesh orientation.
 *
 * Three.js sphere geometry puts its poles on the local +Y axis, and an equirectangular
 * texture's prime meridian lands on local +X. So the body-fixed basis we need is
 * X = prime meridian, Y = rotation pole, Z = X cross Y. Getting this wrong is subtle:
 * the planet still looks like a planet, it just has the wrong face pointing at you and
 * spins about a slightly wrong axis.
 *
 * The previous implementation used `setFromUnitVectors` for tidally locked moons, which
 * fixes only the direction to the parent and leaves roll unconstrained — the result was
 * a wandering north pole on sixteen of the moons. Building a full basis removes that
 * degree of freedom.
 */

const scratchNorth = vec3d()
const scratchNode = vec3d()
const scratchPrime = vec3d()
const scratchEast = vec3d()
const scratchScene = vec3d()
const Z_ICRF: Vec3d = { x: 0, y: 0, z: 1 }

const basisX = new THREE.Vector3()
const basisY = new THREE.Vector3()
const basisZ = new THREE.Vector3()
const basisMatrix = new THREE.Matrix4()

function toScene(out: THREE.Vector3, v: Vec3d, from: FrameId, to: FrameId): THREE.Vector3 {
  convertFrame(scratchScene, v, from, to)
  worldToSceneBasis(scratchScene, scratchScene)
  return out.set(scratchScene.x, scratchScene.y, scratchScene.z).normalize()
}

/** Rotate `v` about the unit axis `axis` by `angle` radians (Rodrigues). */
function rotateAbout(out: Vec3d, v: Vec3d, axis: Vec3d, angle: number): Vec3d {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const d = dot3d(axis, v)
  const cx = axis.y * v.z - axis.z * v.y
  const cy = axis.z * v.x - axis.x * v.z
  const cz = axis.x * v.y - axis.y * v.x
  out.x = v.x * cos + cx * sin + axis.x * d * (1 - cos)
  out.y = v.y * cos + cy * sin + axis.y * d * (1 - cos)
  out.z = v.z * cos + cz * sin + axis.z * d * (1 - cos)
  return out
}

/**
 * Orientation quaternion for a body with a known pole and spin, for a mesh living in a
 * scene whose frame is `targetFrame`.
 *
 * @param north        Rotation pole, in ICRF.
 * @param spinRadians  Prime-meridian angle W, measured about the pole from the node of
 *                     the body equator on the ICRF equator.
 */
export function orientationFromPole(
  out: THREE.Quaternion,
  north: Vec3d,
  spinRadians: number,
  targetFrame: FrameId,
): THREE.Quaternion {
  normalize3d(scratchNorth, north)

  // Ascending node of the body's equator on the ICRF equator.
  cross3d(scratchNode, Z_ICRF, scratchNorth)
  if (Math.hypot(scratchNode.x, scratchNode.y, scratchNode.z) < 1e-9) {
    // Pole parallel to the ICRF pole; any perpendicular will do.
    scratchNode.x = 1
    scratchNode.y = 0
    scratchNode.z = 0
  }
  normalize3d(scratchNode, scratchNode)

  rotateAbout(scratchPrime, scratchNode, scratchNorth, spinRadians)
  normalize3d(scratchPrime, scratchPrime)
  cross3d(scratchEast, scratchNorth, scratchPrime)
  normalize3d(scratchEast, scratchEast)

  toScene(basisX, scratchPrime, 'icrf', targetFrame)
  toScene(basisY, scratchNorth, 'icrf', targetFrame)
  // Z completes a right-handed basis: X cross Y = -east.
  basisZ.copy(basisX).cross(basisY).normalize()

  basisMatrix.makeBasis(basisX, basisY, basisZ)
  return out.setFromRotationMatrix(basisMatrix).normalize()
}

/**
 * Orientation for a tidally locked body: the same face always points at its parent.
 *
 * `toParent` is the direction from the body to its parent; `poleHint` is the orbit
 * normal, which fixes the roll that `toParent` alone leaves free.
 */
export function orientationTidallyLocked(
  out: THREE.Quaternion,
  toParent: Vec3d,
  poleHint: Vec3d,
  frame: FrameId,
): THREE.Quaternion {
  // Local +X faces the parent (equirectangular prime meridian), +Y is the pole.
  normalize3d(scratchPrime, toParent)
  normalize3d(scratchNorth, poleHint)
  // Orthogonalise the pole against the parent direction.
  const d = dot3d(scratchNorth, scratchPrime)
  scratchNorth.x -= scratchPrime.x * d
  scratchNorth.y -= scratchPrime.y * d
  scratchNorth.z -= scratchPrime.z * d
  if (Math.hypot(scratchNorth.x, scratchNorth.y, scratchNorth.z) < 1e-9) {
    scratchNorth.x = 0
    scratchNorth.y = 0
    scratchNorth.z = 1
  }
  normalize3d(scratchNorth, scratchNorth)

  toScene(basisX, scratchPrime, frame, frame)
  toScene(basisY, scratchNorth, frame, frame)
  basisZ.copy(basisX).cross(basisY).normalize()
  basisMatrix.makeBasis(basisX, basisY, basisZ)
  return out.setFromRotationMatrix(basisMatrix).normalize()
}
