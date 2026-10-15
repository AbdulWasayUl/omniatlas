import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PLANCK18,
  Z_LAST_SCATTERING,
  angularDiameterDistanceMpc,
  clearCosmologyCaches,
  comovingDistanceMpc,
  distanceModulusErrorFactor,
  distanceModulusToMpc,
  hubbleDistanceMpc,
  hubbleLawDistanceMpc,
  hubbleTimeGyr,
  lookbackTimeGyr,
  luminosityDistanceMpc,
  mpcToDistanceModulus,
  particleHorizonMpc,
  redshiftForComovingDistanceMpc,
  redshiftFromCzKmS,
} from '../../src/astronomy/cosmology'

/**
 * References for every number asserted here.
 *
 * [P18]  Planck Collaboration, Aghanim N. et al. 2020, A&A 641, A6 ("Planck 2018
 *        results VI"), base-LCDM TT,TE,EE+lowE+lensing. Age = 13.787 +/- 0.020 Gyr;
 *        comoving angular-diameter distance to last scattering D_M(z*) = 13869.6 Mpc
 *        at z* = 1089.92.
 * [JSON] public/data/universe/cosmology.json — the frozen parameter file the data
 *        build used. Its derived block quotes c/H0 = 4448 Mpc, 1/H0 = 14.507 Gyr,
 *        D_C(1089) = 13864.7 Mpc, lookback(1089) = 13.78662 Gyr and a particle horizon
 *        of 14145.3 Mpc. Asserting against it is what stops the renderer's cosmology
 *        and the data build's cosmology from silently diverging.
 * [REF]  `referenceComovingMpc` / `referenceLookbackGyr` below: an INDEPENDENT
 *        implementation of Hogg (1999, astro-ph/9905116) eqs. 15 and 30, integrated
 *        in z on a segmented grid with 240,000 intervals, deliberately written in a
 *        different variable from the production code (which substitutes u = ln(1+z)).
 *        Agreement between the two is a real check: a wrong substitution, a wrong
 *        Jacobian or a wrong Simpson weighting shows up immediately.
 *
 * The z = 0.01, 0.1, 1 and 3 expectations are [REF] values, quoted to the precision
 * at which the two independent integrations agree. They are NOT copied from a
 * published table — the published anchors in this file are the z = 1089 ones, which
 * are the only values Planck 2018 actually tabulates.
 */

const C_KM_S = 299792.458

function eOfZ(z: number): number {
  const a = 1 + z
  return Math.sqrt(
    PLANCK18.OmegaR * a ** 4 + PLANCK18.OmegaM * a ** 3 + PLANCK18.OmegaK * a ** 2 + PLANCK18.OmegaLambda,
  )
}

/** Composite Simpson in z over [a, b]. */
function simpson(f: (z: number) => number, a: number, b: number, n: number): number {
  const h = (b - a) / n
  let sum = f(a) + f(b)
  for (let i = 1; i < n; i++) sum += f(a + i * h) * ((i & 1) === 1 ? 4 : 2)
  return (sum * h) / 3
}

/**
 * Segmented so that the near-z structure is resolved without spending samples in the
 * matter era where the integrand is already tiny. Integrating in z on a single uniform
 * grid is exactly the mistake the production code avoids; doing it here, differently,
 * is the point.
 */
function segmentedIntegral(f: (z: number) => number, z: number): number {
  const edges = [0, 0.05, 0.5, 2, 10, 100, 1200, 1e9].filter((e) => e < z)
  edges.push(z)
  let total = 0
  for (let i = 0; i < edges.length - 1; i++) total += simpson(f, edges[i], edges[i + 1], 30_000)
  return total
}

function referenceComovingMpc(z: number): number {
  return (C_KM_S / PLANCK18.H0) * segmentedIntegral((zz) => 1 / eOfZ(zz), z)
}

function referenceLookbackGyr(z: number): number {
  const kmPerMpc = 3.085677581491367e19
  const secondsPerGyr = 31_557_600 * 1e9
  const hubbleTime = kmPerMpc / PLANCK18.H0 / secondsPerGyr
  return hubbleTime * segmentedIntegral((zz) => 1 / ((1 + zz) * eOfZ(zz)), z)
}

const FROZEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../public/data/universe/cosmology.json', import.meta.url)), 'utf8'),
) as {
  parameters: Record<string, { value: number }>
  lastScattering: { z: number; comovingDistanceMpc: number; lookbackTimeGyr: number; publishedPlanckValueMpc: number }
  particleHorizon: { comovingDistanceMpc: number }
  derived: { hubbleDistanceMpc: number; hubbleTimeGyr: number; speedOfLightKmS: number }
}

