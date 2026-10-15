import * as THREE from 'three'
import {
  AU_M,
  KPC_M,
  MPC_M,
  PC_M,
  type FrameId,
  type Vec3d,
  convertFrame,
  distance3d,
  frameRotation,
  length3d,
  sub3d,
  vec3d,
  worldToSceneBasis,
} from './world'

/**
 * A render layer: one Three.js scene with its own unit, origin and camera.
 *
 * The atlas spans roughly thirty orders of magnitude. No single scene can hold that,
 * because float32 vertex attributes carry ~7 significant digits. Instead each layer
 * picks a unit suited to its band — one unit is 1000 km in the `system` layer and
 * 1 Mpc in the `cosmic` layer — and its camera is placed at the world camera position
 * *expressed relative to that layer's own origin*:
 *
 *     localCamera = (cameraWorld - layer.originWorld) / layer.unitMetres
 *
 * That subtraction happens in float64, here, once per frame. Everything downstream of
 * it is a small number. This is the floating origin, and it is why the GPU never sees
 * a coordinate it cannot represent.
 *
 * Three.js then gets camera-relative object positions for free: it computes
 * `modelViewMatrix = matrixWorldInverse * matrixWorld` on the CPU in JS doubles and
 * downcasts only the product. So object origins may be large; vertex buffers may not.
 * Every geometry must keep its coordinates within ~1e4 of its own object origin.
 */
export type LayerId = 'cosmic' | 'galactic' | 'stellar' | 'helio' | 'system' | 'surface'

export interface LayerConfig {
  id: LayerId
  /** How many metres one render unit represents in this layer. */
  unitMetres: number
  /** Orientation of this layer's axes. */
  frame: FrameId
  /**
   * Render order. Layers are drawn from the LARGEST order first (farthest content) to
   * the smallest, with the depth buffer cleared between passes and colour preserved,
   * so near layers composite over far ones.
   */
  order: number
  /** Far plane used when the camera sits near this layer's origin. */
  defaultFar: number
  /**
   * The camera-distance band, in metres from this layer's origin, within which the
   * layer contributes. Outside it the layer is skipped entirely — zero draw calls.
   */
  bandMetres: [min: number, max: number]
  /**
   * The VIEW SPAN range, in metres, over which this layer contributes.
   *
   * Distance from the origin is not enough on its own. Standing in the solar system,
   * the camera is 8.15 kpc from the galactic centre — comfortably inside the galactic
   * layer's distance band — so the Milky Way's disc field, the deep-sky shell and the
   * cosmic web all drew themselves over a seven-AU view of the inner planets. What
   * actually decides whether a structure belongs on screen is how wide the view is,
   * which is the same quantity the scale ladder tracks.
   *
   * Edges are feathered in log space, so layers cross-fade rather than pop.
   */
  spanBandMetres: [min: number, max: number]
  /** Human-readable, for the stats overlay and `?layers=` debugging. */
  label: string
}

/** Width of the cross-fade at each end of a span band, in decades. */
const SPAN_FEATHER_DECADES = 0.45

/**
 * The six layers. Bands overlap deliberately: at any moment two or three are active,
 * which is what makes a transition a crossfade rather than a cut.
 */
export const LAYER_CONFIGS: readonly LayerConfig[] = [
  {
    id: 'cosmic',
    unitMetres: MPC_M,
    frame: 'supergalactic',
    order: 50,
    defaultFar: 5e4,
    bandMetres: [0.1 * MPC_M, 2e4 * MPC_M],
    spanBandMetres: [3e21, 1e29],
    label: 'Cosmic',
  },
  {
    id: 'galactic',
    unitMetres: KPC_M,
    frame: 'galactic',
    order: 40,
    defaultFar: 5e3,
    bandMetres: [0.05 * KPC_M, 1e3 * KPC_M],
    spanBandMetres: [2e17, 5e23],
    label: 'Galactic',
  },
  {
    id: 'stellar',
    unitMetres: PC_M,
    frame: 'icrf',
    order: 30,
    defaultFar: 1e4,
    // Lower bound is zero, not 0.1 pc: the star field is the sky, and the sky is
    // visible from inside the solar system too. Every other layer has a real floor.
    bandMetres: [0, 3e3 * PC_M],
    spanBandMetres: [0, 1e22],
    label: 'Stellar',
  },
  {
    id: 'helio',
    unitMetres: AU_M,
    frame: 'ecliptic',
    order: 20,
    defaultFar: 1e5,
    bandMetres: [1e-6 * AU_M, 2e5 * AU_M],
    spanBandMetres: [0, 6e14],
    label: 'Heliocentric',
  },
  {
    id: 'system',
    unitMetres: 1e6, // 1000 km
    frame: 'icrf',
    order: 10,
    defaultFar: 1e6,
    bandMetres: [1e4, 1e11],
    spanBandMetres: [0, 1e12],
    label: 'Planetary system',
  },
  {
    id: 'surface',
    unitMetres: 1e3, // 1 km
    frame: 'icrf',
    order: 0,
    defaultFar: 1e5,
    bandMetres: [1, 1e8],
    spanBandMetres: [0, 1e9],
    label: 'Surface',
  },
] as const

