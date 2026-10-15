import { C_M_S, JULIAN_YEAR_S, MPC_M } from '../core/world'

/**
 * Cosmology: the transforms that let an extragalactic distance say what KIND of
 * distance it is.
 *
 * Past the Local Group "distance" stops being one thing. A distance modulus from a
 * Cepheid, a recession velocity divided by H0, and a comoving separation integrated
 * through a cosmology are three different numbers for the same galaxy, and they differ
 * by tens of percent by z ~ 0.1. Every extragalactic position in OmniAtlas is produced
 * by exactly one of the functions below, and whichever one produced it is recorded
 * alongside the position as a `DistanceKind`. That is the whole reason this file exists.
 *
 * Pure float64 arithmetic. No Three.js, no render units, no fetch — so it is unit
 * testable in node and cannot drift into the renderer.
 *
 * ## Parameters
 *
 * Planck Collaboration, Aghanim N. et al. 2020, A&A 641, A6 ("Planck 2018 results VI.
 * Cosmological parameters"), base-LCDM TT,TE,EE+lowE+lensing. The same values are
 * frozen in `public/data/universe/cosmology.json`; `tests/unit/cosmology.test.ts`
 * asserts that this file and that file agree, so the renderer and the data build
 * cannot drift apart.
 *
 * ## Integration
 *
 * The comoving-distance and lookback-time integrals are both taken in `u = ln(1 + z)`
 * rather than in z. In z, the integrand of D_C falls by three orders of magnitude
 * between z = 0 and z = 1089 and a uniform Simpson rule either misses the near-z
 * structure or needs absurd sample counts. In u the integrand is smooth and bounded
 * over the whole range (it tends to (1+z)^-1/2 / sqrt(Omega_m)), so a few thousand
 * samples reach the precision of the published values. Substituting dz = (1+z) du:
 *
 *     D_C = (c/H0) * Int_0^ln(1+z) (1+z) / E du
 *     t_L = (1/H0) * Int_0^ln(1+z)       1 / E du
 */

export interface CosmologyParameters {
  /** Hubble constant, km/s/Mpc. */
  H0: number
  /** Matter density parameter today. */
  OmegaM: number
  /** Dark-energy density parameter today. */
  OmegaLambda: number
  /** Curvature density parameter. Zero in base LCDM. */
  OmegaK: number
  /** Radiation (photons + 3 massless neutrinos). Negligible below z ~ 100, kept anyway. */
  OmegaR: number
  /** Published age of the universe, Gyr. Not recomputed from the integrals. */
  ageGyr: number
  /** CMB monopole temperature, K (Fixsen 2009). */
  TcmbK: number
}

/** Planck 2018 base-LCDM. Frozen; see the file header for the citation. */
export const PLANCK18: Readonly<CosmologyParameters> = Object.freeze({
  H0: 67.4,
  OmegaM: 0.315,
  OmegaLambda: 0.685,
  OmegaK: 0,
  OmegaR: 0.000091354,
  ageGyr: 13.787,
  TcmbK: 2.7255,
})

/** Redshift of recombination — the surface of last scattering. Planck 2018 VI. */
export const Z_LAST_SCATTERING = 1089.9

/** Speed of light, km/s. */
export const C_KM_S = C_M_S / 1000
/** Kilometres in a megaparsec, so H0's units cancel exactly. */
export const KM_PER_MPC = MPC_M / 1000
/** Seconds in a gigayear (Julian years, matching `JULIAN_YEAR_S`). */
export const SECONDS_PER_GYR = JULIAN_YEAR_S * 1e9

/** Hubble distance c/H0 in Mpc: the natural length scale of a cosmology. */
export function hubbleDistanceMpc(params: CosmologyParameters = PLANCK18): number {
  return C_KM_S / params.H0
}

/** Hubble time 1/H0 in Gyr. */
export function hubbleTimeGyr(params: CosmologyParameters = PLANCK18): number {
  return KM_PER_MPC / params.H0 / SECONDS_PER_GYR
}

/**
 * The dimensionless expansion rate E(z) = H(z)/H0, written in terms of the scale
 * factor ratio a = 1 + z because every call site already has that.
 */
