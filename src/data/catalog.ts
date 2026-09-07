export type EntityKind =
  | 'star'
  | 'planet'
  | 'moon'
  | 'impact structure'
  | 'crater'
  | 'continent'

export interface Fact {
  label: string
  value: string
}

export interface AtlasEntity {
  id: string
  name: string
  eyebrow: string
  kind: EntityKind
  parentId?: string
  bodyId: 'earth' | 'moon' | 'sun'
  description: string
  facts: Fact[]
  coordinates?: {
    latitude: number
    longitude: number
  }
  source: {
    label: string
    url: string
  }
}

export const EARTH_RADIUS_KM = 6_371
export const MOON_RADIUS_KM = 1_737.5
export const SUN_RADIUS_KM = 696_340
export const MEAN_EARTH_MOON_DISTANCE_KM = 385_000
export const MOON_RADIUS_UNITS = MOON_RADIUS_KM / EARTH_RADIUS_KM
export const SUN_RADIUS_UNITS = SUN_RADIUS_KM / EARTH_RADIUS_KM
export const PHYSICAL_DISTANCE_UNITS = MEAN_EARTH_MOON_DISTANCE_KM / EARTH_RADIUS_KM
export const EXPLORATION_DISTANCE_UNITS = 8

export const BODIES: AtlasEntity[] = [
  {
    id: 'sun',
    name: 'Sun',
    eyebrow: 'Star · Sol',
    kind: 'star',
    bodyId: 'sun',
    description:
      'The G-type main-sequence star at the center of the Solar System. Its direction, rotation, and illumination in this view are calculated for the displayed UTC time.',
    facts: [
      { label: 'Mean radius', value: '696,340 km' },
      { label: 'Mass', value: '1.9885 × 10³⁰ kg' },
      { label: 'Spectral type', value: 'G2 V' },
      { label: 'Mean Earth distance', value: '149.6 million km' },
      { label: 'Display model', value: 'Direction accurate · scale compressed' },
    ],
    source: {
      label: 'NASA Sun facts',
      url: 'https://science.nasa.gov/sun/facts/',
    },
  },
  {
    id: 'earth',
    name: 'Earth',
    eyebrow: 'Planet · Sol III',
    kind: 'planet',
    bodyId: 'earth',
    description:
      'The largest terrestrial planet in the Solar System and the only world known to support life. This orbital view uses a NASA Blue Marble global composite.',
    facts: [
      { label: 'Equatorial radius', value: '6,371 km' },
      { label: 'Mass', value: '5.97219 × 10²⁴ kg' },
      { label: 'Surface gravity', value: '9.80665 m/s²' },
      { label: 'Sidereal rotation', value: '23 h 56 m' },
      { label: 'Reference frame', value: 'IAU_EARTH (display)' },
    ],
    source: {
      label: 'NASA Earth facts',
      url: 'https://science.nasa.gov/earth/facts/',
    },
  },
  {
    id: 'moon',
    name: 'Moon',
    eyebrow: 'Natural satellite · Earth I',
    kind: 'moon',
    parentId: 'earth',
    bodyId: 'moon',
    description:
      'Earth’s only natural satellite. Its heavily cratered surface preserves evidence from the early Solar System. Color and relief are derived from LRO WAC and LOLA products.',
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
  },
]

