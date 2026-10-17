import { describe, expect, it } from 'vitest'
import { AtlasControls } from '../../src/core/camera/AtlasControls'
import { PC_M, type Vec3d, convertFrame, distance3d, vec3d } from '../../src/core/world'

/**
 * AtlasControls needs nothing from the DOM but listener registration and a height to
 * scale drag sensitivity by, so the whole controller runs under `environment: 'node'`.
 */
function makeControls(frame: 'ecliptic' | 'icrf' = 'ecliptic'): AtlasControls {
  const element = {
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    clientWidth: 1200,
    clientHeight: 800,
  } as unknown as HTMLElement
  return new AtlasControls({ domElement: element, frame })
}

/** Run a flight to completion at a fixed step, so the test is framerate-independent. */
function flyToCompletion(controls: AtlasControls, maxSteps = 400): number {
  let steps = 0
  while (controls.flying && steps < maxSteps) {
    controls.update(0.05)
    steps++
  }
  return steps
}

describe('flyTo frame conversion', () => {
  /**
   * The bug this exists to prevent: FlyTarget carried a bare `anchorWorld` with no frame,
   * so flying to an ICRF or supergalactic object lerped a position from one frame into an
   * ecliptic anchor. The flight travelled to the wrong point for its whole duration and
   * then snapped by the full frame-conversion error — 23.4 degrees at the worst axis — on
   * arrival. Mirrors the assertion pair in anchor-and-notable.test.ts.
   */
  const icrfPoint = vec3d(0, 152 * PC_M, 0)
  const expected = convertFrame(vec3d(), icrfPoint, 'icrf', 'ecliptic')

  const target = (position: Vec3d) => ({
    anchorWorld: position,
    frame: 'icrf' as const,
    radiusMetres: 1e9,
    distanceMetres: 1e12,
    anchorId: 'probe',
  })

  it('converts the destination into the controller frame on an instant arrival', () => {
    const controls = makeControls('ecliptic')
    controls.flyTo(target(icrfPoint), { instant: true })

    expect(distance3d(controls.anchorWorld, expected)).toBeLessThan(1)
    // The pair matters: a no-op convertFrame would also pass the line above if the two
    // frames happened to agree. 152 pc at 23.4 degrees of obliquity is 1.9e18 m apart.
    expect(distance3d(controls.anchorWorld, icrfPoint)).toBeGreaterThan(1e18)
  })

  it('converts the destination before measuring the path, not after landing', () => {
    const controls = makeControls('ecliptic')
    controls.flyTo(target(icrfPoint))
    expect(controls.flying).toBe(true)

    // Halfway through, the anchor must already be on the line to the CONVERTED point.
    // The unconverted point is 1.9e18 m off that line, so an unconverted lerp cannot
    // pass this even at the midpoint.
    controls.update(0.5)
    const toExpected = distance3d(controls.anchorWorld, expected)
    const toRaw = distance3d(controls.anchorWorld, icrfPoint)
    expect(toExpected).toBeLessThan(toRaw)

    flyToCompletion(controls)
    expect(controls.flying).toBe(false)
    expect(distance3d(controls.anchorWorld, expected)).toBeLessThan(1)
    expect(distance3d(controls.anchorWorld, icrfPoint)).toBeGreaterThan(1e18)
  })

  it('leaves a destination already in the controller frame untouched', () => {
    const controls = makeControls('icrf')
    controls.flyTo(target(icrfPoint), { instant: true })
    expect(distance3d(controls.anchorWorld, icrfPoint)).toBe(0)
  })
})

/**
 * TON 618 as the registry places it: 1.733e26 m away (z = 2.22 at comoving distance)
 * with a 1.949e14 m horizon — the radius is seven orders of magnitude larger than the
 * distance an Earth-anchored camera is sitting at, which is the whole point.
 */
const TON618 = vec3d(0, 1.733e26, 0)
const TON618_RADIUS = 1.949e14
const EARTH_AT = vec3d(1.4e11, 0, 0)
const EARTH_DISTANCE = 2.6758e7