/**
 * Near and far are derived from the camera's distance to the layer's origin.
 *
 * A note on the depth buffer, because this is the one place the implementation departs
 * from the overhaul plan. The plan called for dropping `logarithmicDepthBuffer`, on the
 * grounds that multi-pass layering makes it unnecessary. Layering does solve the problem
 * the plan cared most about — POSITION precision — and that is why it is here. It does
 * not solve DEPTH precision *within* a layer, and the solar system is the hard case:
 * hovering 1500 km above Earth while the Moon is still in the same pass needs a near/far
 * ratio around 1e7, well past what a 24-bit buffer holds without z-fighting on terrain.
 * Splitting a planet and its moons into separate passes to dodge that would mean drawing
 * bodies twice and hiding one copy, which is worse.
 *
 * Log depth costs early-Z rejection, which bites when a scene is fragment-bound. This
 * one is not: a few hundred draw calls of small spheres and additive points. The flag
 * stays, and the stats overlay reports frame time so the assumption stays falsifiable.
 */
const NEAR_RATIO = 1e-6
const FAR_RATIO = 100
const MIN_NEAR = 1e-9

export class Layer {
  readonly id: LayerId
  readonly config: LayerConfig
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera

  /** Float64 world position of this layer's origin, in metres, in `config.frame`. */
  readonly originWorld: Vec3d

  /** The id of the body this layer is currently anchored to, if any. */
  anchorId: string | null = null

  /** Set each frame by `rebase`. Distance from camera to this layer's origin, in metres. */
  cameraDistanceMetres = 0

  /** Whether this layer contributed to the last frame. */
  active = false

  /**
   * How strongly this layer belongs at the current view span, 0 to 1.
   * Modules read it to cross-fade their own materials; the engine skips the layer
   * entirely once it reaches zero.
   */
  spanOpacity = 1

  private readonly scratch = vec3d()
  private readonly scratchFrame = vec3d()

  constructor(config: LayerConfig) {
    this.id = config.id
    this.config = config
    this.originWorld = vec3d()
    this.scene = new THREE.Scene()
    this.scene.matrixWorldAutoUpdate = true
    this.camera = new THREE.PerspectiveCamera(50, 1, 1e-6, config.defaultFar)
    // Each layer owns its camera but they all share one pose; `rebase` writes it.
    this.camera.matrixAutoUpdate = true
  }

  /**
   * Move this layer's origin to a new world point. Used when focus changes — the
   * `system` and `surface` layers re-anchor to whichever body the camera is visiting.
   */
  setOrigin(worldPosition: Vec3d, frame: FrameId, anchorId: string | null): void {
    convertFrame(this.originWorld, worldPosition, frame, this.config.frame)
    this.anchorId = anchorId
  }

  /** Convert a world position (in `frame`) into this layer's local render units and basis. */
  toLocal(out: THREE.Vector3, worldPosition: Vec3d, frame: FrameId): THREE.Vector3 {
    convertFrame(this.scratchFrame, worldPosition, frame, this.config.frame)
    sub3d(this.scratch, this.scratchFrame, this.originWorld)
    worldToSceneBasis(this.scratch, this.scratch)
    const k = 1 / this.config.unitMetres
    return out.set(this.scratch.x * k, this.scratch.y * k, this.scratch.z * k)
  }

  /** Convert a length in metres into this layer's render units. */
  toLocalLength(metres: number): number {
    return metres / this.config.unitMetres
  }

  /** Convert a position in this layer's local render units back to world metres. */
  toWorld(out: Vec3d, local: THREE.Vector3): Vec3d {
    const u = this.config.unitMetres
    // Undo the Y-up scene basis: world.x = scene.x, world.y = -scene.z, world.z = scene.y
    out.x = local.x * u + this.originWorld.x
    out.y = -local.z * u + this.originWorld.y
    out.z = local.y * u + this.originWorld.z
    return out
  }

