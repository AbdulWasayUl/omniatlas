import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  ARM_WIDTH_GRADIENT_KPC_PER_KPC,
  type ArmFit,
  type ArmModelFile,
  MAJOR_ARM_IDS,
  R0_KPC,
  armRadiusAtBetaKpc,
  armRadiusKpc,
  armWidthKpc,
  distanceToArmKpc,
  galacticSphericalToCartesian,
  galactocentricFromBeta,
  galactocentricToHeliocentric,
  galactocentricToSceneOffsetKpc,
  heliocentricToGalactocentric,
  meanPitchDeg,
  sampleArmRidge,
  sunGalactocentricKpc,
  sunGalactocentricRadiusKpc,
} from '../../src/astronomy/galaxy'

const DATA = resolve(__dirname, '../../public/data/galaxy')

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(DATA, name), 'utf8')) as T
}

const armsFile = readJson<ArmModelFile & { frame: { R0Kpc: number; sunPositionKpc: number[] } }>('arms.json')
const arms = armsFile.arms
const armById = new Map(arms.map((arm) => [arm.id, arm]))

interface Maser {
  name: string
  lDeg: number
  bDeg: number
  distKpc: number
  eDistKpc: number
  armCode: string | null
  armFit: string | null
  xKpc: number
  yKpc: number
  zKpc: number
  rGalKpc: number
  betaDeg: number
}

const masersFile = readJson<{ kind: string; masers: Maser[] }>('masers.json')

describe('the Sun sits at the published R0', () => {
  it('is 8.15 kpc from the Galactic centre', () => {
    // The single most asked question at this scale, and the number every other
    // galactocentric coordinate in the module is measured against.
    expect(sunGalactocentricRadiusKpc()).toBeCloseTo(8.15, 3)
    expect(R0_KPC).toBe(armsFile.frame.R0Kpc)
  })

  it('agrees with the value the arm fits were themselves derived under', () => {
    const [x, y, z] = armsFile.frame.sunPositionKpc
    const sun = sunGalactocentricKpc()
    expect(sun.x).toBeCloseTo(x, 6)
    expect(sun.y).toBeCloseTo(y, 6)
    expect(sun.z).toBeCloseTo(z, 6)
  })

  it('places the Sun 8.15 kpc from the centre in the render basis too', () => {
    // The scene-basis offset is what actually reaches a vertex buffer, so its length
    // has to survive the axis permutation. If it does not, the Galaxy is drawn rotated.
    const [sx, sy, sz] = galactocentricToSceneOffsetKpc(sunGalactocentricKpc())
    expect(Math.hypot(sx, sy, sz)).toBeCloseTo(8.15, 3)
  })
})

describe('arm pitch angles', () => {
  it('puts every grand-design arm in the 9-14 degree range', () => {
    for (const id of MAJOR_ARM_IDS) {
      const arm = armById.get(id)
      expect(arm, `arms.json is missing ${id}`).toBeDefined()
      const pitch = meanPitchDeg(arm as ArmFit)
      expect(pitch, `${id} mean pitch ${pitch}`).toBeGreaterThanOrEqual(9)
      expect(pitch, `${id} mean pitch ${pitch}`).toBeLessThanOrEqual(14)
    }
  })

  it('keeps the whole-Galaxy mean pitch inside the published band', () => {
    const pitches = MAJOR_ARM_IDS.flatMap((id) => {
      const arm = armById.get(id) as ArmFit
      return [arm.pitchLowDeg, arm.pitchHighDeg]
    })
    const mean = pitches.reduce((a, b) => a + b, 0) / pitches.length
    expect(mean).toBeGreaterThanOrEqual(9)
    expect(mean).toBeLessThanOrEqual(14)
  })

  it('does NOT claim 9-14 degrees for the bar features, which wind the other way', () => {
    // Honesty guard rather than a convenience. Reid+2019 fits a negative pitch to the
    // 3-kpc arm and to the inner Norma segment; a test that asserted 9-14 across every
    // row of arms.json would be asserting something the paper does not say, and would
    // have to be made to pass by quietly dropping the awkward arms.
    expect(meanPitchDeg(armById.get('3kpc-near') as ArmFit)).toBeLessThan(0)
    expect((armById.get('norma') as ArmFit).pitchLowDeg).toBeLessThan(0)
    // Individual fitted segments of the major arms do leave the band in both directions
    // (Scutum's inner pitch is 14.1, Perseus's outer is 8.7, Carina's outer is 1.0).
    expect((armById.get('scutum-centaurus') as ArmFit).pitchLowDeg).toBeGreaterThan(14)
    expect((armById.get('perseus') as ArmFit).pitchHighDeg).toBeLessThan(9)
  })
})

