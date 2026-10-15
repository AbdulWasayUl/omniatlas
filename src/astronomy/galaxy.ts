/**
 * The Milky Way's spiral structure, as maths.
 *
 * Everything in this file is the Reid et al. (2019) log-periodic arm model and the
 * coordinate algebra around it. There is no Three.js here and no rendering decision:
 * `src/modules/galaxy/index.ts` consumes these numbers, and `tests/unit/galaxy.test.ts`
 * checks them against the published values.
 *
 * **This is a MODEL.** The curves below are fits. The observations they were fitted to
 * are the ~200 trigonometric maser parallaxes in `public/data/galaxy/masers.json`, which
 * the renderer draws alongside the curves for exactly that reason. There is no
 * photograph of the Milky Way from outside and there never will be.
 *
 * ## The two frames, and why they are both here
 *
 * Reid's model is **galactocentric**: origin at the Galactic centre, +X along galactic
 * rotation at the Sun (toward l = 90 deg), +Y from the centre toward the Sun, +Z toward
 * the north galactic pole. Azimuth is `beta = atan2(X, Y)`, zero at the Sun's azimuth
 * and increasing with rotation.
 *
 * OmniAtlas's `galactic` frame is **heliocentric**: the world origin is the Sun for
 * every frame, and the galactic axes are the IAU ones — +x toward the Galactic centre
 * (l = 0), +y toward l = 90, +z toward the NGP. So the arm model has to be shifted by
 * R0 and have its axes permuted before any of it can be handed to a Layer. Getting that
 * wrong rotates the entire Galaxy by 90 degrees and puts the Sun in the bulge, which is
 * the kind of error that still looks like a galaxy.
 */

/** Sun's galactocentric radius adopted by Reid+2019, in kpc. */
export const R0_KPC = 8.15
/** Sun's height above the galactic midplane adopted by Reid+2019, in kpc. */
export const Z_SUN_KPC = 0.0055
/** Circular rotation speed at the Sun, km/s (Reid+2019). */
export const THETA0_KM_S = 236
/**
 * The fitted arm-width gradient, converted from the paper's pc per kpc to kpc per kpc.
 * Arms are measurably wider in the outer Galaxy.
 */
export const ARM_WIDTH_GRADIENT_KPC_PER_KPC = 0.042

const DEG = Math.PI / 180

/** A point in Reid's galactocentric Cartesian frame, kpc. */
export interface GalactocentricKpc {
  x: number
  y: number
  z: number
}

/** A point in OmniAtlas's heliocentric IAU galactic frame, kpc. */
export interface HeliocentricGalacticKpc {
  x: number
  y: number
  z: number
}

/**
 * One fitted stretch of an arm. Arms are piecewise log-periodic: Reid fits a different
 * pitch angle either side of a "kink" azimuth, and the segments are chained so that R
 * stays continuous across the join.
 */
export interface ArmSegmentFit {
  betaMinDeg: number
  betaMaxDeg: number
  betaRefDeg: number
  rRefKpc: number
  pitchDeg: number
  fitted: boolean
  provenance?: string
}

/** One arm, as `public/data/galaxy/arms.json` stores it. */
export interface ArmFit {
  id: string
  name: string
  shortName: string
  armCodes: string[]
  nParallaxSources: number
  betaDataRangeDeg: [number, number]
  betaDrawRangeDeg: [number, number]
  extrapolatedBelowDeg: number | null
  extrapolatedAboveDeg: number | null
  betaKinkDeg: number
  rKinkKpc: number
  pitchLowDeg: number
  pitchHighDeg: number
  widthKpc: number
  fieldWeight: number
  notes?: string | null
  segments: ArmSegmentFit[]
}

/** The whole file. Only the fields this code reads are typed. */
export interface ArmModelFile {
  kind: string
  badge: string
  description: string
  recordCount: number
  attribution: string
  source: { paper: string; bibcode: string; doi: string; url: string; table: string }
  caveats: string[]
  arms: ArmFit[]
}

/**
 * The arms whose pitch angles Reid+2019 quotes as the Galaxy's grand design. The other
 * three entries in the file are not of the same kind: the 3-kpc arm is a bar feature and
 * the inner Norma segment has a negative fitted pitch, so both wind the opposite way.
 * Averaging them in would produce a meaningless "mean pitch angle" for the Galaxy.
 */
export const MAJOR_ARM_IDS: readonly string[] = [
  'scutum-centaurus',
  'sagittarius-carina',
  'local',
  'perseus',
]

// ---------------------------------------------------------------------------
// The log-periodic spiral
// ---------------------------------------------------------------------------

/**
 * The model, verbatim from the paper:
 *
 *     ln(R / R_ref) = -(beta - beta_ref) * tan(pitch)
 *
 * with every angle in radians. A positive pitch angle therefore means R *decreases* with
 * increasing azimuth, which is the trailing sense the Galaxy actually winds in.
 */
