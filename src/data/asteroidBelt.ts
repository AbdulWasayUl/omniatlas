import type { KeplerianElements } from '../astronomy/orbit'
import { AU_KM } from './constants'
import type { AtlasEntity } from './types'

export const ASTEROID_BELT_INNER_AU = 2.1
export const ASTEROID_BELT_OUTER_AU = 3.3
export const ASTEROID_BELT_INCLINATION_STD_DEG = 8
export const ASTEROID_COUNT = 4_500

const J2000 = new Date('2000-01-01T12:00:00Z')

export interface AsteroidParticle {
  radiusAu: number
  inclinationRad: number
  ascendingNodeRad: number
  initialAngleRad: number
  /** radians/day, derived from Kepler's third law for a circular approximation. */
  meanMotionRadPerDay: number
  scale: number
  colorMix: number
}

function mulberry32(seed: number) {
  return function random() {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function generateAsteroidField(count = ASTEROID_COUNT): AsteroidParticle[] {
  const random = mulberry32(1_337_042)
  const particles: AsteroidParticle[] = []
  const inclinationStdRad = THREE_deg2rad(ASTEROID_BELT_INCLINATION_STD_DEG)

  for (let index = 0; index < count; index += 1) {
    const radiusAu = ASTEROID_BELT_INNER_AU + random() * (ASTEROID_BELT_OUTER_AU - ASTEROID_BELT_INNER_AU)
    const gaussian = (random() + random() + random() + random() - 2) * 0.5
    const inclinationRad = gaussian * inclinationStdRad
    const meanMotionRadPerDay = (2 * Math.PI) / (365.25 * radiusAu ** 1.5)

    particles.push({
      radiusAu,
      inclinationRad,
      ascendingNodeRad: random() * Math.PI * 2,
      initialAngleRad: random() * Math.PI * 2,
      meanMotionRadPerDay,
      scale: 0.35 + random() * random() * 2.4,
      colorMix: random(),
    })
  }

  return particles
}

function THREE_deg2rad(deg: number) {
  return (deg * Math.PI) / 180
}

const JPL_SBDB = {
  label: 'JPL Small-Body Database',
  url: 'https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html',
}

interface NotableBodySeed {
  id: string
  name: string
  radiusKm: number
  semiMajorAxisAu: number
  eccentricity: number
  inclinationDeg: number
  periodYears: number
  description: string
  meanAnomalyDegAtEpoch: number
}

const NOTABLE_BODY_SEEDS: NotableBodySeed[] = [
  {
    id: 'ceres',
    name: 'Ceres',
    radiusKm: 469.7,
    semiMajorAxisAu: 2.7656,
    eccentricity: 0.0797,
    inclinationDeg: 10.59,
    periodYears: 4.6,
    meanAnomalyDegAtEpoch: 27,
    description:
      'The largest body in the main asteroid belt and its only dwarf planet, mapped in detail by NASA’s Dawn spacecraft (2015–2018).',
  },
  {
    id: 'vesta',
    name: 'Vesta',
    radiusKm: 262.7,
    semiMajorAxisAu: 2.3614,
    eccentricity: 0.0902,
    inclinationDeg: 7.14,
    periodYears: 3.63,
    meanAnomalyDegAtEpoch: 133,
    description:
      'The second most massive main-belt asteroid, a differentiated, basalt-crusted protoplanet visited by NASA’s Dawn mission (2011–2012).',
  },
  {
    id: 'pallas',
    name: 'Pallas',
    radiusKm: 256.5,
    semiMajorAxisAu: 2.7696,
    eccentricity: 0.2307,
    inclinationDeg: 34.93,
    periodYears: 4.61,
    meanAnomalyDegAtEpoch: 241,
    description:
      'The third-largest main-belt asteroid, notable for an unusually steep orbital inclination and eccentricity compared to most belt members.',
  },
  {
    id: 'hygiea',
    name: 'Hygiea',
    radiusKm: 203.6,
    semiMajorAxisAu: 3.151,
    eccentricity: 0.1067,
    inclinationDeg: 3.83,
    periodYears: 5.59,
    meanAnomalyDegAtEpoch: 312,
    description:
      'The fourth-largest main-belt object, orbiting in the outer belt and found by VLT imaging to be nearly spherical, making it a possible dwarf-planet candidate.',
  },
]

export const NOTABLE_SMALL_BODIES: AtlasEntity[] = NOTABLE_BODY_SEEDS.map((seed) => {
  const semiMajorAxisKm = seed.semiMajorAxisAu * AU_KM
  const elements: KeplerianElements = {
    semiMajorAxisKm,
    eccentricity: seed.eccentricity,
    inclinationDeg: seed.inclinationDeg,
    nodeDeg: 0,
    periapsisDeg: 0,
    meanAnomalyDegAtEpoch: seed.meanAnomalyDegAtEpoch,
    epoch: J2000,
    periodDays: seed.periodYears * 365.25,
  }

  return {
    id: seed.id,
    name: seed.name,
    eyebrow: 'Main asteroid belt',
    kind: 'dwarf-planet',
    bodyId: seed.id,
    parentId: 'sun',
    radiusKm: seed.radiusKm,
    semiMajorAxisAu: seed.semiMajorAxisAu,
    description: seed.description,
    facts: [
      { label: 'Mean radius', value: `${seed.radiusKm.toLocaleString()} km` },
      { label: 'Semi-major axis', value: `${seed.semiMajorAxisAu} AU` },
      { label: 'Orbital eccentricity', value: seed.eccentricity.toFixed(4) },
      { label: 'Orbital inclination', value: `${seed.inclinationDeg}°` },
      { label: 'Orbital period', value: `${seed.periodYears} years` },
    ],
    source: JPL_SBDB,
    elements,
  } satisfies AtlasEntity
})
