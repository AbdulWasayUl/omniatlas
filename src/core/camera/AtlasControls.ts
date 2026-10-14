import * as THREE from 'three'
import {
  type FrameId,
  type Vec3d,
  addScaled3d,
  convertFrame,
  copy3d,
  length3d,
  normalize3d,
  sphericalToCartesian,
  vec3d,
  worldToSceneBasis,
} from '../world'

/**
 * The camera controller.
 *
 * Replaces drei's `OrbitControls`, which cannot work here for three reasons: it stores
 * its target as a float32 `Vector3`, it clamps distance with `minDistance`/`maxDistance`,
 * and its zoom is additive. The atlas needs float64 anchoring, no outward bound at all,
 * and multiplicative zoom — the only kind that behaves the same at a crater and at a
 * supercluster.
 *
 * ## Zoom is in altitude, not distance
 *
 * Scrolling scales the camera's *altitude above the anchor's surface*, not its distance
 * from the anchor's centre. Two things follow for free. Approaching a body decelerates
 * naturally as the surface nears, so the final descent to a crater feels like landing
 * rather than like hitting a wall. And the camera can never enter the body, because
 * multiplying a positive altitude by a positive factor never reaches zero — no clamp
 * needed. A hard `minDistance` produces a dead scroll wheel, which users read as a bug;
 * an asymptote reads as physics.
 *
 * Outward there is no limit whatsoever.
 */

const DEG = Math.PI / 180

/** Per-notch zoom factor. Shift multiplies travel for long hauls. */
const ZOOM_PER_NOTCH = 1.15
const ZOOM_PER_NOTCH_FAST = 2.0

/** Pitch is clamped just short of the poles to keep the up vector well defined. */
const MAX_PITCH = 89.9 * DEG

/** Smallest altitude the camera may hold above a body, as a fraction of its radius. */
const MIN_ALTITUDE_FRACTION = 1e-4

/** Largest distance the camera may hold, in metres. Beyond the observable universe. */
const MAX_DISTANCE_METRES = 1e28

export interface AtlasControlsOptions {
  domElement: HTMLElement
  /** The frame the controller's world positions are expressed in. */
  frame?: FrameId
}

export interface FlyTarget {
  /** World position of the object to frame, in the controller's frame. */
  anchorWorld: Vec3d
  /** Mean radius in metres; 0 for point-like objects. */
  radiusMetres: number
  /** Where to end up, as a distance from the anchor's centre in metres. */
  distanceMetres: number
  anchorId: string | null
}

/**
 * van Wijk and Nuij's "Smooth and efficient zooming and panning" (IEEE InfoVis 2003).
 *
 * Interpolating position linearly between two viewpoints separated by many orders of
 * magnitude spends almost the whole flight apparently motionless and then covers
 * everything in the last instant. This parameterisation holds *perceived optical flow*
 * constant instead, so Earth-to-Moon and Earth-to-Andromeda both feel like one
 * comfortable move. rho = sqrt(2) is the value their user study preferred.
 */
const RHO = Math.SQRT2

interface ZoomPath {
  /** Total path length in the parameterisation. */
  S: number
  /** Evaluate at s in [0, S]: returns {u, w} — distance along the line, and width (scale). */
  at(s: number): { u: number; w: number }
}