/** Earth-ish departure, then a black hole whose horizon dwarfs the departure distance. */
function departAndLaunch(): AtlasControls {
  const controls = makeControls('ecliptic')
  controls.setAnchor(EARTH_AT, 'ecliptic', 6.371e6, 'earth')
  controls.setDistance(EARTH_DISTANCE)
  for (let i = 0; i < 80; i++) controls.update(0.05)

  controls.flyTo({
    anchorWorld: TON618,
    frame: 'ecliptic',
    radiusMetres: TON618_RADIUS,
    distanceMetres: 6.6e15,
    anchorId: 'bh:ton618',
  })
  // 130 ms into a ~2.3 s flight: still deep inside the solar system.
  controls.update(0.05)
  controls.update(0.08)
  return controls
}

describe('interrupting a flight', () => {
  /**
   * The bug this exists to prevent: the commit adopted the flight's DESTINATION however
   * little of the flight had been flown. Interrupting Earth -> TON 618 150 ms in, with
   * the camera still beside Earth, left the controller reporting an anchor 1.733e26 m
   * away. The engine bands every layer off `distance3d(cameraWorld, anchorWorld)`, so
   * on the real page four draw calls became zero and the frame went solid black; the
   * notch that triggered the commit then scaled an altitude measured from TON 618 and
   * threw the camera 2.26e25 m — 2.4 billion light years — out of the solar system.
   */
  it('commits to the body it is leaving, one notch above it, not to the destination', () => {
    const controls = departAndLaunch()
    const before = vec3d(controls.cameraWorld.x, controls.cameraWorld.y, controls.cameraWorld.z)
    // Where the camera physically is: still inside the Earth-Moon distance, and already
    // pulled back from the 2.6758e7 m it departed at by the first moments of the flight.
    const held = distance3d(before, EARTH_AT)
    expect(held).toBeLessThan(4e8)
    expect(held / EARTH_DISTANCE).toBeGreaterThan(1.5)

    controls.zoomBy(1 / 1.15)
    for (let i = 0; i < 200; i++) controls.update(0.05)

    expect(controls.flying).toBe(false)
    expect(controls.anchorId).toBe('earth')
    // The commit itself moves nothing; the notch that triggered it then scales the
    // altitude above EARTH by exactly 1/1.15, so the camera ends one notch nearer the
    // thing it was leaving and nowhere else.
    const altitude = held - 6.371e6
    expect((controls.distanceMetres - 6.371e6) / (altitude / 1.15)).toBeCloseTo(1, 6)
    expect(distance3d(controls.cameraWorld, before) / (altitude * (1 - 1 / 1.15))).toBeCloseTo(1, 6)
  })

  /**
   * The engine-visible half of the same bug, and the one a standalone controller test
   * would otherwise never see: `Engine.draw` bands every layer off the camera-to-anchor
   * distance, so a commit that changes that number by seventeen orders of magnitude
   * switches the whole scene off even though no pixel has moved.
   */
  it('leaves the anchor distance the engine bands off where it was', () => {
    const controls = departAndLaunch()
    const beforeCommit = distance3d(controls.cameraWorld, controls.anchorWorld)

    controls.stopFlightHere()

    const afterCommit = distance3d(controls.cameraWorld, controls.anchorWorld)
    expect(afterCommit / beforeCommit).toBeGreaterThan(0.1)
    expect(afterCommit / beforeCommit).toBeLessThan(10)
  })

  it('re-measures the distance about the committed anchor instead of carrying the old one over', () => {
    const controls = departAndLaunch()
    const offset = distance3d(controls.cameraWorld, EARTH_AT)

    controls.stopFlightHere()

    expect(controls.anchorId).toBe('earth')
    expect(controls.anchorRadiusMetres).toBe(6.371e6)
    // The true camera-to-Earth distance now, not the 2.6758e7 m the flight departed at.
    expect(controls.distanceMetres / offset).toBeCloseTo(1, 9)
    // And it is a resting pose: a frame of smoothing must not move the camera.
    const held = vec3d(controls.cameraWorld.x, controls.cameraWorld.y, controls.cameraWorld.z)
    controls.update(1 / 60)
    expect(distance3d(controls.cameraWorld, held) / controls.distanceMetres).toBeLessThan(1e-12)
  })

  /**
   * The other side of the crossover. Late in a flight the destination IS what the camera
   * is next to, and re-anchoring on the departure body would then be the teleport — the
   * same rule, and the same crossover, the HUD uses to decide which object to name.
   */
  it('adopts the destination once the camera is nearer to it than to what it left', () => {
    const controls = departAndLaunch()
    while (
      controls.flying &&
      distance3d(controls.cameraWorld, TON618) > distance3d(controls.cameraWorld, EARTH_AT)
    ) {
      controls.update(0.05)
    }
    expect(controls.flying).toBe(true)

    controls.stopFlightHere()
    expect(controls.anchorId).toBe('bh:ton618')
    expect(controls.anchorRadiusMetres).toBe(TON618_RADIUS)
    expect(controls.distanceMetres / distance3d(controls.cameraWorld, TON618)).toBeCloseTo(1, 9)
  })

  it('never lets the commit put the camera inside the body it commits to', () => {
    const controls = makeControls('ecliptic')
    controls.setAnchor(vec3d(0, 0, 0), 'ecliptic', 6.957e8, 'sun')
    controls.setDistance(1e10)
    for (let i = 0; i < 80; i++) controls.update(0.05)
    // A destination whose radius is larger than where the camera currently stands, and
    // close enough to the departure point that the camera is already nearer to it.
    controls.flyTo({
      anchorWorld: vec3d(1e9, 0, 0),
      frame: 'ecliptic',
      radiusMetres: 1e13,
      distanceMetres: 4e13,
      anchorId: 'giant',
    })
    controls.update(0.05)
    expect(distance3d(controls.cameraWorld, vec3d(1e9, 0, 0))).toBeLessThan(1e13)

    controls.stopFlightHere()
    expect(controls.anchorId).toBe('giant')
    expect(controls.distanceMetres).toBeGreaterThanOrEqual(1e13)
  })

  it('cancelFlight rewinds to the departure body, distance and all', () => {
    const cancelled = departAndLaunch()
    cancelled.cancelFlight()
    for (let i = 0; i < 200; i++) cancelled.update(0.05)
    expect(cancelled.flying).toBe(false)
    expect(cancelled.anchorId).toBe('earth')
    expect(cancelled.distanceMetres / 2.6758e7).toBeCloseTo(1, 6)
  })
})

