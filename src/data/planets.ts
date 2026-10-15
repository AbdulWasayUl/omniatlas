import type { AtlasEntity } from './types'

const NASA_FACT_SHEET = {
  label: 'NASA Planetary Fact Sheet',
  url: 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/',
}

interface PlanetSeed {
  id: string
  name: string
  eyebrow: string
  engineBody: string
  radiusKm: number
  semiMajorAxisAu: number
  description: string
  facts: [string, string][]
  textureUrl: string
  ringTextureUrl?: string
  atmosphereTextureUrl?: string
}

const PLANET_SEEDS: PlanetSeed[] = [
  {
    id: 'mercury',
    name: 'Mercury',
    eyebrow: 'Planet · Sol I',
    engineBody: 'Mercury',
    radiusKm: 2_439.7,
    semiMajorAxisAu: 0.387,
    description:
      'The innermost and smallest planet. A cratered, airless world with the most eccentric orbit and the largest daily temperature swing of any planet.',
    facts: [
      ['Mean radius', '2,439.7 km'],
      ['Mass', '3.3011 × 10²³ kg'],
      ['Surface gravity', '3.7 m/s²'],
      ['Sidereal rotation', '58.646 days'],
      ['Orbital period', '87.969 days'],
      ['Semi-major axis', '0.387 AU'],
      ['Known moons', '0'],
    ],
    textureUrl: '/textures/planets/mercury.jpg',
  },
  {
    id: 'venus',
    name: 'Venus',
    eyebrow: 'Planet · Sol II',
    engineBody: 'Venus',
    radiusKm: 6_051.8,
    semiMajorAxisAu: 0.723,
    description:
      'Earth’s near-twin in size, shrouded in a thick carbon-dioxide atmosphere that traps heat and makes it the hottest planet. It rotates backwards, very slowly.',
    facts: [
      ['Mean radius', '6,051.8 km'],
      ['Mass', '4.8675 × 10²⁴ kg'],
      ['Surface gravity', '8.87 m/s²'],
      ['Sidereal rotation', '243.02 days (retrograde)'],
      ['Orbital period', '224.70 days'],
      ['Semi-major axis', '0.723 AU'],
      ['Known moons', '0'],
    ],
    textureUrl: '/textures/planets/venus-surface.jpg',
    atmosphereTextureUrl: '/textures/planets/venus-atmosphere.jpg',
  },
  {
    id: 'earth',
    name: 'Earth',
    eyebrow: 'Planet · Sol III',
    engineBody: 'Earth',
    radiusKm: 6_371,
    semiMajorAxisAu: 1,
    description:
      'The largest terrestrial planet in the Solar System and the only world known to support life. This view uses a NASA Blue Marble global composite with a live cloud layer.',
    facts: [
      ['Equatorial radius', '6,371 km'],
      ['Mass', '5.97219 × 10²⁴ kg'],
      ['Surface gravity', '9.80665 m/s²'],
      ['Sidereal rotation', '23 h 56 m'],
      ['Orbital period', '365.256 days'],
      ['Semi-major axis', '1 AU'],
      ['Known moons', '1 (the Moon)'],
    ],
    textureUrl: '/textures/earth/blue-marble-december.jpg',
  },
  {
    id: 'mars',
    name: 'Mars',
    eyebrow: 'Planet · Sol IV',
    engineBody: 'Mars',
    radiusKm: 3_389.5,
    semiMajorAxisAu: 1.524,
    description:
      'The Red Planet. Iron-oxide dust gives it a rust color; it hosts the largest known volcano and canyon system in the Solar System and two small captured-asteroid moons.',
    facts: [
      ['Mean radius', '3,389.5 km'],
      ['Mass', '6.4171 × 10²³ kg'],
      ['Surface gravity', '3.721 m/s²'],
      ['Sidereal rotation', '24 h 37 m'],
      ['Orbital period', '686.98 days'],
      ['Semi-major axis', '1.524 AU'],
      ['Known moons', '2 (Phobos, Deimos shown)'],
    ],
    textureUrl: '/textures/planets/mars.jpg',
  },
  {
    id: 'jupiter',
    name: 'Jupiter',
    eyebrow: 'Planet · Sol V',
    engineBody: 'Jupiter',
    radiusKm: 69_911,
    semiMajorAxisAu: 5.204,
    description:
      'The largest planet, a gas giant with banded clouds of ammonia and water, the Great Red Spot storm, and a large family of moons including the four Galilean satellites.',
    facts: [
      ['Mean radius', '69,911 km'],
      ['Mass', '1.8982 × 10²⁷ kg'],
      ['Surface gravity', '24.79 m/s²'],
      ['Sidereal rotation', '9 h 56 m'],
      ['Orbital period', '11.86 years'],
      ['Semi-major axis', '5.204 AU'],
      ['Known moons', '95 (4 Galilean shown)'],
    ],
    textureUrl: '/textures/planets/jupiter.jpg',
  },
  {
    id: 'saturn',
    name: 'Saturn',
    eyebrow: 'Planet · Sol VI',
    engineBody: 'Saturn',
    radiusKm: 58_232,
    semiMajorAxisAu: 9.582,
    description:
      'A low-density gas giant famous for its bright, wide ring system of ice and rock, and for Titan, its largest moon and the only moon with a substantial atmosphere.',
    facts: [
      ['Mean radius', '58,232 km'],
      ['Mass', '5.6834 × 10²⁶ kg'],
      ['Surface gravity', '10.44 m/s²'],
      ['Sidereal rotation', '10 h 34 m'],
      ['Orbital period', '29.45 years'],
      ['Semi-major axis', '9.582 AU'],
      ['Known moons', '146 (5 shown)'],
    ],
    textureUrl: '/textures/planets/saturn.jpg',
    ringTextureUrl: '/textures/planets/saturn-ring.png',
  },
  {
    id: 'uranus',
    name: 'Uranus',
    eyebrow: 'Planet · Sol VII',
    engineBody: 'Uranus',
    radiusKm: 25_362,
    semiMajorAxisAu: 19.201,
    description:
      'An ice giant tipped on its side by an axial tilt of about 98 degrees, giving it extreme seasons. Its pale blue-green color comes from methane in its atmosphere.',
    facts: [
      ['Mean radius', '25,362 km'],
      ['Mass', '8.6810 × 10²⁵ kg'],
      ['Surface gravity', '8.69 m/s²'],
      ['Sidereal rotation', '17 h 14 m (retrograde)'],
      ['Orbital period', '84.02 years'],
      ['Semi-major axis', '19.201 AU'],
      ['Known moons', '28 (3 shown)'],
    ],
    textureUrl: '/textures/planets/uranus.jpg',
  },
  {
    id: 'neptune',
    name: 'Neptune',
    eyebrow: 'Planet · Sol VIII',
    engineBody: 'Neptune',
    radiusKm: 24_622,
    semiMajorAxisAu: 30.047,
    description:
      'The outermost planet, a dense, dark, cold ice giant with the fastest winds in the Solar System and a large retrograde moon, Triton, likely a captured Kuiper Belt object.',
    facts: [
      ['Mean radius', '24,622 km'],
      ['Mass', '1.02413 × 10²⁶ kg'],
      ['Surface gravity', '11.15 m/s²'],
      ['Sidereal rotation', '16 h 6 m'],
      ['Orbital period', '164.79 years'],
      ['Semi-major axis', '30.047 AU'],
      ['Known moons', '16 (Triton shown)'],
    ],
    textureUrl: '/textures/planets/neptune.jpg',
  },
]