export function expansionRateAt(onePlusZ: number, params: CosmologyParameters = PLANCK18): number {
  const a2 = onePlusZ * onePlusZ
  const a3 = a2 * onePlusZ
  return Math.sqrt(params.OmegaR * a3 * onePlusZ + params.OmegaM * a3 + params.OmegaK * a2 + params.OmegaLambda)
}

/** E(z), for callers that think in redshift. */
export function eOfZ(z: number, params: CosmologyParameters = PLANCK18): number {
  return expansionRateAt(1 + z, params)
}

// ---------------------------------------------------------------------------
// Distance modulus — the one transform that assumes no cosmology at all
// ---------------------------------------------------------------------------

/**
 * Luminosity distance in Mpc from a distance modulus, mu = m - M.
 *
 *     d_L = 10^(mu/5 - 5) Mpc
 *
 * No H0, no Omega, no expansion history: this is a photometric ratio and nothing else.
 * Wherever a catalogue ships a distance modulus (Cosmicflows-4, UNGC) this is the
 * transform to use, and the result is a `luminosity` distance, not a comoving one.
 */
export function distanceModulusToMpc(distanceModulus: number): number {
  return 10 ** (distanceModulus / 5 - 5)
}

/** The inverse: distance modulus from a luminosity distance in Mpc. */
export function mpcToDistanceModulus(distanceMpc: number): number {
  return 5 * Math.log10(Math.max(distanceMpc, 1e-12)) + 25
}

/**
 * The multiplicative distance factor implied by an uncertainty in distance modulus.
 *
 * A distance modulus error is multiplicative in distance, not additive: +/- e mag maps
 * to a distance interval [d / 10^(e/5), d * 10^(e/5)]. This asymmetry is why the
 * Cosmicflows-4 groups are drawn as radial smears rather than as error bars of equal
 * length on both sides.
 */
export function distanceModulusErrorFactor(errorMag: number): number {
  return 10 ** (errorMag / 5)
}

// ---------------------------------------------------------------------------
// Redshift
// ---------------------------------------------------------------------------

/** Redshift from a recession velocity in km/s, using the non-relativistic z = cz/c. */
export function redshiftFromCzKmS(czKmS: number): number {
  return czKmS / C_KM_S
}

/**
 * The low-redshift Hubble-law distance, d = cz / H0.
 *
 * Accurate to better than ~5% below z ~ 0.1, which covers essentially all of 2MRS.
 * The number it returns is a REDSHIFT distance: it contains the galaxy's peculiar
 * velocity as well as the expansion, and in a cluster that error is thousands of km/s.
 */
export function hubbleLawDistanceMpc(czKmS: number, params: CosmologyParameters = PLANCK18): number {
  return czKmS / params.H0
}

// ---------------------------------------------------------------------------
// Integrals
// ---------------------------------------------------------------------------

/**
 * Composite Simpson over u = ln(1 + z), with the sample count scaled to the range.
 * 420 samples per unit of u puts the z = 1089 case at ~2900 intervals, which agrees
 * with a 200,000-interval reference integration to better than 1e-9 relative.
 */
function integrateInLogZ(integrand: (onePlusZ: number) => number, z: number): number {
  const upper = Math.log1p(z)
  if (!(upper > 0)) return 0
  let n = Math.ceil(upper * 420)
  if (n < 64) n = 64
  if (n > 8192) n = 8192
  if (n % 2 === 1) n += 1

  const h = upper / n
  let sum = integrand(1) + integrand(Math.exp(upper))
  for (let i = 1; i < n; i++) {
    const value = integrand(Math.exp(i * h))
    sum += (i & 1) === 1 ? 4 * value : 2 * value
  }
  return (sum * h) / 3
}

/**
 * Memoisation.
 *
 * The extragalactic module converts tens of thousands of redshifts, and the integral
 * costs a few thousand `exp` and `sqrt` calls each time. Callers that work over a
 * catalogue quantise z before calling (a 1e-5 step is a 0.003% distance error at
 * z = 0.1, far below the peculiar-velocity error already in the number), which
 * collapses 44,000 calls to a few thousand distinct keys. The cache is cleared wholesale
 * rather than evicted one entry at a time: these are pure functions of z, so losing
 * the table costs time and nothing else.
 */