export function armRadiusKpc(segment: ArmSegmentFit, betaDeg: number): number {
  const dBeta = (betaDeg - segment.betaRefDeg) * DEG
  return segment.rRefKpc * Math.exp(-dBeta * Math.tan(segment.pitchDeg * DEG))
}

/**
 * The segment that owns an azimuth. Returns the nearest segment when `betaDeg` falls
 * outside every range, so the caller can still evaluate the curve — callers that care
 * about extrapolation should test `isExtrapolated` instead of relying on a null here.
 */
export function segmentForBeta(arm: ArmFit, betaDeg: number): ArmSegmentFit {
  for (const segment of arm.segments) {
    if (betaDeg >= segment.betaMinDeg && betaDeg <= segment.betaMaxDeg) return segment
  }
  let best = arm.segments[0]
  let bestGap = Number.POSITIVE_INFINITY
  for (const segment of arm.segments) {
    const gap = Math.min(Math.abs(betaDeg - segment.betaMinDeg), Math.abs(betaDeg - segment.betaMaxDeg))
    if (gap < bestGap) {
      bestGap = gap
      best = segment
    }
  }
  return best
}

/** Galactocentric radius of an arm's ridge line at an azimuth, in kpc. */
export function armRadiusAtBetaKpc(arm: ArmFit, betaDeg: number): number {
  return armRadiusKpc(segmentForBeta(arm, betaDeg), betaDeg)
}

/**
 * The fitted 1-sigma width of the distribution of high-mass star-forming regions about
 * the ridge line, in kpc. Not the width of the stellar arm, which is broader — the
 * renderer must not imply otherwise.
 */
export function armWidthKpc(arm: ArmFit, rKpc: number): number {
  return Math.max(0.02, arm.widthKpc + ARM_WIDTH_GRADIENT_KPC_PER_KPC * (rKpc - arm.rKinkKpc))
}

/** Whether an azimuth lies outside the range actually covered by parallax measurements. */
export function isExtrapolated(arm: ArmFit, betaDeg: number): boolean {
  const below = arm.extrapolatedBelowDeg
  const above = arm.extrapolatedAboveDeg
  if (below !== null && betaDeg < below) return true
  if (above !== null && betaDeg > above) return true
  return false
}

/** Reid's azimuth-and-radius to his Cartesian frame: X = R sin(beta), Y = R cos(beta). */
export function galactocentricFromBeta(betaDeg: number, rKpc: number): GalactocentricKpc {
  const beta = betaDeg * DEG
  return { x: rKpc * Math.sin(beta), y: rKpc * Math.cos(beta), z: 0 }
}

/** Galactocentric azimuth of a point, in degrees, in Reid's convention. */
export function betaDegOf(point: GalactocentricKpc): number {
  return Math.atan2(point.x, point.y) / DEG
}

export interface ArmSample {
  betaDeg: number
  rKpc: number
  /** Ridge-line position, galactocentric kpc. */
  position: GalactocentricKpc
  /** Unit vector along the ridge, in the plane, pointing toward increasing beta. */
  tangent: GalactocentricKpc
  /** Unit vector in the plane perpendicular to the ridge. */
  normal: GalactocentricKpc
  /** Fitted 1-sigma half-width at this radius, kpc. */
  halfWidthKpc: number
  /** True where no parallax measurement constrains the curve. */
  extrapolated: boolean
}

/**
 * Walk an arm's draw range and return its ridge line with a local frame at every step.
 * The tangent is computed by finite difference of the analytic curve rather than from
 * neighbouring samples, so the ribbon does not inherit the sampling rate's error.
 */
export function sampleArmRidge(arm: ArmFit, steps = 220): ArmSample[] {
  const [betaMin, betaMax] = arm.betaDrawRangeDeg
  const samples: ArmSample[] = []
  const span = betaMax - betaMin
  if (!Number.isFinite(span) || span === 0 || steps < 2) return samples

  const h = span / (steps - 1)
  for (let i = 0; i < steps; i++) {
    const betaDeg = betaMin + h * i
    const rKpc = armRadiusAtBetaKpc(arm, betaDeg)
    const position = galactocentricFromBeta(betaDeg, rKpc)

    const eps = Math.max(Math.abs(h) * 0.5, 1e-3)
    const ahead = galactocentricFromBeta(betaDeg + eps, armRadiusAtBetaKpc(arm, betaDeg + eps))
    const behind = galactocentricFromBeta(betaDeg - eps, armRadiusAtBetaKpc(arm, betaDeg - eps))
    let tx = ahead.x - behind.x
    let ty = ahead.y - behind.y
    const tLength = Math.hypot(tx, ty) || 1
    tx /= tLength
    ty /= tLength

    samples.push({
      betaDeg,
      rKpc,
      position,
      tangent: { x: tx, y: ty, z: 0 },
      // Rotate the tangent by 90 degrees in the plane.
      normal: { x: -ty, y: tx, z: 0 },
      halfWidthKpc: armWidthKpc(arm, rKpc),
      extrapolated: isExtrapolated(arm, betaDeg),
    })
  }
  return samples
}