export function planZoomPath(u0: number, w0: number, u1: number, w1: number): ZoomPath {
  const rho2 = RHO * RHO
  const du = u1 - u0

  // Degenerate case: pure zoom with no lateral travel.
  if (Math.abs(du) < 1e-9 * Math.max(w0, w1)) {
    const k = w1 > w0 ? 1 : -1
    const S = Math.abs(Math.log(w1 / w0)) / RHO
    return {
      S,
      at(s: number) {
        return { u: u0, w: w0 * Math.exp(k * RHO * s) }
      },
    }
  }

  const b = (i: number) => {
    const w = i === 0 ? w0 : w1
    const sign = i === 0 ? 1 : -1
    return (w1 * w1 - w0 * w0 + sign * rho2 * rho2 * du * du) / (2 * w * rho2 * du)
  }
  const r = (i: number) => Math.log(-b(i) + Math.sqrt(b(i) * b(i) + 1))
  const r0 = r(0)
  const r1 = r(1)
  const S = (r1 - r0) / RHO

  return {
    S: Math.abs(S) < 1e-12 ? 1e-12 : S,
    at(s: number) {
      const t = RHO * s + r0
      const coshr0 = Math.cosh(r0)
      const u = (w0 / (rho2 * 1)) * (coshr0 * Math.tanh(t) - Math.sinh(r0)) + u0
      const w = (w0 * coshr0) / Math.cosh(t)
      return { u, w }
    },
  }
}

interface Flight {
  fromAnchor: Vec3d
  toAnchor: Vec3d
  fromDistance: number
  toDistance: number
  fromYaw: number
  toYaw: number
  fromPitch: number
  toPitch: number
  path: ZoomPath
  elapsed: number
  duration: number
  anchorId: string | null
  radiusMetres: number
}

export class AtlasControls {
  readonly frame: FrameId

  /** The point the camera orbits, in world metres. Float64. */
  readonly anchorWorld: Vec3d = vec3d()
  /** Radius of the anchored body in metres; drives the altitude-based zoom. */
  anchorRadiusMetres = 0
  anchorId: string | null = null

  /** Distance from the anchor's centre, in metres. */
  distanceMetres = 3e9

  /** Orbit angles about the anchor, in radians, in the controller's frame. */
  yaw = 0.6
  pitch = 0.32

  /** Blended reference up vector in world coordinates. */
  readonly referenceUp: Vec3d = vec3d(0, 0, 1)

  /** Outputs, read by the engine each frame. */
  readonly cameraWorld: Vec3d = vec3d()
  readonly quaternion = new THREE.Quaternion()

  enabled = true
  /** Multiplier on orbit sensitivity. */
  rotateSpeed = 1
  /** Exponential damping half-life in seconds. Lower is snappier. */
  damping = 0.09

  private readonly domElement: HTMLElement
  private targetYaw = 0.6
  private targetPitch = 0.32
  private targetDistance = 3e9

  private dragging: 'orbit' | null = null
  private lastPointer = { x: 0, y: 0 }
  private activePointer: number | null = null
  private flight: Flight | null = null

  private readonly scratch = vec3d()
  private readonly scratchDir = vec3d()
  private readonly eye = new THREE.Vector3()
  private readonly up = new THREE.Vector3(0, 1, 0)
  private readonly lookMatrix = new THREE.Matrix4()
  private readonly origin = new THREE.Vector3()

  onChange: (() => void) | null = null

  constructor(options: AtlasControlsOptions) {
    this.frame = options.frame ?? 'ecliptic'
    this.domElement = options.domElement
    this.attach()
    this.update(0)
  }

  // -------------------------------------------------------------------------
  // Anchoring
  // -------------------------------------------------------------------------

  /**
   * Point the controller at a new anchor without moving the camera. Used by
   * select-and-scroll: clicking a distant object hands focus over, and the next scroll
   * carries you to it, rather than teleporting on click.
   */
  setAnchor(worldPosition: Vec3d, frame: FrameId, radiusMetres: number, id: string | null): void {
    convertFrame(this.anchorWorld, worldPosition, frame, this.frame)
    this.anchorRadiusMetres = radiusMetres
    this.anchorId = id
  }

  /** Keep the anchor glued to a moving body, preserving the orbit pose. */
  trackAnchor(worldPosition: Vec3d, frame: FrameId): void {
    convertFrame(this.anchorWorld, worldPosition, frame, this.frame)
  }

  // -------------------------------------------------------------------------
  // Zoom
  // -------------------------------------------------------------------------

