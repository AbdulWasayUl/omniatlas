import type { KeplerianElements } from '../astronomy/orbit'
import type { AtlasEntity } from './types'

export const EARTH_MOON: AtlasEntity = {
  id: 'moon',
  name: 'Moon',
  eyebrow: 'Natural satellite · Earth I',
  kind: 'moon',
  parentId: 'earth',
  bodyId: 'moon',
  engineBody: 'Moon',
  radiusKm: 1_737.5,
  textureUrl: '/textures/moon/lroc-color-4k.webp',
  description:
    'Earth’s only natural satellite. Its heavily cratered surface preserves evidence from the early Solar System. Color and relief are derived from LRO WAC and LOLA products, with full-precision current-time position and rotation.',
  facts: [
    { label: 'Mean radius', value: '1,737.5 km' },
    { label: 'Mean distance', value: '385,000 km' },
    { label: 'Mass', value: '7.34767 × 10²² kg' },
    { label: 'Surface gravity', value: '1.624 m/s²' },
    { label: 'Orbital period', value: '27.322 days' },
    { label: 'Reference frame', value: 'IAU_MOON (display)' },
  ],
  source: {
    label: 'NASA Earth–Moon comparison',
    url: 'https://science.nasa.gov/moon/by-the-numbers/',
  },
}

const NASA_FACT_SHEET = {
  label: 'JPL Solar System Dynamics · Planetary Satellite Mean Elements',
  url: 'https://ssd.jpl.nasa.gov/sats/elem/',
}

// JPL SSD osculating mean elements are tabulated at epoch 2000-01-01 12:00 TDB;
// the ~64s TDB/UTC offset is negligible for this foundation-milestone visualization.
const J2000 = new Date('2000-01-01T12:00:00Z')

function elements(
  semiMajorAxisKm: number,
  eccentricity: number,
  inclinationDeg: number,
  periodDays: number,
  nodeDeg: number,
  periapsisDeg: number,
  meanAnomalyDegAtEpoch: number,
): KeplerianElements {
  return {
    semiMajorAxisKm,
    eccentricity,
    inclinationDeg,
    nodeDeg,
    periapsisDeg,
    meanAnomalyDegAtEpoch,
    epoch: J2000,
    periodDays,
  }
}

interface MoonSeed {
  id: string
  parentId: string
  name: string
  eyebrow: string
  radiusKm: number
  orderIndex: number
  description: string
  facts: [string, string][]
  textureUrl?: string
  /**
   * Set when `textureUrl` is a partial mosaic, to the body's mean albedo colour.
   * Voyager 2 imaged one hemisphere of Titania and of Triton; the rest of each USGS
   * map is empty black and renders as a black ball without this.
   */
  unimagedFill?: string
  color: string
  source: 'jupiter-moons' | 'keplerian'
  elements?: KeplerianElements
}