/**
 * Perpendicular distance from a point to an arm's ridge line, in kpc, measured in the
 * plane. Sampled rather than solved: the curve is monotonic in beta within a segment but
 * the nearest point is not analytic once the arm wraps past 180 degrees.
 */
export function distanceToArmKpc(arm: ArmFit, point: GalactocentricKpc, steps = 720): number {
  const [betaMin, betaMax] = arm.betaDrawRangeDeg
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < steps; i++) {
    const betaDeg = betaMin + ((betaMax - betaMin) * i) / (steps - 1)
    const ridge = galactocentricFromBeta(betaDeg, armRadiusAtBetaKpc(arm, betaDeg))
    const d = Math.hypot(point.x - ridge.x, point.y - ridge.y)
    if (d < best) best = d
  }
  return best
}

/** Mean of an arm's two fitted pitch angles, in degrees. */
export function meanPitchDeg(arm: ArmFit): number {
  return (arm.pitchLowDeg + arm.pitchHighDeg) / 2
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** The Sun, in Reid's galactocentric frame. */
export function sunGalactocentricKpc(): GalactocentricKpc {
  return { x: 0, y: R0_KPC, z: Z_SUN_KPC }
}

/** How far the Sun is from the Galactic centre, in kpc. */
export function sunGalactocentricRadiusKpc(): number {
  const sun = sunGalactocentricKpc()
  return Math.hypot(sun.x, sun.y, sun.z)
}

/**
 * Reid galactocentric -> OmniAtlas heliocentric IAU galactic, both in kpc.
 *
 *     x_helio = R0 - Y_reid     (+x points at the Galactic centre)
 *     y_helio = X_reid          (+y points at l = 90, the direction of rotation)
 *     z_helio = Z_reid - z_sun  (+z points at the NGP)
 *
 * This is the inverse of the conversion stated in `localgroup.json`'s frame block, and
 * the test suite checks the round trip against a maser whose heliocentric distance the
 * catalogue publishes independently.
 */
export function galactocentricToHeliocentric(point: GalactocentricKpc): HeliocentricGalacticKpc {
  return { x: R0_KPC - point.y, y: point.x, z: point.z - Z_SUN_KPC }
}

/** The inverse of `galactocentricToHeliocentric`. */
export function heliocentricToGalactocentric(point: HeliocentricGalacticKpc): GalactocentricKpc {
  return { x: point.y, y: R0_KPC - point.x, z: point.z + Z_SUN_KPC }
}

/**
 * Reid galactocentric kpc -> the Y-up render basis, as an offset from the Galactic
 * centre. The renderer parents all galactocentric geometry to a group sitting at the
 * Galactic centre, so these are the numbers that go into a vertex buffer, and they stay
 * under about 20 — four orders of magnitude inside the precision budget.
 *
 * Derivation: the heliocentric offset of the point from the Galactic centre is
 * `(-Y, X, Z)` in IAU galactic axes, and `worldToSceneBasis` maps `(x, y, z)` to
 * `(x, z, -y)`. Composing gives `(-Y, Z, -X)`.
 */
export function galactocentricToSceneOffsetKpc(point: GalactocentricKpc): [number, number, number] {
  return [-point.y, point.z, -point.x]
}

/** Heliocentric IAU galactic kpc -> the Y-up render basis, relative to the Sun. */
export function heliocentricToSceneKpc(point: HeliocentricGalacticKpc): [number, number, number] {
  return [point.x, point.z, -point.y]
}

/**
 * Galactic (l, b) and a distance to heliocentric IAU galactic Cartesian, kpc. The
 * Local Group catalogue ships Cartesian columns already; this exists so they can be
 * checked rather than trusted.
 */
export function galacticSphericalToCartesian(lDeg: number, bDeg: number, distanceKpc: number): HeliocentricGalacticKpc {
  const l = lDeg * DEG
  const b = bDeg * DEG
  const cosB = Math.cos(b)
  return {
    x: distanceKpc * cosB * Math.cos(l),
    y: distanceKpc * cosB * Math.sin(l),
    z: distanceKpc * Math.sin(b),
  }
}

/**
 * Angular diameter to a physical radius, in kpc. Used to size the Local Group galaxies
 * from their catalogued D25 major axis instead of inventing a radius for them.
 */
export function angularDiameterToRadiusKpc(majorAxisArcmin: number, distanceKpc: number): number {
  const halfAngleRad = ((majorAxisArcmin / 60) * DEG) / 2
  return distanceKpc * Math.tan(halfAngleRad)
}