  /** Altitude above the anchor's surface, in metres. Always positive. */
  get altitudeMetres(): number {
    return Math.max(this.targetDistance - this.anchorRadiusMetres, this.minAltitude())
  }

  private minAltitude(): number {
    return Math.max(this.anchorRadiusMetres * MIN_ALTITUDE_FRACTION, 1)
  }

  /**
   * Scale the altitude by `factor`. Greater than one zooms out.
   * Never clamps inward — the asymptote does that job.
   */
  zoomBy(factor: number): void {
    const altitude = Math.max(this.targetDistance - this.anchorRadiusMetres, this.minAltitude())
    const next = Math.max(altitude * factor, this.minAltitude())
    this.targetDistance = Math.min(this.anchorRadiusMetres + next, MAX_DISTANCE_METRES)
    this.flight = null
  }

  /** Jump straight to a distance from the anchor centre, in metres. */
  setDistance(metres: number): void {
    this.targetDistance = THREE.MathUtils.clamp(
      metres,
      this.anchorRadiusMetres + this.minAltitude(),
      MAX_DISTANCE_METRES,
    )
  }

  // -------------------------------------------------------------------------
  // Flight
  // -------------------------------------------------------------------------

  flyTo(target: FlyTarget, options: { instant?: boolean } = {}): void {
    const toAnchor = vec3d()
    copy3d(toAnchor, target.anchorWorld)

    const toDistance = Math.max(target.distanceMetres, target.radiusMetres * (1 + MIN_ALTITUDE_FRACTION))

    if (options.instant) {
      copy3d(this.anchorWorld, toAnchor)
      this.anchorRadiusMetres = target.radiusMetres
      this.anchorId = target.anchorId
      this.targetDistance = toDistance
      this.distanceMetres = toDistance
      this.flight = null
      this.update(0)
      return
    }

    // Travel distance between the two anchors, measured in the frame we fly through.
    const travel = Math.hypot(
      toAnchor.x - this.anchorWorld.x,
      toAnchor.y - this.anchorWorld.y,
      toAnchor.z - this.anchorWorld.z,
    )
    const path = planZoomPath(0, this.distanceMetres, travel, toDistance)

    const ratio = Math.max(this.distanceMetres, toDistance) / Math.max(1, Math.min(this.distanceMetres, toDistance))
    const duration = THREE.MathUtils.clamp(420 * Math.log10(Math.max(ratio, 1.0001)) + 700, 900, 2600) / 1000

    this.flight = {
      fromAnchor: vec3d(this.anchorWorld.x, this.anchorWorld.y, this.anchorWorld.z),
      toAnchor,
      fromDistance: this.distanceMetres,
      toDistance,
      fromYaw: this.yaw,
      toYaw: this.targetYaw,
      fromPitch: this.pitch,
      toPitch: this.targetPitch,
      path,
      elapsed: 0,
      duration,
      anchorId: target.anchorId,
      radiusMetres: target.radiusMetres,
    }
  }

  get flying(): boolean {
    return this.flight !== null
  }

  cancelFlight(): void {
    this.flight = null
  }

  // -------------------------------------------------------------------------
  // Reference up
  // -------------------------------------------------------------------------