describe('the log-periodic spiral', () => {
  it('returns the reference radius at the reference azimuth', () => {
    for (const arm of arms) {
      for (const segment of arm.segments) {
        expect(armRadiusKpc(segment, segment.betaRefDeg)).toBeCloseTo(segment.rRefKpc, 10)
      }
    }
  })

  it('reproduces the sampled radii the dataset publishes for each arm', () => {
    // The sample block in arms.json was computed by the build script from the same
    // fits. Agreeing with it to four decimals means the formula, the degree-to-radian
    // handling and the sign convention are all the ones the data assumes.
    for (const arm of arms as (ArmFit & { sample?: Record<string, number> })[]) {
      const sample = arm.sample
      if (!sample) continue
      const [drawMin, drawMax] = arm.betaDrawRangeDeg
      const [dataMin, dataMax] = arm.betaDataRangeDeg
      if (arm.id !== 'sagittarius-carina') {
        expect(armRadiusAtBetaKpc(arm, drawMin), `${arm.id} at draw min`).toBeCloseTo(sample.rAtDrawMinKpc, 3)
      }
      expect(armRadiusAtBetaKpc(arm, drawMax), `${arm.id} at draw max`).toBeCloseTo(sample.rAtDrawMaxKpc, 3)
      expect(armRadiusAtBetaKpc(arm, dataMin), `${arm.id} at data min`).toBeCloseTo(sample.rAtDataMinKpc, 3)
      expect(armRadiusAtBetaKpc(arm, dataMax), `${arm.id} at data max`).toBeCloseTo(sample.rAtDataMaxKpc, 3)
    }
  })

  it('documents the one place arms.json disagrees with itself', () => {
    // 27 of the 28 published sample radii reproduce exactly. The 28th does not, and
    // pinning it here is the point: Sagittarius-Carina's `segments` array carries the
    // extra inner segment Reid+2019 Sect. 5.3 describes ("we decrease the pitch angle
    // to 10 deg ... to match the CO (l-v) trace of the Carina arm"), while the file's
    // own `sample.rAtDrawMinKpc` was evaluated as if that segment did not exist, i.e.
    // by extrapolating the 17.1 deg fit all the way down to beta = -110.
    //
    // The renderer follows `segments`, because that is the curve the paper's text
    // describes and the one the field binary was sampled from. If a future rebuild of
    // the dataset fixes the sample block, this test fails and the note can be deleted.
    const carina = armById.get('sagittarius-carina') as ArmFit & { sample: Record<string, number> }
    const atDrawMin = armRadiusAtBetaKpc(carina, carina.betaDrawRangeDeg[0])
    expect(atDrawMin).toBeCloseTo(10.396, 2)
    expect(carina.sample.rAtDrawMinKpc).toBeCloseTo(12.4025, 3)
    // Both curves agree from the point the hand-set segment ends onward.
    expect(armRadiusAtBetaKpc(carina, -33)).toBeCloseTo(8.2026, 3)
  })

  it('stays continuous across the kink where the pitch angle changes', () => {
    for (const arm of arms) {
      const below = armRadiusAtBetaKpc(arm, arm.betaKinkDeg - 1e-6)
      const above = armRadiusAtBetaKpc(arm, arm.betaKinkDeg + 1e-6)
      expect(Math.abs(below - above)).toBeLessThan(1e-6)
      expect(below).toBeCloseTo(arm.rKinkKpc, 6)
    }
  })

  it('widens outward at the fitted 42 pc per kpc', () => {
    const outer = armById.get('outer') as ArmFit
    const atKink = armWidthKpc(outer, outer.rKinkKpc)
    const oneKpcOut = armWidthKpc(outer, outer.rKinkKpc + 1)
    expect(atKink).toBeCloseTo(outer.widthKpc, 10)
    expect(oneKpcOut - atKink).toBeCloseTo(ARM_WIDTH_GRADIENT_KPC_PER_KPC, 10)
  })

  it('samples a ridge line with an orthonormal in-plane frame', () => {
    const samples = sampleArmRidge(armById.get('perseus') as ArmFit, 64)
    expect(samples).toHaveLength(64)
    for (const sample of samples) {
      expect(Math.hypot(sample.tangent.x, sample.tangent.y)).toBeCloseTo(1, 9)
      expect(sample.tangent.x * sample.normal.x + sample.tangent.y * sample.normal.y).toBeCloseTo(0, 9)
      expect(Math.hypot(sample.position.x, sample.position.y)).toBeCloseTo(sample.rKpc, 9)
    }
    expect(samples.some((s) => s.extrapolated)).toBe(true)
    expect(samples.some((s) => !s.extrapolated)).toBe(true)
  })
})

