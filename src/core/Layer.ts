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
   * Edges are feathered in log space, the same way the span band is, so a layer
   * crossing a band edge dissolves instead of blinking out in one frame.
   *
   * `null` for the anchor-local layers. A band is a statement about distance from a
   * FIXED origin; `system` and `surface` re-origin onto whatever the camera is
   * anchored to, so their camera distance is the arrival distance and carries no
   * information about whether their content belongs. They draw when they are
   * anchored and not otherwise — which is what the engine's anchor clause always
   * did, silently, while a band sat in the config looking as though it meant
   * something.
   */
  bandMetres: [min: number, max: number] | null
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
 * Width of the cross-fade at each end of a distance band, in decades.
 *
 * Matched to the span feather on purpose: the two gates used to disagree about what a
 * boundary is — the span band dissolved over most of a decade while the distance band
 * was a hard step — so a layer whose distance edge was crossed first vanished in a
 * single frame no matter how gently its span was fading.
 */
const BAND_FEATHER_DECADES = 0.45

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
    // The outer edge has to sit beyond anywhere the camera can go, plus the feather.
    // It used to end at 2e4 Mpc (6.17e26 m) while the controller let the camera out to
    // 1e28 m, so the outermost layer in the atlas switched itself off while the user
    // could still zoom out: nothing lies outside this layer to hand over to, so its
    // band must outlast the zoom limit rather than meet it.
    //
    // That removes the cliff; it does NOT make the far end of the zoom range worth
    // looking at, and this comment used to imply it did. Every catalogue this layer
    // draws sits inside ~2.5e25 m of the supergalactic origin, so from 1e28 m the whole
    // of it subtends about 0.3 degrees — measured: cosmic active, 5 draw calls, mean
    // luma 0.00. Making that frame non-blank means clamping the outward zoom to roughly
    // where the content still resolves (AtlasControls.MAX_DISTANCE_METRES), not widening
    // a band. Whatever ceiling is chosen, this band has to stay beyond it.
    bandMetres: [0.1 * MPC_M, 1e29],
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
    bandMetres: null,
    spanBandMetres: [0, 1e12],
    label: 'Planetary system',
  },
  {
    id: 'surface',
    unitMetres: 1e3, // 1 km
    frame: 'icrf',
    order: 0,
    defaultFar: 1e5,
    bandMetres: null,
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
   * Keep this layer drawing regardless of its distance band and view span.
   *
   * The bands answer "is this layer's content relevant at this scale", which is the
   * right question for a layer holding a survey. It is the wrong question for the
   * layer that holds whatever the camera is anchored to: a 1,300 AU black hole is
   * out of every band the atlas has, and is nonetheless the only thing on screen.
   */
  forceActive = false

  /**
   * How strongly this layer belongs at the current view span, 0 to 1.
   *
   * Raw: this is the span band and nothing else. It stays raw because it is one of
   * three inputs the engine composes into a visibility — the others being the distance
   * band and the layer's role in this frame — and a measurement that has already had
   * the other two folded into it cannot be used to decide anything. It is NOT what
   * content should be drawn at; see `renderOpacity`.
   */
  spanOpacity = 1

  /**
   * The opacity modules should actually fade their materials by, 0 to 1.
   *
   * Set by the engine each frame from the span band, the distance band and the layer's
   * role in this frame. It departs from `spanOpacity` in the case that motivated it: a
   * far layer standing in as the BACKDROP because nothing nearer is drawing the sky.
   * Anchored on a star 8.4 kpc out, the Milky Way disc field was well inside the
   * galactic layer's distance band and was nevertheless blanked, because a 5.5e12 m
   * view span is six decades under that layer's span floor — so the one thing that
   * should have been on screen, the sky, was the thing the span band removed. The
   * floor is still right for deciding which rung the ladder is on; it is wrong as a
   * visibility test when there is no nearer rung.
   */
  renderOpacity = 1

  /**
   * Whether this layer is only on screen because nothing nearer was drawing a sky.
   *
   * A module can use it to pick a cheaper LOD: as a backdrop the layer is a wash of
   * light behind the subject, not the subject. One module does — the galaxy module
   * drops the disc field to a tenth of its instances when this is set. Measured at the
   * galactic-centre close-up, which is where the galactic layer actually takes the
   * backdrop role (`galactic:0.35*B`), interleaved on one run at the same camera:
   * 18.6 / 18.9 / 17.6 fps with the LOD against 16.5 / 9.5 / 11.0 without, three draw
   * calls either way, 30,000 instances against 300,000. At M87 the backdrop is the
   * COSMIC layer and nothing reads the flag there, so it changes nothing — this
   * comment used to quote an M87 figure, which sent a reviewer looking for a cosmic
   * LOD that does not exist.
   */
  isBackdrop = false

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

  /**
   * How strongly the camera distance puts this layer in its contributing band, 0 to 1,
   * feathered in log space exactly as the span band is. Zero for the anchor-local
   * layers, which have no band: their distance says nothing about their relevance.
   */
  bandOpacity(): number {
    const band = this.config.bandMetres
    if (!band) return 0
    return bandFade(this.cameraDistanceMetres, band[0], band[1], BAND_FEATHER_DECADES)
  }

  /**
   * Update `spanOpacity` for the current view span, feathered in log space so the
   * boundaries read as a cross-fade rather than a cut.
   */
  updateSpanOpacity(viewSpanMetres: number): number {
    const [min, max] = this.config.spanBandMetres
    this.spanOpacity = bandFade(viewSpanMetres, min, max, SPAN_FEATHER_DECADES)
    return this.spanOpacity
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

/**
 * A band membership in log space, smoothstep-feathered by `decades` at each end.
 *
 * A zero or non-finite edge means "no bound on that side" — the stellar layer really
 * does start at zero distance, and a feather around log10(0) is not a number.
 */
function bandFade(value: number, min: number, max: number, decades: number): number {
  const log = Math.log10(Math.max(value, 1e-6))
  let opacity = 1
  if (min > 0) {
    const logMin = Math.log10(min)
    opacity = Math.min(opacity, smoothstep(logMin - decades, logMin + decades, log))
  }
  if (Number.isFinite(max)) {
    const logMax = Math.log10(max)
    opacity = Math.min(opacity, 1 - smoothstep(logMax - decades, logMax + decades, log))
  }
  return opacity
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}