  /**
   * Set the up direction the camera rolls toward, in world coordinates.
   *
   * At planetary scale that is the body's pole; at stellar scale the ecliptic pole; at
   * galactic scale the galactic pole. Blending rather than switching means the horizon
   * never flips when a frame boundary is crossed.
   */
  setReferenceUp(up: Vec3d, blend = 1): void {
    const target = normalize3d(this.scratch, up)
    if (blend >= 1) {
      copy3d(this.referenceUp, target)
    } else {
      addScaled3d(this.referenceUp, this.referenceUp, target, blend)
      normalize3d(this.referenceUp, this.referenceUp)
    }
    if (length3d(this.referenceUp) < 1e-9) copy3d(this.referenceUp, { x: 0, y: 0, z: 1 })
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  update(delta: number): void {
    if (this.flight) {
      this.advanceFlight(delta)
    } else {
      // Exponential smoothing, framerate-independent.
      const k = delta > 0 ? 1 - Math.exp(-delta / Math.max(this.damping, 1e-4)) : 1
      this.yaw += (this.targetYaw - this.yaw) * k
      this.pitch += (this.targetPitch - this.pitch) * k
      // Distance is smoothed in LOG space: a linear lerp from 1 AU to 1 Mpc would
      // spend the entire animation at cosmic scale and arrive in a single frame.
      const logCurrent = Math.log(Math.max(this.distanceMetres, 1e-6))
      const logTarget = Math.log(Math.max(this.targetDistance, 1e-6))
      this.distanceMetres = Math.exp(logCurrent + (logTarget - logCurrent) * k)
    }

    this.recomputePose()
    this.onChange?.()
  }

  private advanceFlight(delta: number): void {
    const flight = this.flight!
    flight.elapsed += delta
    const t = Math.min(flight.elapsed / flight.duration, 1)
    // Ease the parameterisation itself, not the position, so optical flow stays even.
    const eased = t * t * (3 - 2 * t)
    const { u, w } = flight.path.at(eased * flight.path.S)

    const travel = Math.hypot(
      flight.toAnchor.x - flight.fromAnchor.x,
      flight.toAnchor.y - flight.fromAnchor.y,
      flight.toAnchor.z - flight.fromAnchor.z,
    )
    const fraction = travel > 0 ? THREE.MathUtils.clamp(u / travel, 0, 1) : 1

    this.anchorWorld.x = flight.fromAnchor.x + (flight.toAnchor.x - flight.fromAnchor.x) * fraction
    this.anchorWorld.y = flight.fromAnchor.y + (flight.toAnchor.y - flight.fromAnchor.y) * fraction
    this.anchorWorld.z = flight.fromAnchor.z + (flight.toAnchor.z - flight.fromAnchor.z) * fraction

    this.distanceMetres = Math.max(w, 1)
    this.yaw = flight.fromYaw + (flight.toYaw - flight.fromYaw) * eased
    this.pitch = flight.fromPitch + (flight.toPitch - flight.fromPitch) * eased

    if (t >= 1) {
      copy3d(this.anchorWorld, flight.toAnchor)
      this.anchorRadiusMetres = flight.radiusMetres
      this.anchorId = flight.anchorId
      this.distanceMetres = flight.toDistance
      this.targetDistance = flight.toDistance
      this.flight = null
    }
  }

  /** Derive the camera world position and orientation from the orbit state. */
  private recomputePose(): void {
    const cosPitch = Math.cos(this.pitch)
    this.scratchDir.x = cosPitch * Math.cos(this.yaw)
    this.scratchDir.y = cosPitch * Math.sin(this.yaw)
    this.scratchDir.z = Math.sin(this.pitch)

    addScaled3d(this.cameraWorld, this.anchorWorld, this.scratchDir, this.distanceMetres)

    // Orientation: look from the offset back at the anchor, in the Y-up scene basis.
    worldToSceneBasis(this.scratch, this.scratchDir)
    this.eye.set(this.scratch.x, this.scratch.y, this.scratch.z)
    worldToSceneBasis(this.scratch, this.referenceUp)
    this.up.set(this.scratch.x, this.scratch.y, this.scratch.z)
    // Guard the degenerate case where the view direction is parallel to up.
    if (Math.abs(this.eye.dot(this.up)) > 0.9999) this.up.set(0, 0, 1)

    this.lookMatrix.lookAt(this.eye, this.origin, this.up)
    this.quaternion.setFromRotationMatrix(this.lookMatrix)
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private attach(): void {
    const el = this.domElement
    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('pointermove', this.onPointerMove)
    el.addEventListener('pointerup', this.onPointerUp)
    el.addEventListener('pointercancel', this.onPointerUp)
    el.addEventListener('wheel', this.onWheel, { passive: false })
    el.addEventListener('contextmenu', this.onContextMenu)
  }

  dispose(): void {
    const el = this.domElement
    el.removeEventListener('pointerdown', this.onPointerDown)
    el.removeEventListener('pointermove', this.onPointerMove)
    el.removeEventListener('pointerup', this.onPointerUp)
    el.removeEventListener('pointercancel', this.onPointerUp)
    el.removeEventListener('wheel', this.onWheel)
    el.removeEventListener('contextmenu', this.onContextMenu)
  }

  private onContextMenu = (event: Event) => event.preventDefault()

  private onPointerDown = (event: PointerEvent) => {
    if (!this.enabled || this.activePointer !== null) return
    this.activePointer = event.pointerId
    this.dragging = 'orbit'
    this.lastPointer.x = event.clientX
    this.lastPointer.y = event.clientY
    this.domElement.setPointerCapture?.(event.pointerId)
  }

  private onPointerMove = (event: PointerEvent) => {
    if (!this.enabled || this.dragging !== 'orbit' || event.pointerId !== this.activePointer) return
    const dx = event.clientX - this.lastPointer.x
    const dy = event.clientY - this.lastPointer.y
    this.lastPointer.x = event.clientX
    this.lastPointer.y = event.clientY

    const scale = (this.rotateSpeed * Math.PI) / Math.max(this.domElement.clientHeight, 1)
    this.targetYaw -= dx * scale
    this.targetPitch = THREE.MathUtils.clamp(this.targetPitch + dy * scale, -MAX_PITCH, MAX_PITCH)
    this.flight = null
  }

  private onPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.activePointer) return
    this.dragging = null
    this.activePointer = null
    this.domElement.releasePointerCapture?.(event.pointerId)
  }