describe('frozen parameters', () => {
  it('matches public/data/universe/cosmology.json exactly [JSON]', () => {
    expect(PLANCK18.H0).toBe(FROZEN.parameters.H0.value)
    expect(PLANCK18.OmegaM).toBe(FROZEN.parameters.OmegaM.value)
    expect(PLANCK18.OmegaLambda).toBe(FROZEN.parameters.OmegaLambda.value)
    expect(PLANCK18.OmegaK).toBe(FROZEN.parameters.OmegaK.value)
    expect(PLANCK18.OmegaR).toBe(FROZEN.parameters.OmegaR.value)
    expect(PLANCK18.ageGyr).toBe(FROZEN.parameters.ageGyr.value)
    expect(PLANCK18.TcmbK).toBe(FROZEN.parameters.TcmbK.value)
    expect(Z_LAST_SCATTERING).toBe(FROZEN.lastScattering.z)
  })

  it('is flat to the precision the model claims', () => {
    expect(PLANCK18.OmegaM + PLANCK18.OmegaLambda + PLANCK18.OmegaK).toBeCloseTo(1, 10)
  })

  it('derives the Hubble distance and time [JSON]', () => {
    expect(hubbleDistanceMpc()).toBeCloseTo(FROZEN.derived.hubbleDistanceMpc, 0)
    expect(hubbleTimeGyr()).toBeCloseTo(FROZEN.derived.hubbleTimeGyr, 2)
  })
})

describe('distanceModulusToMpc', () => {
  // mu = 25 is the definition point: d_L = 1 Mpc. The Virgo and LMC values are the
  // textbook worked examples of the transform, not measurements asserted here.
  it('maps mu = 25 to exactly 1 Mpc', () => {
    expect(distanceModulusToMpc(25)).toBeCloseTo(1, 12)
  })

  it('maps mu = 30 to 10 Mpc and mu = 18.5 to the LMC 50 kpc', () => {
    expect(distanceModulusToMpc(30)).toBeCloseTo(10, 10)
    expect(distanceModulusToMpc(18.5)).toBeCloseTo(0.0501187, 6)
  })

  it('round-trips against mpcToDistanceModulus', () => {
    for (const d of [0.05, 1, 16.2, 100, 772.7]) {
      expect(mpcToDistanceModulus(distanceModulusToMpc(mpcToDistanceModulus(d)))).toBeCloseTo(
        mpcToDistanceModulus(d),
        10,
      )
      expect(distanceModulusToMpc(mpcToDistanceModulus(d))).toBeCloseTo(d, 8)
    }
  })

  it('turns a modulus error into a multiplicative distance factor', () => {
    // A 0.4 mag error is a factor 1.2023 in distance — asymmetric about the mean,
    // which is why Cosmicflows-4 groups are drawn as smears and not as dots.
    expect(distanceModulusErrorFactor(0.4)).toBeCloseTo(1.202264, 6)
    expect(distanceModulusErrorFactor(0)).toBe(1)
  })
})

describe('comovingDistanceMpc', () => {
  // [REF] values; see the header. Quoted to 0.01 Mpc, the precision at which the
  // u-substituted production integral and the z-space reference integral agree.
  const cases: { z: number; expected: number }[] = [
    { z: 0.01, expected: 44.372 },
    { z: 0.1, expected: 434.088 },
    { z: 1, expected: 3400.84 },
    { z: 3, expected: 6504.478 },
    { z: 1089, expected: 13864.49 },
  ]

  for (const { z, expected } of cases) {
    it(`z = ${z} [REF]`, () => {
      const value = comovingDistanceMpc(z)
      expect(value / expected).toBeCloseTo(1, 4)
      expect(value / referenceComovingMpc(z)).toBeCloseTo(1, 6)
    })
  }

  it('reduces to cz/H0 at low redshift', () => {
    // The Hubble law is the z -> 0 limit of the integral; at z = 0.01 the two differ
    // by 0.24%, which is the first-order deceleration term and not an error.
    const z = 0.01
    expect(comovingDistanceMpc(z) / hubbleLawDistanceMpc(z * C_KM_S)).toBeCloseTo(1, 2)
  })

  it('reaches the surface of last scattering [P18] [JSON]', () => {
    const value = comovingDistanceMpc(Z_LAST_SCATTERING)
    // Against the frozen data build: must agree to a part in 1e4.
    expect(value / FROZEN.lastScattering.comovingDistanceMpc).toBeCloseTo(1, 4)
    // Against Planck's own published D_M(z*) = 13869.6 Mpc: agreement is 0.04%.
    // It is not exact and should not be — Planck's value comes from a Boltzmann code
    // with massive neutrinos, this is the base-LCDM integral with massless ones.
    expect(Math.abs(value / FROZEN.lastScattering.publishedPlanckValueMpc - 1)).toBeLessThan(0.001)
  })

  it('gives the particle horizon, which is larger than the CMB shell [JSON]', () => {
    const horizon = particleHorizonMpc()
    expect(horizon / FROZEN.particleHorizon.comovingDistanceMpc).toBeCloseTo(1, 4)
    expect(horizon).toBeGreaterThan(comovingDistanceMpc(Z_LAST_SCATTERING))
  })

  it('is monotonic, zero at z = 0 and safe on bad input', () => {
    expect(comovingDistanceMpc(0)).toBe(0)
    expect(comovingDistanceMpc(-1)).toBe(0)
    expect(comovingDistanceMpc(Number.NaN)).toBe(0)
    let previous = 0
    for (let z = 0.01; z < 20; z *= 1.3) {
      const value = comovingDistanceMpc(z)
      expect(value).toBeGreaterThan(previous)
      previous = value
    }
  })

  it('memoises without changing the answer', () => {
    clearCosmologyCaches()
    const cold = comovingDistanceMpc(2.5)
    const warm = comovingDistanceMpc(2.5)
    expect(warm).toBe(cold)
    clearCosmologyCaches()
    expect(comovingDistanceMpc(2.5)).toBe(cold)
  })
})