  /**
   * Place this layer's camera for the current frame.
   *
   * `cameraWorld` and `targetWorld` arrive in `frame`; both are converted into this
   * layer's frame and origin in float64 before anything is written to the camera.
   */
  rebase(
    cameraWorld: Vec3d,
    frame: FrameId,
    quaternion: THREE.Quaternion,
    fovDegrees: number,
    aspect: number,
    nearHintMetres = Infinity,
  ): void {
    convertFrame(this.scratchFrame, cameraWorld, frame, this.config.frame)
    this.cameraDistanceMetres = distance3d(this.scratchFrame, this.originWorld)

    sub3d(this.scratch, this.scratchFrame, this.originWorld)
    worldToSceneBasis(this.scratch, this.scratch)
    const k = 1 / this.config.unitMetres
    this.camera.position.set(this.scratch.x * k, this.scratch.y * k, this.scratch.z * k)

    // Orientation is shared across layers, but each layer's axes may be rotated
    // relative to the others, so the shared pose is expressed in the layer's frame.
    this.camera.quaternion.copy(quaternion)
    if (this.config.frame !== frame) {
      this.camera.quaternion.premultiply(sceneQuaternionBetween(frame, this.config.frame))
    }

    const d = length3d(this.scratch) * k

    // The near plane follows the NEAREST THING WORTH SEEING, not the distance to this
    // layer's origin.
    //
    // Deriving it from the origin alone is correct only when the camera is near that
    // origin. Fly to Pluto and the helio layer's origin is still the Sun, 35 AU away,
    // so `d * NEAR_RATIO` put the near plane at 3.6e-5 units while Pluto's whole
    // radius is 7.9e-6 units and the camera sat 3.3e-5 units from its centre: the
    // planet was entirely inside the near plane and vanished. The same arithmetic
    // broke every outer-system body and their moons.
    //
    // `nearHintMetres` is the camera's altitude above the anchor's surface, so the
    // near plane stays a comfortable fraction of whatever is actually in front of us.
    const hintUnits = nearHintMetres === Infinity ? Infinity : (nearHintMetres / this.config.unitMetres) * 0.25
    this.camera.near = Math.max(MIN_NEAR, Math.min(d * NEAR_RATIO, hintUnits))
    this.camera.far = Math.max(this.config.defaultFar, d * FAR_RATIO)
    this.camera.fov = fovDegrees
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld()
  }

  /** Whether the camera distance puts this layer in its contributing band. */
  inBand(): boolean {
    const [min, max] = this.config.bandMetres
    return this.cameraDistanceMetres >= min && this.cameraDistanceMetres <= max
  }

  /**
   * Update `spanOpacity` for the current view span, feathered in log space so the
   * boundaries read as a cross-fade rather than a cut.
   */
  updateSpanOpacity(viewSpanMetres: number): number {
    const [min, max] = this.config.spanBandMetres
    const logSpan = Math.log10(Math.max(viewSpanMetres, 1e-6))
    let opacity = 1
    if (min > 0) {
      const logMin = Math.log10(min)
      opacity = Math.min(opacity, smoothstep(logMin - SPAN_FEATHER_DECADES, logMin + SPAN_FEATHER_DECADES, logSpan))
    }
    if (Number.isFinite(max)) {
      const logMax = Math.log10(max)
      opacity = Math.min(
        opacity,
        1 - smoothstep(logMax - SPAN_FEATHER_DECADES, logMax + SPAN_FEATHER_DECADES, logSpan),
      )
    }
    this.spanOpacity = opacity
    return opacity
  }

  dispose(): void {
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      mesh.geometry?.dispose?.()
      const material = mesh.material
      if (Array.isArray(material)) material.forEach((m) => m.dispose())
      else material?.dispose?.()
    })
    this.scene.clear()
  }
}

// ---------------------------------------------------------------------------
// Frame-to-frame orientation, expressed in the Y-up scene basis
// ---------------------------------------------------------------------------

const quaternionCache = new Map<string, THREE.Quaternion>()

/**
 * The rotation that reorients the shared camera pose from one layer's frame into
 * another's, expressed in the Y-up scene basis the renderer uses.
 *
 * Derived by conjugating the Z-up frame rotation with the basis swap, rather than by
 * hand-writing a second set of matrices — there is exactly one definition of each
 * frame and it lives in `world.ts`.
 */
export function sceneQuaternionBetween(from: FrameId, to: FrameId): THREE.Quaternion {
  const key = `${from}>${to}`
  const hit = quaternionCache.get(key)
  if (hit) return hit

  const m = frameRotation(from, to)

  // Conjugate the Z-up frame rotation by the basis swap: S * M * S^-1, where S is the
  // (x, y, z) -> (x, z, -y) permutation that `worldToSceneBasis` applies.
  const swap = new THREE.Matrix3().set(1, 0, 0, 0, 0, 1, 0, -1, 0)
  const swapInverse = swap.clone().transpose()
  const rot = new THREE.Matrix3().set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8])
  const sceneRotation = swap.clone().multiply(rot).multiply(swapInverse)

  const e = sceneRotation.elements
  const m4 = new THREE.Matrix4().set(e[0], e[3], e[6], 0, e[1], e[4], e[7], 0, e[2], e[5], e[8], 0, 0, 0, 0, 1)
  const q = new THREE.Quaternion().setFromRotationMatrix(m4).normalize()
  quaternionCache.set(key, q)
  return q
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}