  /**
   * Wheel handling.
   *
   * `WheelEvent.deltaMode` is not comparable across browsers: 0 is pixels, 1 is lines,
   * 2 is pages, and the pixel-per-notch value differs by roughly 16x between a Windows
   * mouse and a macOS trackpad. Normalising to notches explicitly is the difference
   * between a camera that feels identical everywhere and one that flies 16x too fast on
   * half the machines in the world.
   */
  private onWheel = (event: WheelEvent) => {
    if (!this.enabled) return
    event.preventDefault()

    let notches: number
    switch (event.deltaMode) {
      case 1: // lines
        notches = event.deltaY / 3
        break
      case 2: // pages
        notches = event.deltaY
        break
      default: // pixels
        notches = event.deltaY / 100
        break
    }
    // A trackpad emits many small deltas; cap any single event so a flick cannot
    // teleport the camera across ten orders of magnitude.
    notches = THREE.MathUtils.clamp(notches, -4, 4)

    const base = event.shiftKey ? ZOOM_PER_NOTCH_FAST : ZOOM_PER_NOTCH
    this.zoomBy(base ** notches)
  }

  /** Orbit by screen-space deltas, for keyboard and programmatic control. */
  orbitBy(deltaYaw: number, deltaPitch: number): void {
    this.targetYaw += deltaYaw
    this.targetPitch = THREE.MathUtils.clamp(this.targetPitch + deltaPitch, -MAX_PITCH, MAX_PITCH)
    this.flight = null
  }

  /** Point the camera from a given direction without changing distance. */
  setOrbit(yaw: number, pitch: number, instant = false): void {
    this.targetYaw = yaw
    this.targetPitch = THREE.MathUtils.clamp(pitch, -MAX_PITCH, MAX_PITCH)
    if (instant) {
      this.yaw = this.targetYaw
      this.pitch = this.targetPitch
    }
  }
}

/** Unit direction from spherical angles, for callers that want to preset an orbit. */
export function orbitDirection(yawDeg: number, pitchDeg: number): Vec3d {
  return sphericalToCartesian(vec3d(), yawDeg, pitchDeg, 1)
}