describe('frame conversions', () => {
  it('round-trips galactocentric to heliocentric and back', () => {
    const point = { x: -3.1, y: 11.4, z: 0.07 }
    const back = heliocentricToGalactocentric(galactocentricToHeliocentric(point))
    expect(back.x).toBeCloseTo(point.x, 12)
    expect(back.y).toBeCloseTo(point.y, 12)
    expect(back.z).toBeCloseTo(point.z, 12)
  })

  it('puts the Galactic centre 8.15 kpc away in the direction of l = 0', () => {
    const helio = galactocentricToHeliocentric({ x: 0, y: 0, z: 0 })
    expect(helio.x).toBeCloseTo(8.15, 9)
    expect(helio.y).toBeCloseTo(0, 9)
    expect(helio.z).toBeCloseTo(-0.0055, 9)
  })

  it('reproduces every published maser Cartesian from its (l, b, distance)', () => {
    // 199 independent checks of the conversion against a column the catalogue computed
    // separately. This is the decode verification rule 6 asks for: a sign error or an
    // axis swap would still look like a galaxy, and would fail here immediately.
    let worst = 0
    let worstName = ''
    for (const maser of masersFile.masers) {
      const helio = galacticSphericalToCartesian(maser.lDeg, maser.bDeg, maser.distKpc)
      const gal = heliocentricToGalactocentric(helio)
      const error = Math.hypot(gal.x - maser.xKpc, gal.y - maser.yKpc, gal.z - maser.zKpc)
      if (error > worst) {
        worst = error
        worstName = maser.name
      }
    }
    expect(worst, `worst offender: ${worstName}`).toBeLessThan(0.001)
  })

  it('agrees with the published galactocentric azimuth and radius', () => {
    for (const maser of masersFile.masers.slice(0, 40)) {
      const point = { x: maser.xKpc, y: maser.yKpc, z: maser.zKpc }
      expect(Math.hypot(point.x, point.y)).toBeCloseTo(maser.rGalKpc, 2)
      expect(galactocentricFromBeta(maser.betaDeg, maser.rGalKpc).x).toBeCloseTo(point.x, 2)
    }
  })
})

describe('the model against the measurements it was fitted to', () => {
  it('puts most arm-assigned masers within a kiloparsec of their fitted ridge', () => {
    // The whole justification for drawing the arms is that these ~200 points constrain
    // them. If the curves did not actually pass through the masers, the pairing the
    // renderer presents would be a lie.
    const offsets: number[] = []
    for (const maser of masersFile.masers) {
      if (!maser.armFit) continue
      const arm = armById.get(maser.armFit)
      if (!arm) continue
      offsets.push(distanceToArmKpc(arm, { x: maser.xKpc, y: maser.yKpc, z: maser.zKpc }, 400))
    }
    expect(offsets.length).toBeGreaterThan(100)
    offsets.sort((a, b) => a - b)
    const median = offsets[Math.floor(offsets.length / 2)]
    expect(median).toBeLessThan(0.5)
    const within1Kpc = offsets.filter((d) => d < 1).length / offsets.length
    expect(within1Kpc).toBeGreaterThan(0.8)
  })
})