/**
 * The floor under the wheel.
 *
 * A mean radius is not what SphereBody draws: a flattened body is squashed about its
 * mean, so its equator stands at mean / cbrt(polarRatio). Saturn's is 3.53% outside the
 * mean, and the wheel used to bottom out 2,030 km inside it — the globe dropped out of
 * the middle of the frame, backface-culled, with the constellation lines showing
 * straight through where it should have been and the rings hanging in empty space.
 */
describe('the altitude floor', () => {
  const SATURN_MEAN = 5.8232e7
  const SATURN_SHAPE = 1 / Math.cbrt(0.90204)

  function descend(controls: AtlasControls): void {
    for (let i = 0; i < 400; i++) controls.zoomBy(0.5)
    for (let i = 0; i < 200; i++) controls.update(0.05)
  }

  it('bottoms out above the drawn equator of a flattened body', () => {
    const controls = makeControls('ecliptic')
    controls.setAnchor(vec3d(), 'ecliptic', SATURN_MEAN, 'saturn', SATURN_SHAPE)
    controls.setDistance(SATURN_MEAN * 4)
    for (let i = 0; i < 80; i++) controls.update(0.05)

    descend(controls)
    const drawnEquator = SATURN_MEAN * SATURN_SHAPE
    expect(controls.distanceMetres).toBeGreaterThanOrEqual(drawnEquator)
    expect(controls.distanceMetres / drawnEquator).toBeCloseTo(1, 3)
  })

  it('still lets a spherical body be approached to 1.0001 radii', () => {
    const controls = makeControls('ecliptic')
    controls.setAnchor(vec3d(), 'ecliptic', 6.371e6, 'earth')
    controls.setDistance(6.371e7)
    for (let i = 0; i < 80; i++) controls.update(0.05)

    descend(controls)
    expect(controls.distanceMetres / (6.371e6 * 1.0001)).toBeCloseTo(1, 6)
  })

  it('treats a ratio below one as spherical rather than moving the floor inside', () => {
    const controls = makeControls('ecliptic')
    // polarRatio handed over by mistake where the equatorial ratio belongs.
    controls.setAnchor(vec3d(), 'ecliptic', SATURN_MEAN, 'saturn', 0.90204)
    controls.setDistance(SATURN_MEAN * 4)
    for (let i = 0; i < 80; i++) controls.update(0.05)

    descend(controls)
    expect(controls.distanceMetres / (SATURN_MEAN * 1.0001)).toBeCloseTo(1, 6)
  })

  it('carries the shape through a flight, so arriving does not undo it', () => {
    const controls = makeControls('ecliptic')
    controls.flyTo(
      {
        anchorWorld: vec3d(1.4e12, 0, 0),
        frame: 'ecliptic',
        radiusMetres: SATURN_MEAN,
        shapeRatio: SATURN_SHAPE,
        distanceMetres: SATURN_MEAN * 4,
        anchorId: 'saturn',
      },
      { instant: true },
    )
    descend(controls)
    expect(controls.distanceMetres).toBeGreaterThanOrEqual(SATURN_MEAN * SATURN_SHAPE)
  })
})