const MOON_SEEDS: MoonSeed[] = [
  // Mars
  {
    id: 'phobos',
    parentId: 'mars',
    name: 'Phobos',
    eyebrow: 'Moon · Mars I',
    radiusKm: 11.08,
    orderIndex: 0,
    description:
      'The larger and inner of Mars’s two small moons, likely a captured asteroid. It orbits so close and fast that it rises in the west and sets in the east.',
    facts: [
      ['Mean radius', '11.08 km'],
      ['Semi-major axis', '9,375 km'],
      ['Orbital period', '0.319 days'],
      ['Origin', 'Likely captured asteroid'],
    ],
    textureUrl: '/textures/moons/phobos.webp',
    color: '#9c8a78',
    source: 'keplerian',
    elements: elements(9_375, 0.015, 1.1, 0.3187, 169.2, 216.3, 189.7),
  },
  {
    id: 'deimos',
    parentId: 'mars',
    name: 'Deimos',
    eyebrow: 'Moon · Mars II',
    radiusKm: 6.2,
    orderIndex: 1,
    description:
      'The smaller and outer of Mars’s two moons, a small, smooth, likely-captured asteroid orbiting well beyond Phobos.',
    facts: [
      ['Mean radius', '6.2 km'],
      ['Semi-major axis', '23,457 km'],
      ['Orbital period', '1.263 days'],
      ['Origin', 'Likely captured asteroid'],
    ],
    textureUrl: '/textures/moons/deimos.webp',
    color: '#a89686',
    source: 'keplerian',
    elements: elements(23_457, 0.0002, 1.8, 1.2625, 54.3, 0, 205),
  },
  // Jupiter — the four Galilean moons, propagated directly by astronomy-engine's JupiterMoons().
  {
    id: 'io',
    parentId: 'jupiter',
    name: 'Io',
    eyebrow: 'Moon · Jupiter I',
    radiusKm: 1_821.6,
    orderIndex: 0,
    description:
      'The innermost Galilean moon and the most volcanically active body in the Solar System, driven by tidal flexing from Jupiter and its neighboring moons.',
    facts: [
      ['Mean radius', '1,821.6 km'],
      ['Semi-major axis', '421,800 km'],
      ['Orbital period', '1.769 days'],
      ['Notable feature', 'Active sulfur volcanism'],
    ],
    textureUrl: '/textures/moons/io.webp',
    color: '#e7d27a',
    source: 'jupiter-moons',
  },
  {
    id: 'europa',
    parentId: 'jupiter',
    name: 'Europa',
    eyebrow: 'Moon · Jupiter II',
    radiusKm: 1_560.8,
    orderIndex: 1,
    description:
      'An ice-shelled Galilean moon that likely hides a global saltwater ocean beneath its cracked, relatively young surface. It is a leading target in the search for life.',
    facts: [
      ['Mean radius', '1,560.8 km'],
      ['Semi-major axis', '671,100 km'],
      ['Orbital period', '3.551 days'],
      ['Notable feature', 'Suspected subsurface ocean'],
    ],
    textureUrl: '/textures/moons/europa.webp',
    color: '#d8c9ad',
    source: 'jupiter-moons',
  },
  {
    id: 'ganymede',
    parentId: 'jupiter',
    name: 'Ganymede',
    eyebrow: 'Moon · Jupiter III',
    radiusKm: 2_634.1,
    orderIndex: 2,
    description:
      'The largest moon in the Solar System, bigger than Mercury, and the only moon known to generate its own magnetic field.',
    facts: [
      ['Mean radius', '2,634.1 km'],
      ['Semi-major axis', '1,070,400 km'],
      ['Orbital period', '7.155 days'],
      ['Notable feature', 'Has its own magnetosphere'],
    ],
    textureUrl: '/textures/moons/ganymede.webp',
    color: '#8f8578',
    source: 'jupiter-moons',
  },
  {
    id: 'callisto',
    parentId: 'jupiter',
    name: 'Callisto',
    eyebrow: 'Moon · Jupiter IV',
    radiusKm: 2_410.3,
    orderIndex: 3,
    description:
      'The outermost Galilean moon, an ancient, heavily cratered world thought to preserve one of the oldest surfaces in the Solar System.',
    facts: [
      ['Mean radius', '2,410.3 km'],
      ['Semi-major axis', '1,882,700 km'],
      ['Orbital period', '16.689 days'],
      ['Notable feature', 'Most heavily cratered body known'],
    ],
    textureUrl: '/textures/moons/callisto.jpg',
    color: '#6b6154',
    source: 'jupiter-moons',
  },
  // Saturn — the seven classical major moons.
  {
    id: 'mimas',
    parentId: 'saturn',
    name: 'Mimas',
    eyebrow: 'Moon · Saturn I',
    radiusKm: 198.2,
    orderIndex: 0,
    description:
      'The smallest and innermost of Saturn’s major moons, dominated by the huge impact crater Herschel, which gives it a “Death Star” silhouette.',
    facts: [
      ['Mean radius', '198.2 km'],
      ['Semi-major axis', '186,000 km'],
      ['Orbital period', '0.942 days'],
      ['Notable feature', 'Crater Herschel spans a third of its diameter'],
    ],
    color: '#d7dadc',
    source: 'keplerian',
    elements: elements(186_000, 0.02, 1.6, 0.942422, 66.2, 160.4, 275.3),
  },
  {
    id: 'enceladus',
    parentId: 'saturn',
    name: 'Enceladus',
    eyebrow: 'Moon · Saturn II',
    radiusKm: 252.1,
    orderIndex: 1,
    description:
      'A small, brilliantly bright icy moon whose south-polar geysers vent a subsurface ocean into space, feeding Saturn’s E ring.',
    facts: [
      ['Mean radius', '252.1 km'],
      ['Semi-major axis', '238,400 km'],
      ['Orbital period', '1.370 days'],
      ['Notable feature', 'Active south-polar cryovolcanism'],
    ],
    textureUrl: '/textures/moons/enceladus.jpg',
    color: '#eef3f5',
    source: 'keplerian',
    elements: elements(238_400, 0.005, 0, 1.370218, 0, 119.5, 57),
  },
  {
    id: 'tethys',
    parentId: 'saturn',
    name: 'Tethys',
    eyebrow: 'Moon · Saturn III',
    radiusKm: 531.1,
    orderIndex: 2,
    description:
      'An icy moon of very low density, scarred by the vast Ithaca Chasma canyon system and the large crater Odysseus.',
    facts: [
      ['Mean radius', '531.1 km'],
      ['Semi-major axis', '295,000 km'],
      ['Orbital period', '1.888 days'],
    ],
    color: '#dfe3e5',
    source: 'keplerian',
    elements: elements(295_000, 0.001, 1.1, 1.887802, 273, 335.3, 0),
  },
  {
    id: 'dione',
    parentId: 'saturn',
    name: 'Dione',
    eyebrow: 'Moon · Saturn IV',
    radiusKm: 561.4,
    orderIndex: 3,
    description: 'A mid-sized icy moon with wispy fracture terrain on its trailing hemisphere.',
    facts: [
      ['Mean radius', '561.4 km'],
      ['Semi-major axis', '377,700 km'],
      ['Orbital period', '2.737 days'],
    ],
    color: '#cdd3d6',
    source: 'keplerian',
    elements: elements(377_700, 0.002, 0, 2.736916, 0, 116, 212),
  },
  {
    id: 'rhea',
    parentId: 'saturn',
    name: 'Rhea',
    eyebrow: 'Moon · Saturn V',
    radiusKm: 763.5,
    orderIndex: 4,
    description: 'Saturn’s second-largest moon, a heavily cratered icy body with a possible tenuous ring of its own.',
    facts: [
      ['Mean radius', '763.5 km'],
      ['Semi-major axis', '527,200 km'],
      ['Orbital period', '4.518 days'],
    ],
    color: '#c3c9cc',
    source: 'keplerian',
    elements: elements(527_200, 0.001, 0.3, 4.517503, 133.7, 44.3, 31.5),
  },
  {
    id: 'titan',
    parentId: 'saturn',
    name: 'Titan',
    eyebrow: 'Moon · Saturn VI',
    radiusKm: 2_574.76,
    orderIndex: 5,
    description:
      'Saturn’s largest moon and the only moon with a dense atmosphere, plus stable surface lakes and seas of liquid methane and ethane.',
    facts: [
      ['Mean radius', '2,574.76 km'],
      ['Semi-major axis', '1,221,900 km'],
      ['Orbital period', '15.945 days'],
      ['Notable feature', 'Dense nitrogen-methane atmosphere'],
    ],
    textureUrl: '/textures/moons/titan.webp',
    color: '#d9a24a',
    source: 'keplerian',
    elements: elements(1_221_900, 0.029, 0.3, 15.945448, 78.6, 78.3, 11.7),
  },
  {
    id: 'iapetus',
    parentId: 'saturn',
    name: 'Iapetus',
    eyebrow: 'Moon · Saturn VIII',
    radiusKm: 734.3,
    orderIndex: 6,
    description:
      'A distant, dramatically two-toned moon with a strange equatorial ridge: one hemisphere is dark as coal tar, the other bright ice.',
    facts: [
      ['Mean radius', '734.3 km'],
      ['Semi-major axis', '3,561,700 km'],
      ['Orbital period', '79.33 days'],
      ['Notable feature', 'Sharp two-toned hemispheres'],
    ],
    color: '#9a8f82',
    source: 'keplerian',
    elements: elements(3_561_700, 0.028, 7.6, 79.331002, 86.5, 254.5, 74.8),
  },
  // Uranus — the five classical major moons.
  {
    id: 'miranda',
    parentId: 'uranus',
    name: 'Miranda',
    eyebrow: 'Moon · Uranus V',
    radiusKm: 235.8,
    orderIndex: 0,
    description:
      'The innermost of Uranus’s major moons, with an extraordinarily varied, jumbled surface including cliffs among the tallest known in the Solar System.',
    facts: [
      ['Mean radius', '235.8 km'],
      ['Semi-major axis', '129,846 km'],
      ['Orbital period', '1.413 days'],
    ],
    color: '#aeb4b8',
    source: 'keplerian',
    elements: elements(129_846, 0.001, 4.4, 1.413479, 100.9, 154.8, 73),
  },
  {
    id: 'ariel',
    parentId: 'uranus',
    name: 'Ariel',
    eyebrow: 'Moon · Uranus I',
    radiusKm: 578.9,
    orderIndex: 1,
    description: 'The brightest moon of Uranus, with a relatively young surface of ice canyons and few large craters.',
    facts: [
      ['Mean radius', '578.9 km'],
      ['Semi-major axis', '190,929 km'],
      ['Orbital period', '2.520 days'],
    ],
    color: '#c9ced1',
    source: 'keplerian',
    elements: elements(190_929, 0.001, 0, 2.520379, 0, 9.6, 193.5),
  },
  {
    id: 'umbriel',
    parentId: 'uranus',
    name: 'Umbriel',
    eyebrow: 'Moon · Uranus II',
    radiusKm: 584.7,
    orderIndex: 2,
    description: 'The darkest of Uranus’s major moons, an old, heavily cratered surface with little sign of resurfacing.',
    facts: [
      ['Mean radius', '584.7 km'],
      ['Semi-major axis', '265,986 km'],
      ['Orbital period', '4.144 days'],
    ],
    color: '#8b8b8d',
    source: 'keplerian',
    elements: elements(265_986, 0.004, 0.1, 4.144177, 174.8, 183.4, 253),
  },
  {
    id: 'titania',
    parentId: 'uranus',
    name: 'Titania',
    eyebrow: 'Moon · Uranus III',
    radiusKm: 788.9,
    orderIndex: 3,
    description: 'The largest moon of Uranus, an icy world scarred by canyons and impact craters.',
    facts: [
      ['Mean radius', '788.9 km'],
      ['Semi-major axis', '436,298 km'],
      ['Orbital period', '8.706 days'],
    ],
    textureUrl: '/textures/moons/titania.webp',
    // Voyager 2 flew past during Uranian southern summer: the northern hemisphere was
    // in polar night and is blank in the USGS mosaic.
    unimagedFill: '#c2c5c8',
    color: '#b7bcc0',
    source: 'keplerian',
    elements: elements(436_298, 0.002, 0.1, 8.705869, 29.5, 184, 68.1),
  },
  {
    id: 'oberon',
    parentId: 'uranus',
    name: 'Oberon',
    eyebrow: 'Moon · Uranus IV',
    radiusKm: 761.4,
    orderIndex: 4,
    description: 'The outermost major moon of Uranus, an old, heavily cratered icy body.',
    facts: [
      ['Mean radius', '761.4 km'],
      ['Semi-major axis', '583,511 km'],
      ['Orbital period', '13.463 days'],
    ],
    color: '#a6acb0',
    source: 'keplerian',
    elements: elements(583_511, 0.002, 0.1, 13.463237, 76.8, 132.2, 143.6),
  },
  // Neptune
  {
    id: 'triton',
    parentId: 'neptune',
    name: 'Triton',
    eyebrow: 'Moon · Neptune I',
    radiusKm: 1_352.6,
    orderIndex: 0,
    description:
      'Neptune’s large moon, almost certainly a captured Kuiper Belt object, orbiting backwards relative to Neptune’s rotation with active nitrogen-geyser plumes.',
    facts: [
      ['Mean radius', '1,352.6 km'],
      ['Semi-major axis', '354,800 km'],
      ['Orbital period', '5.877 days (retrograde)'],
      ['Origin', 'Likely a captured Kuiper Belt object'],
    ],
    textureUrl: '/textures/moons/triton.webp',
    // No `unimagedFill` here, unlike Titania. The file this used to point at was not a
    // map at all: it was an oblique three-quarter VIEW of the globe pasted into a
    // 1440x720 frame, so sampling it as equirectangular smeared one crescent of real
    // terrain across the whole sphere and left the rest flat. Nothing in the shader
    // could rescue that; the asset was the bug. The replacement is a genuine
    // cylindrical projection that carries its own neutral fill over the hemisphere
    // Voyager 2 never saw, which is why the no-data substitution is switched off.
    color: '#c7d6de',
    source: 'keplerian',
    elements: elements(354_800, 0.000016, 157.3, 5.876994, 178.1, 0, 63),
  },
]

export const MOONS: AtlasEntity[] = MOON_SEEDS.map((seed) => ({
  id: seed.id,
  name: seed.name,
  eyebrow: seed.eyebrow,
  kind: 'moon',
  parentId: seed.parentId,
  bodyId: seed.id,
  radiusKm: seed.radiusKm,
  orderIndex: seed.orderIndex,
  textureUrl: seed.textureUrl,
  unimagedFill: seed.unimagedFill,
  description: seed.description,
  facts: seed.facts.map(([label, value]) => ({ label, value })),
  source: NASA_FACT_SHEET,
  elements: seed.elements,
}))

export const MOON_COLORS: Record<string, string> = Object.fromEntries(
  MOON_SEEDS.map((seed) => [seed.id, seed.color]),
)

export const MOON_ENGINE_SOURCE: Record<string, 'jupiter-moons' | 'keplerian'> = Object.fromEntries(
  MOON_SEEDS.map((seed) => [seed.id, seed.source]),
)

export function moonsOf(planetId: string): AtlasEntity[] {
  return MOONS.filter((moon) => moon.parentId === planetId).sort(
    (a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0),
  )
}