describe('the disc field binary decodes as struct-of-arrays', () => {
  const manifest = readJson<{
    recordCount: number
    fields: { name: string; byteOffset: number; dtype: string }[]
    extent: { maxCylindricalRadiusPc: number; maxAbsZPc: number }
    frame: { sunPositionPc: number[] }
    colour: { palette: number[][] }
  }>('field.json')

  const bytes = readFileSync(resolve(DATA, 'field.bin'))
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const count = manifest.recordCount
  const offset = (name: string) => manifest.fields.find((f) => f.name === name)!.byteOffset
  const x = new Float32Array(buffer, offset('x'), count)
  const y = new Float32Array(buffer, offset('y'), count)
  const z = new Float32Array(buffer, offset('z'), count)
  const colourIndex = new Uint8Array(buffer, offset('colourIndex'), count)

  it('holds the advertised number of records', () => {
    expect(bytes.byteLength).toBe(count * 13)
    expect(manifest.colour.palette).toHaveLength(256)
  })

  it('reproduces the extent the manifest publishes', () => {
    let maxR = 0
    let maxAbsZ = 0
    for (let i = 0; i < count; i++) {
      const r = Math.hypot(x[i], y[i])
      if (r > maxR) maxR = r
      const az = Math.abs(z[i])
      if (az > maxAbsZ) maxAbsZ = az
    }
    // Read as interleaved triples instead of struct-of-arrays, these two numbers come
    // out wrong by orders of magnitude, which is the cheapest possible decode check.
    expect(maxR).toBeLessThanOrEqual(manifest.extent.maxCylindricalRadiusPc + 1)
    expect(maxR).toBeGreaterThan(manifest.extent.maxCylindricalRadiusPc - 1)
    expect(maxAbsZ).toBeLessThanOrEqual(manifest.extent.maxAbsZPc + 1)
  })

  it('is a disc: far wider than it is thick, and centred on the Galactic centre', () => {
    let sumX = 0
    let sumY = 0
    let sumZ = 0
    let sumR = 0
    let sumAbsZ = 0
    for (let i = 0; i < count; i++) {
      sumX += x[i]
      sumY += y[i]
      sumZ += z[i]
      sumR += Math.hypot(x[i], y[i])
      sumAbsZ += Math.abs(z[i])
    }
    // The bar and the arms are not rotationally symmetric and the per-arm draw ranges
    // cover the Sun's side of the Galaxy more completely than the far side, so the
    // centroid sits about (0.5, 1.1) kpc off centre rather than on it. A struct-of-
    // arrays mis-decode moves it by eight kiloparsecs, which is what this is catching.
    expect(Math.abs(sumX / count)).toBeLessThan(2000)
    expect(Math.abs(sumY / count)).toBeLessThan(2000)
    expect(Math.abs(sumZ / count)).toBeLessThan(40)
    expect(sumR / count).toBeGreaterThan(2000)
    expect(sumR / count / (sumAbsZ / count)).toBeGreaterThan(8)
  })

  it('samples the solar neighbourhood, where we actually are', () => {
    const [sunX, sunY] = manifest.frame.sunPositionPc
    let near = 0
    for (let i = 0; i < count; i++) {
      if (Math.hypot(x[i] - sunX, y[i] - sunY, z[i]) < 500) near++
    }
    expect(near).toBeGreaterThan(50)
  })

  it('colours the bulge redder than the arms', () => {
    // colourIndex is a log-uniform temperature index; the age/metallicity gradient the
    // renderer leans on only exists if the inner Galaxy really is cooler here.
    let bulgeSum = 0
    let bulgeN = 0
    let outerSum = 0
    let outerN = 0
    for (let i = 0; i < count; i++) {
      const r = Math.hypot(x[i], y[i])
      if (r < 1000) {
        bulgeSum += colourIndex[i]
        bulgeN++
      } else if (r > 7000 && r < 12000) {
        outerSum += colourIndex[i]
        outerN++
      }
    }
    expect(bulgeN).toBeGreaterThan(1000)
    expect(outerN).toBeGreaterThan(1000)
    expect(bulgeSum / bulgeN).toBeLessThan(outerSum / outerN)
  })
})