describe('luminosity and angular-diameter distances', () => {
  it('bracket the comoving distance by (1+z)', () => {
    for (const z of [0.01, 0.1, 1, 3]) {
      const dc = comovingDistanceMpc(z)
      expect(luminosityDistanceMpc(z)).toBeCloseTo(dc * (1 + z), 6)
      expect(angularDiameterDistanceMpc(z)).toBeCloseTo(dc / (1 + z), 6)
    }
  })

  it('reproduces the angular-diameter turnover near z ~ 1.6', () => {
    // A genuine, counter-intuitive prediction: beyond z ~ 1.6 objects start looking
    // BIGGER again. If the integral were wrong this maximum would move.
    let best = 0
    let bestZ = 0
    for (let z = 0.2; z < 5; z += 0.01) {
      const value = angularDiameterDistanceMpc(z)
      if (value > best) {
        best = value
        bestZ = z
      }
    }
    expect(bestZ).toBeGreaterThan(1.4)
    expect(bestZ).toBeLessThan(1.8)
  })
})

describe('lookbackTimeGyr', () => {
  // [REF] values, as above.
  const cases: { z: number; expected: number }[] = [
    { z: 0.01, expected: 0.144005 },
    { z: 0.1, expected: 1.349939 },
    { z: 1, expected: 7.949705 },
    { z: 3, expected: 11.652004 },
    { z: 1089, expected: 13.790084 },
  ]

  for (const { z, expected } of cases) {
    it(`z = ${z} [REF]`, () => {
      const value = lookbackTimeGyr(z)
      expect(value / expected).toBeCloseTo(1, 4)
      expect(value / referenceLookbackGyr(z)).toBeCloseTo(1, 6)
    })
  }

  it('approaches the published age of the universe at last scattering [P18]', () => {
    // 13.790 Gyr computed here against 13.787 Gyr published: 0.02%, again the
    // massless-neutrino approximation. Close enough to be the same number in the UI,
    // and the discrepancy is stated rather than hidden.
    const value = lookbackTimeGyr(Z_LAST_SCATTERING)
    expect(Math.abs(value / PLANCK18.ageGyr - 1)).toBeLessThan(0.001)
    expect(value / FROZEN.lastScattering.lookbackTimeGyr).toBeCloseTo(1, 3)
  })

  it('is never longer than the age of the universe', () => {
    for (const z of [0.1, 1, 10, 100, 1089, 1e6]) {
      expect(lookbackTimeGyr(z)).toBeLessThan(PLANCK18.ageGyr * 1.01)
    }
  })

  it('is not the comoving distance divided by c', () => {
    // At z = 1 the light-travel time is 7.95 Gyr but the comoving distance is
    // 11.09 Gly. Conflating them is the single most common extragalactic error.
    const lightTravelGly = lookbackTimeGyr(1) * 1e9 * 9.4607304725808e15 // metres
    const comovingGly = comovingDistanceMpc(1) * 3.085677581491367e22 // metres
    expect(comovingGly / lightTravelGly).toBeGreaterThan(1.3)
  })
})

describe('redshift helpers', () => {
  it('converts cz to z', () => {
    expect(redshiftFromCzKmS(29_979.2458)).toBeCloseTo(0.1, 12)
    expect(redshiftFromCzKmS(0)).toBe(0)
  })

  it('inverts the comoving distance', () => {
    for (const z of [0.01, 0.1, 1, 3, 1089]) {
      expect(redshiftForComovingDistanceMpc(comovingDistanceMpc(z))).toBeCloseTo(z, 4)
    }
    expect(redshiftForComovingDistanceMpc(0)).toBe(0)
  })
})
