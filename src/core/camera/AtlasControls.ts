import * as THREE from 'three'
import {
  type FrameId,
  type Vec3d,
  addScaled3d,
  convertFrame,
  copy3d,
  distance3d,
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
 * Outward there is one limit, and it is set by the data rather than by the geometry:
 * see MAX_DISTANCE_METRES.
 */

const DEG = Math.PI / 180

/** Per-notch zoom factor. Shift multiplies travel for long hauls. */
const ZOOM_PER_NOTCH = 1.15
const ZOOM_PER_NOTCH_FAST = 2.0

/** Pitch is clamped just short of the poles to keep the up vector well defined. */
const MAX_PITCH = 89.9 * DEG

/** Smallest altitude the camera may hold above a body, as a fraction of its radius. */
const MIN_ALTITUDE_FRACTION = 1e-4

/** Clean up a radius or a distance that arrived non-finite; see flyTo. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/**
 * Largest distance the camera may hold, in metres.
 *
 * Not "beyond the observable universe" — the ceiling has to sit where the *drawn*
 * universe stops being resolvable, and the outermost catalogue (CF4/2MRS) only reaches
 * ~770 Mpc = 2.4e25 m.
 *
 * Measured by stepping the camera out from the Sun along one fixed direction in a
 * 1384 x 805 frame and COUNTING the pixels above luma 12 — not their bounding box,
 * which says "full frame" at every rung because the cosmos layer pins a faint
 * deep-field illustration to the camera that never changes with distance:
 *
 *     1e25  389,950 px  mean luma 29.21      1e27   5,227 px  mean 0.29
 *     3e25  146,035 px            14.34      1e28   4,910 px  mean 0.27
 *     1e26   40,049 px             4.02
 *     3e26    9,749 px             0.73
 *
 * The last two rungs are that illustration and nothing else: a whole decade of wheel
 * between 1e27 and 1e28 changes 6% of the lit pixels and 0.02 of a luma level. The
 * catalogue blob itself is ~230 px across at 1e26 with individual groups still
 * separable and the filaments still reading as filaments, and an ~85 px fuzzy dot by
 * 3e26. 1e26 m is the last rung that shows structure, so that is where the wheel stops.
 */
const MAX_DISTANCE_METRES = 1e26

export interface AtlasControlsOptions {
  domElement: HTMLElement
  /** The frame the controller's world positions are expressed in. */
  frame?: FrameId
}

export interface FlyTarget {
  /** World position of the object to frame, stated in `frame`. */
  anchorWorld: Vec3d
  /**
   * The frame `anchorWorld` is stated in. Required, because most of the registry is
   * not in the controller's frame: a flight that lerped an ICRF or galactic position
   * straight into an ecliptic anchor travelled to the wrong point the whole way and
   * then snapped the background by the full frame-conversion error on arrival.
   */
  frame: FrameId
  /** Mean radius in metres; 0 for point-like objects. */
  radiusMetres: number
  /** Equatorial over mean radius for a flattened body; see `anchorShapeRatio`. */
  shapeRatio?: number
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
  // asinh, not its log-and-sqrt expansion. van Wijk writes r(i) = ln(-b + sqrt(b^2 + 1)),
  // which cancels catastrophically: once |b| >= 2^26.5 (~9.5e7), b*b + 1 === b*b and
  // sqrt(b*b) === |b| exactly, so the subtraction returns 0 and the log returns -Infinity.
  // S becomes Infinity and at() returns NaN for the whole flight. The loss is gradual well
  // before that — a 1e7 distance ratio already lands 0.58% off, 3.16e7 is 6% long — so the
  // Kuiper belt silently overshot and arrived with a jerk while Andromeda rendered nothing
  // at all. Math.asinh(-b) is the same function, evaluated without the cancellation.
  const r = (i: number) => Math.asinh(-b(i))
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
  shapeRatio: number
  /**
   * The anchor the flight LEFT. An interrupt in the first half of a flight has to put
   * the camera back on this one: it is the body the camera is still next to, and the
   * engine bands every layer off the distance to whatever the anchor is. See endFlight.
   */
  fromAnchorId: string | null
  fromRadiusMetres: number
  fromShapeRatio: number
}

export class AtlasControls {
  readonly frame: FrameId

  /** The point the camera orbits, in world metres. Float64. */
  readonly anchorWorld: Vec3d = vec3d()
  /** Mean radius of the anchored body in metres; drives the altitude-based zoom. */
  anchorRadiusMetres = 0
  /**
   * Equatorial radius over mean radius for the anchored body. 1 means spherical.
   *
   * `anchorRadiusMetres` is the MEAN radius, because that is what the catalogues quote
   * and what arrival framing, labels and the proxy sphere are all sized from. But
   * SphereBody applies a body's flattening ABOUT that mean, so what it actually draws
   * reaches mean / cbrt(polarRatio) at the equator — 3.53% further out for Saturn and
   * 2.2% for Jupiter. Flooring the descent against the mean therefore let the wheel
   * put the camera 2,030 km inside Saturn's drawn equator, where the front faces are
   * behind the near plane, the globe vanishes from the middle of the frame and the
   * constellation lines shine straight through it. The floor has to clear the surface
   * that is DRAWN, so whoever states the radius states the shape with it.
   */
  anchorShapeRatio = 1
  anchorId: string | null = null

  /** Distance from the anchor's centre, in metres. */
  distanceMetres = 3e9

  /** Orbit angles about the anchor, in radians, in the controller's frame. */
  yaw = 0.6
  pitch = 0.32

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
  setAnchor(
    worldPosition: Vec3d,
    frame: FrameId,
    radiusMetres: number,
    id: string | null,
    shapeRatio = 1,
  ): void {
    convertFrame(this.anchorWorld, worldPosition, frame, this.frame)
    this.anchorRadiusMetres = radiusMetres
    this.anchorShapeRatio = Math.max(finiteOr(shapeRatio, 1), 1)
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
    return Math.max(this.targetDistance - this.surfaceRadius(), this.minAltitude())
  }

  /**
   * How far the drawn surface reaches in its widest direction — the radius every floor
   * in here is measured from. A ratio below 1 would move the floor INSIDE the body, so
   * a caller that hands over polarRatio by mistake gets the sphere, not a hole.
   */
  private surfaceRadius(): number {
    return this.anchorRadiusMetres * Math.max(this.anchorShapeRatio, 1)
  }

  private minAltitude(): number {
    return Math.max(this.surfaceRadius() * MIN_ALTITUDE_FRACTION, 1)
  }

  /**
   * Scale the altitude by `factor`. Greater than one zooms out.
   * Never clamps inward — the asymptote does that job.
   */
  zoomBy(factor: number): void {
    // Commit first: scrolling mid-flight must scale the altitude the user can see, not
    // the one the flight departed from.
    this.endFlight(true)
    const altitude = Math.max(this.targetDistance - this.surfaceRadius(), this.minAltitude())
    const next = Math.max(altitude * factor, this.minAltitude())
    // The ceiling is a stop, not a spring. Only the WHEEL is bound by it: an arrival
    // distance is set by the object's own size and a mid-flight commit by where the
    // camera physically is, so targetDistance can legitimately already sit outside it.
    // Snapping back in on the first outward notch would answer a scroll outward with a
    // jump inward, which reads as the camera fighting the user. Only refuse to go
    // further.
    const ceiling = Math.max(MAX_DISTANCE_METRES, this.targetDistance)
    this.targetDistance = Math.min(this.surfaceRadius() + next, ceiling)
  }

  /** Jump straight to a distance from the anchor centre, in metres. */
  setDistance(metres: number): void {
    this.targetDistance = THREE.MathUtils.clamp(
      metres,
      this.surfaceRadius() + this.minAltitude(),
      MAX_DISTANCE_METRES,
    )
  }

  // -------------------------------------------------------------------------
  // Flight
  // -------------------------------------------------------------------------

  flyTo(target: FlyTarget, options: { instant?: boolean } = {}): void {
    // Into our own frame first: everything below subtracts, lerps or measures against
    // anchorWorld, and those operations are only meaningful within one frame.
    //
    // `frame` is required by the type, and the fallback is not a licence to omit it: it
    // is there because vite does not typecheck, so an un-updated call site would hand
    // convertFrame an undefined frame and throw inside frameRotation — boot calls focus,
    // so that takes the whole atlas down rather than merely flying to the wrong place.
    if (!target.frame) console.warn('[omniatlas] flyTo called with no frame; assuming', this.frame)
    const toAnchor = convertFrame(vec3d(), target.anchorWorld, target.frame ?? this.frame, this.frame)

    // Sanitise the arrival distance HERE, where it enters, not after it has spread.
    // The instant path writes toDistance into both distanceMetres and targetDistance,
    // and update() recovers a non-finite distanceMetres *from* targetDistance — so once
    // a NaN reaches both there is nothing left to recover it from and the camera
    // position is NaN for the rest of the session. The non-finite duration guard below
    // does not catch this: it routes the bad flight straight into that instant path.
    const toRadius = Math.max(finiteOr(target.radiusMetres, 0), 0)
    const toShape = Math.max(finiteOr(target.shapeRatio ?? 1, 1), 1)
    const floor = Math.max(toRadius * toShape * (1 + MIN_ALTITUDE_FRACTION), 1)
    const held = finiteOr(this.targetDistance, finiteOr(this.distanceMetres, floor))
    const toDistance = Math.max(finiteOr(target.distanceMetres, held), floor)

    if (options.instant) {
      this.endFlight(false)
      copy3d(this.anchorWorld, toAnchor)
      this.anchorRadiusMetres = toRadius
      this.anchorShapeRatio = toShape
      this.anchorId = target.anchorId
      this.targetDistance = toDistance
      this.distanceMetres = toDistance
      this.update(0)
      return
    }

    // Safety net, not an expected path: a non-finite distance would poison `ratio`, and
    // a NaN duration makes `t >= 1` unreachable, so the flight would never end and the
    // controller would stay "flying" until a reload. See advanceFlight.
    if (!Number.isFinite(this.distanceMetres)) this.distanceMetres = toDistance

    // Travel distance between the two anchors, measured in the frame we fly through.
    const travel = Math.hypot(
      toAnchor.x - this.anchorWorld.x,
      toAnchor.y - this.anchorWorld.y,
      toAnchor.z - this.anchorWorld.z,
    )
    const path = planZoomPath(0, this.distanceMetres, travel, toDistance)

    const ratio = Math.max(this.distanceMetres, toDistance) / Math.max(1, Math.min(this.distanceMetres, toDistance))
    const duration = THREE.MathUtils.clamp(420 * Math.log10(Math.max(ratio, 1.0001)) + 700, 900, 2600) / 1000

    if (!Number.isFinite(duration) || duration <= 0) {
      this.flyTo(target, { instant: true })
      return
    }

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
      radiusMetres: toRadius,
      shapeRatio: toShape,
      fromAnchorId: this.anchorId,
      fromRadiusMetres: this.anchorRadiusMetres,
      fromShapeRatio: this.anchorShapeRatio,
    }
  }

  get flying(): boolean {
    return this.flight !== null
  }

  /**
   * Abandon the flight and go back to orbiting what we were orbiting before it started.
   *
   * This really does cancel: the anchor, the radius and the smoothing target are all
   * left on the DEPARTURE body, so update() walks the camera back down the path it had
   * flown and trackAnchor re-glues it to the object the user was leaving. That is the
   * right behaviour for an embedder aborting a flight before a programmatic setAnchor,
   * and the wrong one for a user interrupting with the wheel — for that, see
   * stopFlightHere(), which is what the input handlers call.
   */
  cancelFlight(): void {
    this.endFlight(false)
  }

  /**
   * Stop flying and stay exactly where the camera is now, re-anchored on whichever
   * endpoint of the flight the camera has actually got nearest to. The pixels on screen
   * do not move; only the thing they are measured against changes. This is what a wheel
   * notch or a drag mid-flight does, and it is the same handover setAnchor makes for
   * select-and-scroll.
   */
  stopFlightHere(): void {
    this.endFlight(true)
  }

  /**
   * End the current flight. `commit` means a user input interrupted it, so the pose on
   * screen right now becomes the resting pose.
   *
   * Without that commit the controller rewinds. `flyTo` never writes `targetDistance`
   * and the flight writes only `distanceMetres`, so a bare `flight = null` leaves the
   * pre-flight distance as the smoothing target and the departure object as `anchorId`:
   * update() drags the camera back down the whole flight it just made, and trackAnchor
   * re-glues the anchor to the thing the user was leaving.
   */
  private endFlight(commit: boolean): void {
    const flight = this.flight
    this.flight = null
    if (!flight || !commit) return

    // Commit to the endpoint the camera is actually NEXT TO, not to the one the flight
    // was addressed to. Taking the destination unconditionally was right only in the
    // last stretch of a flight: interrupt Earth -> TON 618 150 ms in and the controller
    // reported an anchor 1.73e26 m away while the camera was still beside Earth, so the
    // engine banded every layer off that number — four draw calls became zero, the
    // frame went solid black, and the notch that triggered the commit then scaled an
    // altitude measured from TON 618 and threw the camera 2.26e25 m out of the solar
    // system. The crossover is the one the HUD already uses: the destination becomes
    // the anchor at the point it becomes the nearer truth.
    const nearDestination =
      distance3d(this.cameraWorld, flight.toAnchor) <= distance3d(this.cameraWorld, flight.fromAnchor)
    const anchor = nearDestination ? flight.toAnchor : flight.fromAnchor

    this.anchorId = nearDestination ? flight.anchorId : flight.fromAnchorId
    this.anchorRadiusMetres = nearDestination ? flight.radiusMetres : flight.fromRadiusMetres
    this.anchorShapeRatio = nearDestination ? flight.shapeRatio : flight.fromShapeRatio
    copy3d(this.anchorWorld, anchor)

    // Re-derive the WHOLE pose about that anchor from where the camera actually is.
    // Adopting a radius while keeping the distance the flight departed from meant the
    // commit only held for anchors smaller than that distance, and the altitude floor
    // then clamped the camera up onto the event horizon. Measuring the offset first and
    // inverting it keeps the frame identical across the interrupt.
    const camX = this.cameraWorld.x - anchor.x
    const camY = this.cameraWorld.y - anchor.y
    const camZ = this.cameraWorld.z - anchor.z
    const offset = Math.hypot(camX, camY, camZ)
    const posed = Number.isFinite(offset) && offset > 0

    this.distanceMetres = this.targetDistance = Math.max(
      posed ? offset : flight.toDistance,
      this.surfaceRadius() * (1 + MIN_ALTITUDE_FRACTION),
    )
    if (posed) {
      this.yaw = this.targetYaw = Math.atan2(camY, camX)
      // camZ / offset can land a few ulps outside [-1, 1] when the camera is on the
      // orbit axis, and Math.asin returns NaN there rather than +/- pi/2.
      const sinPitch = THREE.MathUtils.clamp(camZ / offset, -1, 1)
      this.pitch = this.targetPitch = THREE.MathUtils.clamp(Math.asin(sinPitch), -MAX_PITCH, MAX_PITCH)
    } else {
      this.targetYaw = this.yaw
      this.targetPitch = this.pitch
    }
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
      // Log smoothing turns a non-finite distance into a permanent one, and a NaN
      // distance makes every later flyTo compute a NaN duration, which never completes.
      // Should never fire; it is the last line of defence, not a feature.
      if (!Number.isFinite(this.distanceMetres)) this.distanceMetres = this.targetDistance
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
    let { u, w } = flight.path.at(eased * flight.path.S)

    const travel = Math.hypot(
      flight.toAnchor.x - flight.fromAnchor.x,
      flight.toAnchor.y - flight.fromAnchor.y,
      flight.toAnchor.z - flight.fromAnchor.z,
    )
    // Safety net for a path that could not be parameterised. A log-space lerp is a
    // poorer flight than van Wijk's, but it is finite, and a NaN here used to leak into
    // distanceMetres and strand the controller mid-flight forever.
    if (!Number.isFinite(u) || !Number.isFinite(w)) {
      u = travel * eased
      w = Math.exp(
        Math.log(Math.max(flight.fromDistance, 1)) +
          (Math.log(Math.max(flight.toDistance, 1)) - Math.log(Math.max(flight.fromDistance, 1))) * eased,
      )
    }
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
      this.anchorShapeRatio = flight.shapeRatio
      this.anchorId = flight.anchorId
      this.distanceMetres = flight.toDistance
      this.targetDistance = flight.toDistance
      this.flight = null
    }
  }

  /** Derive the camera world position and orientation from the orbit state. */
  private recomputePose(): void {
    const cosPitch = Math.cos(this.pitch)
    const sinPitch = Math.sin(this.pitch)
    const cosYaw = Math.cos(this.yaw)
    const sinYaw = Math.sin(this.yaw)
    this.scratchDir.x = cosPitch * cosYaw
    this.scratchDir.y = cosPitch * sinYaw
    this.scratchDir.z = sinPitch

    addScaled3d(this.cameraWorld, this.anchorWorld, this.scratchDir, this.distanceMetres)

    // Orientation: look from the offset back at the anchor, in the Y-up scene basis.
    worldToSceneBasis(this.scratch, this.scratchDir)
    this.eye.set(this.scratch.x, this.scratch.y, this.scratch.z)

    // Up is the meridian tangent: the derivative of the orbit direction with respect to
    // pitch. It is already unit length and already exactly perpendicular to the view at
    // every yaw and pitch, poles included, where it tends to -(cos yaw, sin yaw, 0)
    // rather than becoming undefined. Away from the poles it is the pole axis with the
    // view component removed, so the roll is unchanged from what this code always did.
    // What it replaces is a guard that swapped in a FIXED axis whenever the view came
    // within 0.81 degrees of the pole axis, which rolled the view about 140 degrees in
    // one frame the moment pitch passed 89.19 — well inside the 89.9 pitch clamp.
    this.scratch.x = -sinPitch * cosYaw
    this.scratch.y = -sinPitch * sinYaw
    this.scratch.z = cosPitch
    worldToSceneBasis(this.scratch, this.scratch)
    this.up.set(this.scratch.x, this.scratch.y, this.scratch.z)

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
    // Pointer capture throws NotFoundError if the pointer is already gone — which
    // happens with synthetic events, with some touch cancellations, and whenever the
    // browser retires a pointer between the event firing and this handler running.
    // Capture is an optimisation for drags that leave the element, never a necessity.
    try {
      this.domElement.setPointerCapture?.(event.pointerId)
    } catch {
      /* dragging still works without capture */
    }
  }

  private onPointerMove = (event: PointerEvent) => {
    if (!this.enabled || this.dragging !== 'orbit' || event.pointerId !== this.activePointer) return
    const dx = event.clientX - this.lastPointer.x
    const dy = event.clientY - this.lastPointer.y
    this.lastPointer.x = event.clientX
    this.lastPointer.y = event.clientY

    this.endFlight(true)
    const scale = (this.rotateSpeed * Math.PI) / Math.max(this.domElement.clientHeight, 1)
    this.targetYaw -= dx * scale
    this.targetPitch = THREE.MathUtils.clamp(this.targetPitch + dy * scale, -MAX_PITCH, MAX_PITCH)
  }

  private onPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.activePointer) return
    this.dragging = null
    this.activePointer = null
    try {
      this.domElement.releasePointerCapture?.(event.pointerId)
    } catch {
      /* the capture was already released */
    }
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
    this.endFlight(true)
    this.targetYaw += deltaYaw
    this.targetPitch = THREE.MathUtils.clamp(this.targetPitch + deltaPitch, -MAX_PITCH, MAX_PITCH)
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