const PRIMARY_SURFACE_FEATURES: AtlasEntity[] = [
  {
    id: 'earth-vredefort',
    name: 'Vredefort',
    eyebrow: 'Earth · South Africa',
    kind: 'impact structure',
    parentId: 'earth',
    bodyId: 'earth',
    coordinates: { latitude: -27.0, longitude: 27.5 },
    description:
      'A deeply eroded impact structure and the largest verified impact structure on Earth. Its surviving geology records an event more than two billion years ago.',
    facts: [
      { label: 'Latitude', value: '27.0° S' },
      { label: 'Longitude', value: '27.5° E' },
      { label: 'Original diameter', value: '≈ 250–300 km' },
      { label: 'Age', value: '≈ 2.02 billion years' },
    ],
    source: {
      label: 'Earth Impact Database',
      url: 'https://www.passc.net/EarthImpactDatabase/New%20website_05-2018/Vredefort.html',
    },
  },
  {
    id: 'earth-chicxulub',
    name: 'Chicxulub',
    eyebrow: 'Earth · Yucatán, Mexico',
    kind: 'impact structure',
    parentId: 'earth',
    bodyId: 'earth',
    coordinates: { latitude: 21.4, longitude: -89.5 },
    description:
      'A buried impact structure centered near the Yucatán coast. It is associated with the end-Cretaceous mass extinction 66 million years ago.',
    facts: [
      { label: 'Latitude', value: '21.4° N' },
      { label: 'Longitude', value: '89.5° W' },
      { label: 'Diameter', value: '≈ 180 km' },
      { label: 'Age', value: '≈ 66 million years' },
    ],
    source: {
      label: 'Earth Impact Database',
      url: 'https://www.passc.net/EarthImpactDatabase/New%20website_05-2018/Chicxulub.html',
    },
  },
  {
    id: 'earth-sudbury',
    name: 'Sudbury Basin',
    eyebrow: 'Earth · Ontario, Canada',
    kind: 'impact structure',
    parentId: 'earth',
    bodyId: 'earth',
    coordinates: { latitude: 46.6, longitude: -81.2 },
    description:
      'A large, ancient impact structure deformed by later geological processes. It is one of Earth’s oldest confirmed impact basins.',
    facts: [
      { label: 'Latitude', value: '46.6° N' },
      { label: 'Longitude', value: '81.2° W' },
      { label: 'Present extent', value: '≈ 130 × 60 km' },
      { label: 'Age', value: '≈ 1.85 billion years' },
    ],
    source: {
      label: 'Earth Impact Database',
      url: 'https://www.passc.net/EarthImpactDatabase/New%20website_05-2018/Sudbury.html',
    },
  },
  {
    id: 'moon-tycho',
    name: 'Tycho',
    eyebrow: 'Moon · Southern highlands',
    kind: 'crater',
    parentId: 'moon',
    bodyId: 'moon',
    coordinates: { latitude: -43.3, longitude: -11.22 },
    description:
      'A young, prominent lunar impact crater surrounded by a bright ray system that crosses much of the near side.',
    facts: [
      { label: 'Latitude', value: '43.30° S' },
      { label: 'Longitude', value: '11.22° W' },
      { label: 'Diameter', value: '85.29 km' },
      { label: 'Feature type', value: 'Crater' },
    ],
    source: {
      label: 'USGS Gazetteer of Planetary Nomenclature',
      url: 'https://planetarynames.wr.usgs.gov/Feature/6163',
    },
  },
  {
    id: 'moon-copernicus',
    name: 'Copernicus',
    eyebrow: 'Moon · Oceanus Procellarum',
    kind: 'crater',
    parentId: 'moon',
    bodyId: 'moon',
    coordinates: { latitude: 9.62, longitude: -20.08 },
    description:
      'A well-preserved complex crater with terraced walls, central peaks, and a visible ejecta-ray system.',
    facts: [
      { label: 'Latitude', value: '9.62° N' },
      { label: 'Longitude', value: '20.08° W' },
      { label: 'Diameter', value: '96.07 km' },
      { label: 'Feature type', value: 'Crater' },
    ],
    source: {
      label: 'USGS Gazetteer of Planetary Nomenclature',
      url: 'https://planetarynames.wr.usgs.gov/Feature/1296',
    },
  },
  {
    id: 'moon-shackleton',
    name: 'Shackleton',
    eyebrow: 'Moon · South pole',
    kind: 'crater',
    parentId: 'moon',
    bodyId: 'moon',
    coordinates: { latitude: -89.67, longitude: 129.78 },
    description:
      'A crater almost centered on the lunar south pole. Parts of its interior remain in permanent shadow while portions of the rim receive extended sunlight.',
    facts: [
      { label: 'Latitude', value: '89.67° S' },
      { label: 'Longitude', value: '129.78° E' },
      { label: 'Diameter', value: '20.92 km' },
      { label: 'Feature type', value: 'Crater' },
    ],
    source: {
      label: 'USGS Gazetteer of Planetary Nomenclature',
      url: 'https://planetarynames.wr.usgs.gov/Feature/5450',
    },
  },
]