export const PLANETS: AtlasEntity[] = PLANET_SEEDS.map((seed) => ({
  id: seed.id,
  name: seed.name,
  eyebrow: seed.eyebrow,
  kind: 'planet',
  bodyId: seed.id,
  engineBody: seed.engineBody,
  radiusKm: seed.radiusKm,
  semiMajorAxisAu: seed.semiMajorAxisAu,
  textureUrl: seed.textureUrl,
  ringTextureUrl: seed.ringTextureUrl,
  atmosphereTextureUrl: seed.atmosphereTextureUrl,
  description: seed.description,
  facts: seed.facts.map(([label, value]) => ({ label, value })),
  source: NASA_FACT_SHEET,
}))

export const DWARF_PLANETS: AtlasEntity[] = [
  {
    id: 'pluto',
    name: 'Pluto',
    eyebrow: 'Dwarf planet · Kuiper Belt',
    kind: 'dwarf-planet',
    bodyId: 'pluto',
    engineBody: 'Pluto',
    radiusKm: 1_188.3,
    semiMajorAxisAu: 39.48,
    // No global map ships with the atlas. New Horizons' measured mean disc colour is
    // a pale red-brown from surface tholins, which is closer to the truth than grey.
    baseColor: '#bda182',
    description:
      'A small, icy dwarf planet in the Kuiper Belt with a steeply tilted, eccentric orbit that briefly brings it closer to the Sun than Neptune. Reclassified from “planet” in 2006 once similar Kuiper Belt worlds were found.',
    facts: [
      { label: 'Mean radius', value: '1,188.3 km' },
      { label: 'Mass', value: '1.303 × 10²² kg' },
      { label: 'Orbital period', value: '247.94 years' },
      { label: 'Semi-major axis', value: '39.48 AU' },
      { label: 'Orbital eccentricity', value: '0.2488' },
      { label: 'Classification', value: 'Dwarf planet (Kuiper Belt)' },
    ],
    source: NASA_FACT_SHEET,
  },
]

export function findPlanet(id: string | null | undefined): AtlasEntity | null {
  if (!id) return null
  return PLANETS.find((planet) => planet.id === id) ?? DWARF_PLANETS.find((planet) => planet.id === id) ?? null
}