describe('non-finite guards', () => {
  /**
   * The bug these exist to prevent: once distanceMetres went NaN it was permanent. The
   * non-flight branch of update() smooths in log space, and log(max(NaN, 1e-6)) is NaN;
   * every later flyTo then computed a NaN `ratio`, hence a NaN duration, hence a `t` that
   * never reached 1, so the controller stayed "flying" until a page reload.
   */
  it('a NaN distance does not poison the next flight', () => {
    const controls = makeControls('ecliptic')
    controls.distanceMetres = Number.NaN

    controls.flyTo({
      anchorWorld: vec3d(0, 4e16, 0),
      frame: 'ecliptic',
      radiusMetres: 7e8,
      distanceMetres: 3e9,
      anchorId: 'star',
    })
    expect(controls.flying).toBe(true)
    expect(Number.isFinite(controls.distanceMetres)).toBe(true)

    const steps = flyToCompletion(controls)
    expect(steps).toBeLessThan(400)
    expect(controls.flying).toBe(false)
    expect(controls.anchorId).toBe('star')
    expect(controls.distanceMetres).toBe(3e9)
  })

  it('update() recovers a NaN distance instead of smoothing it forever', () => {
    const controls = makeControls('ecliptic')
    controls.setDistance(5e9)
    controls.distanceMetres = Number.NaN

    controls.update(1 / 60)

    expect(Number.isFinite(controls.distanceMetres)).toBe(true)
    expect(Number.isFinite(controls.cameraWorld.x)).toBe(true)
    expect(Number.isFinite(controls.quaternion.x)).toBe(true)
    expect(controls.quaternion.length()).toBeCloseTo(1, 12)
  })

  /**
   * The symmetric hole: the guard above only catches a NaN that is already sitting in
   * `distanceMetres`. A NaN arriving in the TARGET used to route through the non-finite
   * duration guard into the instant path, which wrote it into distanceMetres AND
   * targetDistance — and update() recovers one from the other, so with both poisoned
   * the camera position stayed NaN for the rest of the session.
   */
  it('a NaN arrival distance does not poison the camera', () => {
    const controls = makeControls('ecliptic')
    controls.setAnchor(vec3d(), 'ecliptic', 6.957e8, 'sun')
    controls.setDistance(3e9)
    for (let i = 0; i < 60; i++) controls.update(0.05)

    controls.flyTo({
      anchorWorld: vec3d(0, 4e16, 0),
      frame: 'ecliptic',
      radiusMetres: 7e8,
      distanceMetres: Number.NaN,
      anchorId: 'star',
    })
    expect(Number.isFinite(controls.distanceMetres)).toBe(true)

    flyToCompletion(controls)
    for (let i = 0; i < 200; i++) controls.update(1 / 60)
    expect(controls.flying).toBe(false)
    expect(controls.anchorId).toBe('star')
    expect(Number.isFinite(controls.distanceMetres)).toBe(true)
    expect(Number.isFinite(controls.cameraWorld.x)).toBe(true)
  })

  it('a NaN radius or arrival distance survives the instant path too', () => {
    const controls = makeControls('ecliptic')
    controls.setDistance(3e9)
    controls.flyTo(
      {
        anchorWorld: vec3d(0, 4e16, 0),
        frame: 'ecliptic',
        radiusMetres: Number.NaN,
        distanceMetres: Number.NaN,
        anchorId: 'star',
      },
      { instant: true },
    )
    expect(Number.isFinite(controls.distanceMetres)).toBe(true)
    expect(Number.isFinite(controls.anchorRadiusMetres)).toBe(true)
    expect(Number.isFinite(controls.cameraWorld.x)).toBe(true)
    controls.zoomBy(1 / 1.15)
    for (let i = 0; i < 60; i++) controls.update(1 / 60)
    expect(Number.isFinite(controls.distanceMetres)).toBe(true)
    expect(Number.isFinite(controls.cameraWorld.x)).toBe(true)
  })

  it('an unparameterisable path still finishes rather than stranding the controller', () => {
    const controls = makeControls('ecliptic')
    controls.setDistance(1e3)
    for (let i = 0; i < 60; i++) controls.update(0.05)

    // A 1e23 distance ratio is exactly where the old log-and-sqrt form returned
    // -Infinity. What this pins is the OUTCOME — the flight stays finite and lands —
    // not the fallback in advanceFlight: with asinh in planZoomPath that branch is
    // unreachable from any input the app can produce, so nothing here executes it and
    // deleting it would leave this green. It is kept as a guard against a future
    // reparameterisation, not because it is covered.
    controls.flyTo({
      anchorWorld: vec3d(0, 0, 1e26),
      frame: 'ecliptic',
      radiusMetres: 0,
      distanceMetres: 1e26,
      anchorId: 'far',
    })
    let nonFinite = 0
    while (controls.flying) {
      controls.update(0.05)
      if (!Number.isFinite(controls.distanceMetres) || !Number.isFinite(controls.cameraWorld.z)) nonFinite++
    }
    expect(nonFinite).toBe(0)
    expect(controls.anchorId).toBe('far')
  })
})