const CACHE_LIMIT = 16384
const comovingCache = new Map<number, number>()
const lookbackCache = new Map<number, number>()

/**
 * Line-of-sight comoving distance in Mpc (Hogg 1999, eq. 15).
 *
 *     D_C = (c/H0) Int_0^z dz' / E(z')
 *
 * This is a present-day separation inferred from a cosmological model. It is a
 * `comoving` distance and must never be presented as a measured one.
 */
export function comovingDistanceMpc(z: number, params: CosmologyParameters = PLANCK18): number {
  if (!Number.isFinite(z) || z <= 0) return 0
  const cacheable = params === PLANCK18
  if (cacheable) {
    const hit = comovingCache.get(z)
    if (hit !== undefined) return hit
  }
  const value = hubbleDistanceMpc(params) * integrateInLogZ((a) => a / expansionRateAt(a, params), z)
  if (cacheable) {
    if (comovingCache.size >= CACHE_LIMIT) comovingCache.clear()
    comovingCache.set(z, value)
  }
  return value
}

/** Luminosity distance, flat universe: d_L = (1 + z) D_C. */
export function luminosityDistanceMpc(z: number, params: CosmologyParameters = PLANCK18): number {
  return (1 + z) * comovingDistanceMpc(z, params)
}

/** Angular-diameter distance, flat universe: d_A = D_C / (1 + z). */
export function angularDiameterDistanceMpc(z: number, params: CosmologyParameters = PLANCK18): number {
  return comovingDistanceMpc(z, params) / (1 + z)
}

/**
 * Lookback time in Gyr: how long the light has been travelling.
 *
 *     t_L = (1/H0) Int_0^z dz' / ((1+z') E(z'))
 *
 * This is the number a person actually means by "how far back am I looking", and it is
 * NOT the comoving distance divided by c — at z = 1 those differ by a factor of 1.4.
 */
export function lookbackTimeGyr(z: number, params: CosmologyParameters = PLANCK18): number {
  if (!Number.isFinite(z) || z <= 0) return 0
  const cacheable = params === PLANCK18
  if (cacheable) {
    const hit = lookbackCache.get(z)
    if (hit !== undefined) return hit
  }
  const value = hubbleTimeGyr(params) * integrateInLogZ((a) => 1 / expansionRateAt(a, params), z)
  if (cacheable) {
    if (lookbackCache.size >= CACHE_LIMIT) lookbackCache.clear()
    lookbackCache.set(z, value)
  }
  return value
}

/**
 * The comoving radius of the observable universe: the particle horizon, the distance
 * light could have crossed since t = 0.
 *
 * This — not the CMB shell — is the ~46 billion light year figure. Integrating to
 * z = 1e8 captures it to better than a part in 1e4; the remaining radiation-era
 * contribution scales as (1+z)^-1/2 and is around a thousandth of a Mpc.
 */
export function particleHorizonMpc(params: CosmologyParameters = PLANCK18): number {
  return comovingDistanceMpc(1e8, params)
}

/**
 * Invert the comoving distance: the redshift a comoving distance corresponds to.
 *
 * Bisection rather than a series, because the series inversions in the literature are
 * only good to z ~ 1 and the atlas goes to the CMB. D_C is strictly increasing in z,
 * so bisection cannot pick the wrong root.
 */
export function redshiftForComovingDistanceMpc(
  distanceMpc: number,
  params: CosmologyParameters = PLANCK18,
): number {
  if (!(distanceMpc > 0)) return 0
  let low = 0
  let high = 16
  while (comovingDistanceMpc(high, params) < distanceMpc && high < 1e8) high *= 4
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (low + high)
    if (comovingDistanceMpc(mid, params) < distanceMpc) low = mid
    else high = mid
  }
  return 0.5 * (low + high)
}

/** Drop both memo tables. Exposed for tests and for parameter changes. */
export function clearCosmologyCaches(): void {
  comovingCache.clear()
  lookbackCache.clear()
}