function coordinateLabel(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(2)}° ${value >= 0 ? positive : negative}`
}

function moonCrater(name: string, latitude: number, longitude: number, diameter: number): AtlasEntity {
  return {
    id: `moon-${name.toLowerCase().replaceAll(' ', '-').replaceAll('á', 'a')}`,
    name,
    eyebrow: 'Moon · Named crater',
    kind: 'crater',
    parentId: 'moon',
    bodyId: 'moon',
    coordinates: { latitude, longitude },
    description: `${name} is an IAU-approved named lunar crater. Its label appears only when this surface area is centered and viewed at close zoom.`,
    facts: [
      { label: 'Latitude', value: coordinateLabel(latitude, 'N', 'S') },
      { label: 'Longitude', value: coordinateLabel(longitude, 'E', 'W') },
      { label: 'Diameter', value: `${diameter.toFixed(2)} km` },
      { label: 'Feature type', value: 'Crater' },
    ],
    source: {
      label: 'USGS Gazetteer of Planetary Nomenclature',
      url: 'https://planetarynames.wr.usgs.gov/Nomenclature',
    },
  }
}

const ADDITIONAL_MOON_CRATERS: AtlasEntity[] = [
  moonCrater('Alphonsus', -13.39, -2.85, 110.54),
  moonCrater('Archimedes', 29.72, -3.99, 81.04),
  moonCrater('Aristarchus', 23.73, -47.49, 39.99),
  moonCrater('Arzachel', -18.26, -1.93, 96.99),
  moonCrater('Bailly', -66.82, -68.9, 300.56),
  moonCrater('Catharina', -17.98, 23.55, 98.77),
  moonCrater('Clavius', -58.62, -14.73, 230.77),
  moonCrater('Cyrillus', -13.29, 24.07, 98.09),
  moonCrater('Eratosthenes', 14.47, -11.32, 58.77),
  moonCrater('Gassendi', -17.55, -39.96, 111.39),
  moonCrater('Grimaldi', -5.38, -68.36, 235),
  moonCrater('Hertzsprung', 1.37, -128.66, 536.37),
  moonCrater('Kepler', 8.12, -38.01, 29.49),
  moonCrater('Korolev', -4.19, -157.41, 423.41),
  moonCrater('Langrenus', -8.86, 61.04, 131.98),
  moonCrater('Petavius', -25.39, 60.78, 184.06),
  moonCrater('Plato', 51.62, -9.38, 100.68),
  moonCrater('Ptolemaeus', -9.16, -1.84, 153.67),
  moonCrater('Schickard', -44.38, -55.11, 212.18),
  moonCrater('Theophilus', -11.45, 26.28, 98.59),
  moonCrater('Tsiolkovskiy', -20.38, 128.97, 184.39),
  moonCrater('Von Kármán', -44.45, 176.25, 186.35),
]

export const SURFACE_FEATURES: AtlasEntity[] = [
  ...PRIMARY_SURFACE_FEATURES,
  ...ADDITIONAL_MOON_CRATERS,
]

const continent = (
  id: string,
  name: string,
  latitude: number,
  longitude: number,
  area: string,
): AtlasEntity => ({
  id,
  name,
  eyebrow: `Earth · ${name}`,
  kind: 'continent',
  parentId: 'earth',
  bodyId: 'earth',
  coordinates: { latitude, longitude },
  description: `${name} is shown as a semantic-zoom label over a Natural Earth coastline overlay that follows the globe surface.`,
  facts: [
    { label: 'Label anchor', value: `${Math.abs(latitude)}° ${latitude < 0 ? 'S' : 'N'}, ${Math.abs(longitude)}° ${longitude < 0 ? 'W' : 'E'}` },
    { label: 'Approximate area', value: area },
    { label: 'Boundary layer', value: 'Natural Earth 1:50m coastlines' },
  ],
  source: {
    label: 'Natural Earth vector data',
    url: 'https://www.naturalearthdata.com/downloads/50m-physical-vectors/50m-coastline/',
  },
})

export const CONTINENTS: AtlasEntity[] = [
  continent('continent-africa', 'Africa', 7, 20, '30.4 million km²'),
  continent('continent-antarctica', 'Antarctica', -82, 0, '14.2 million km²'),
  continent('continent-asia', 'Asia', 42, 90, '44.6 million km²'),
  continent('continent-europe', 'Europe', 52, 18, '10.2 million km²'),
  continent('continent-north-america', 'North America', 48, -105, '24.7 million km²'),
  continent('continent-south-america', 'South America', -18, -60, '17.8 million km²'),
  continent('continent-oceania', 'Oceania', -25, 135, '8.5 million km²'),
]

export const CATALOG: AtlasEntity[] = [
  ...BODIES,
  ...CONTINENTS,
  ...SURFACE_FEATURES,
]

export function findEntity(id: string | null): AtlasEntity | null {
  if (!id) return null
  return CATALOG.find((entity) => entity.id === id) ?? null
}