describe('the outward zoom ceiling', () => {
  /**
   * Measured on the real page: the outermost catalogue reaches ~770 Mpc, so of a
   * 1384 x 805 frame 40,049 pixels are lit at 1e26 m, 9,749 at 3e26 and 4,910 at the
   * old 1e28 ceiling — and those last are the camera-pinned deep-field illustration,
   * which is the same at every distance. The wheel used to keep turning across the last
   * two decades of that with nothing on screen to show for it.
   */
  it('stops the wheel once the drawn universe is a dot', () => {
    const controls = makeControls('ecliptic')
    controls.setAnchor(vec3d(), 'ecliptic', 6.957e8, 'sun')
    controls.setDistance(1e25)
    for (let i = 0; i < 200; i++) controls.update(0.05)

    for (let i = 0; i < 200; i++) controls.zoomBy(1.15)
    for (let i = 0; i < 400; i++) controls.update(0.05)

    expect(controls.distanceMetres).toBeLessThanOrEqual(1e26 * (1 + 1e-9))
    expect(controls.distanceMetres / 1e26).toBeCloseTo(1, 6)
  })

  it('does not drag the camera back in when it starts beyond the ceiling', () => {
    const controls = makeControls('ecliptic')
    // Only the wheel is bound by the ceiling. An arrival distance comes from the
    // object's own size, so the controller can legitimately be parked outside it — and
    // a stop that answered a scroll outward with a jump inward would read as the camera
    // fighting the user.
    controls.flyTo(
      {
        anchorWorld: vec3d(),
        frame: 'ecliptic',
        radiusMetres: 1e24,
        distanceMetres: 2e26,
        anchorId: 'void',
      },
      { instant: true },
    )
    const parked = controls.distanceMetres
    expect(parked / 2e26).toBeCloseTo(1, 12)

    controls.zoomBy(1.15)
    for (let i = 0; i < 60; i++) controls.update(0.05)
    expect(controls.distanceMetres / parked).toBeCloseTo(1, 9)

    // Inward still works normally.
    controls.zoomBy(1 / 1.15)
    for (let i = 0; i < 200; i++) controls.update(0.05)
    expect(controls.distanceMetres).toBeLessThan(parked)
  })
})
