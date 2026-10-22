import type { AtlasEntity } from './types'

/**
 * Objects people come to an atlas of the universe specifically to look at.
 *
 * Every catalogue the atlas loads is a survey — all 13,371 NGC objects, all 329,860
 * stars, all 38,051 Cosmicflows groups — and surveys are exactly the wrong shape for
 * "show me the biggest black hole". None of these objects is in OpenNGC, AT-HYG or
 * Cosmicflows-4 in a form that would give it a position and a name together, so each
 * one is listed here by hand, with the measurement it rests on.
 *
 * ## Distances
 *
 * Two kinds, and the difference matters at these scales. Nearby objects carry a
 * `distancePc` straight from the literature. Everything beyond the local universe
 * carries a `redshift` instead, and the atlas computes a comoving distance from it
 * under Planck 2018 — the same treatment every other extragalactic dataset here gets,
 * so a quasar and a Cosmicflows group sit in the same space rather than two spaces
 * that happen to share an origin.
 *
 * ## Radii
 *
 * A black hole's radius is its Schwarzschild radius, computed from the quoted mass.
 * That is the only length a non-rotating black hole has, and it is what sets the
 * apparent size of the shadow — about 2.6 times larger than r_s to a distant
 * observer, which the renderer accounts for. These are real lengths, not drawing
 * conveniences: TON 618's horizon is 1,300 AU across, and it should look like it.
 */

/** Metres of Schwarzschild radius per solar mass: 2GM_sun/c^2. */
const SCHWARZSCHILD_METRES_PER_SOLAR_MASS = 2953.25

export interface NotableObject {
  id: string
  name: string
  eyebrow: string
  /** ICRS right ascension, degrees. */
  raDeg: number
  /** ICRS declination, degrees. */
  decDeg: number
  /** Distance in parsecs, for objects close enough that redshift is not the measurement. */
  distancePc?: number
  /** Heliocentric redshift, for everything else. */
  redshift?: number
  /** Mass in solar masses, for the bodies that have one. */
  solarMasses?: number
  /** Explicit radius in metres, when the object is not a black hole. */
  radiusMetres?: number
  objectClass: 'black-hole' | 'galaxy' | 'star' | 'nebula'
  description: string
  facts: [string, string][]
  source: { label: string; url: string }
}

export const NOTABLE_OBJECTS: NotableObject[] = [
  // ---------------------------------------------------------------------------
  // Supermassive black holes
  // ---------------------------------------------------------------------------
  {
    id: 'bh:m87',
    name: 'M87*',
    eyebrow: 'Supermassive black hole · Messier 87',
    raDeg: 187.70593,
    decDeg: 12.39112,
    distancePc: 16.8e6,
    solarMasses: 6.5e9,
    objectClass: 'black-hole',
    description:
      'The first black hole ever imaged. The Event Horizon Telescope resolved its shadow in 2019 using eight radio observatories across four continents as a single Earth-sized instrument. Its event horizon is larger than Pluto’s orbit, and the jet it drives is visible across 5,000 light years.',
    facts: [
      ['Mass', '6.5 × 10⁹ M☉'],
      ['Schwarzschild radius', '128 AU'],
      ['Distance', '16.8 Mpc · 54.8 million ly'],
      ['Host', 'Messier 87, Virgo Cluster'],
      ['Imaged', 'Event Horizon Telescope, 2019'],
    ],
    source: {
      label: 'Event Horizon Telescope Collaboration 2019, ApJL 875, L1',
      url: 'https://doi.org/10.3847/2041-8213/ab0ec7',
    },
  },
  {
    id: 'bh:ton618',
    name: 'TON 618',
    eyebrow: 'Ultramassive black hole · hyperluminous quasar',
    raDeg: 187.10405,
    decDeg: 31.47714,
    redshift: 2.219,
    solarMasses: 6.6e10,
    objectClass: 'black-hole',
    description:
      'One of the most massive black holes known: roughly 66 billion solar masses, fifteen times M87* and ten thousand times the one at the centre of our own galaxy. Its event horizon is about 1,300 AU across, forty times Neptune’s orbit, and the quasar it powers outshines the entire Milky Way several hundred times over. The mass comes from the width of its broad emission lines, which is a model-dependent estimate, not a dynamical measurement.',
    facts: [
      ['Mass', '6.6 × 10¹⁰ M☉'],
      ['Schwarzschild radius', '1,300 AU'],
      ['Redshift', 'z = 2.219'],
      ['Light travel time', '~10.8 billion years'],
      ['Mass method', 'H-beta broad-line width (indirect)'],
    ],
    source: {
      label: 'Shemmer et al. 2004, ApJ 614, 547',
      url: 'https://doi.org/10.1086/423607',
    },
  },
  {
    id: 'bh:3c273',
    name: '3C 273',
    eyebrow: 'Quasar · the first ever identified',
    raDeg: 187.27792,
    decDeg: 2.05239,
    redshift: 0.158,
    solarMasses: 8.9e8,
    objectClass: 'black-hole',
    description:
      'The object that created the word quasar. In 1963 Maarten Schmidt recognised that its baffling spectrum was ordinary hydrogen redshifted by 16 per cent, which put it two billion light years away and made it the most luminous thing anyone had ever seen. It is the optically brightest quasar in the sky, and at magnitude 12.9 an amateur telescope can reach it.',
    facts: [
      ['Mass', '8.9 × 10⁸ M☉'],
      ['Redshift', 'z = 0.158'],
      ['Apparent magnitude', '12.9'],
      ['Identified', 'Schmidt 1963'],
    ],
    source: {
      label: 'Schmidt 1963, Nature 197, 1040',
      url: 'https://doi.org/10.1038/1971040a0',
    },
  },
  {
    id: 'bh:oj287',
    name: 'OJ 287',
    eyebrow: 'Binary supermassive black hole · blazar',
    raDeg: 133.70362,
    decDeg: 20.10852,
    redshift: 0.3056,
    solarMasses: 1.8e10,
    objectClass: 'black-hole',
    description:
      'A blazar that flares on a twelve-year cycle, which is best explained by a second black hole of about 150 million solar masses punching through the primary’s accretion disc twice per orbit. The outburst timings have been predicted years in advance and arrived on schedule, which is about as direct as evidence for a supermassive binary gets. Its optical record runs back to photographic plates from 1888.',
    facts: [
      ['Primary mass', '1.8 × 10¹⁰ M☉'],
      ['Secondary mass', '1.5 × 10⁸ M☉'],
      ['Orbital period', '~12 years'],
      ['Redshift', 'z = 0.306'],
    ],
    source: {
      label: 'Valtonen et al. 2008, Nature 452, 851',
      url: 'https://doi.org/10.1038/nature06896',
    },
  },
  {
    id: 'bh:centaurus-a',
    name: 'Centaurus A*',
    eyebrow: 'Supermassive black hole · NGC 5128',
    raDeg: 201.36506,
    decDeg: -43.01911,
    distancePc: 3.8e6,
    solarMasses: 5.5e7,
    objectClass: 'black-hole',
    description:
      'The nearest active galactic nucleus, in the peculiar elliptical galaxy NGC 5128. It drives a radio jet a million light years long, and the Event Horizon Telescope resolved the base of that jet in 2021, the sharpest view yet of where a jet is actually launched.',
    facts: [
      ['Mass', '5.5 × 10⁷ M☉'],
      ['Distance', '3.8 Mpc · 12.4 million ly'],
      ['Jet length', '~1 million ly'],
      ['Host', 'NGC 5128'],
    ],
    source: {
      label: 'Janssen et al. 2021, Nature Astronomy 5, 1017',
      url: 'https://doi.org/10.1038/s41550-021-01417-w',
    },
  },
  {
    id: 'bh:m31',
    name: 'M31*',
    eyebrow: 'Supermassive black hole · Andromeda',
    raDeg: 10.6847,
    decDeg: 41.26875,
    distancePc: 785e3,
    solarMasses: 1.4e8,
    objectClass: 'black-hole',
    description:
      'The black hole at the centre of the Andromeda Galaxy, thirty times more massive than our own and sitting inside a double nucleus: an eccentric disc of old stars that appears as two brightness peaks, with the black hole at the fainter one.',
    facts: [
      ['Mass', '1.4 × 10⁸ M☉'],
      ['Distance', '785 kpc · 2.56 million ly'],
      ['Host', 'M31, Andromeda'],
    ],
    source: {
      label: 'Bender et al. 2005, ApJ 631, 280',
      url: 'https://doi.org/10.1086/432434',
    },
  },
  {
    id: 'bh:phoenix-a',
    name: 'Phoenix A*',
    eyebrow: 'Ultramassive black hole candidate',
    raDeg: 356.18292,
    decDeg: -42.72056,
    redshift: 0.596,
    solarMasses: 1e10,
    objectClass: 'black-hole',
    description:
      'The black hole at the heart of the Phoenix Cluster, which hosts the most extreme cooling flow and the fiercest starburst known in any cluster core, around 500 solar masses of new stars a year. Mass estimates range over an order of magnitude depending on the scaling relation used, so treat the figure here as indicative rather than measured.',
    facts: [
      ['Mass', '~10¹⁰ M☉ (estimate)'],
      ['Redshift', 'z = 0.596'],
      ['Host', 'Phoenix Cluster, SPT-CL J2344-4243'],
      ['Star formation', '~500 M☉/year'],
    ],
    source: {
      label: 'McDonald et al. 2012, Nature 488, 349',
      url: 'https://doi.org/10.1038/nature11379',
    },
  },

  // ---------------------------------------------------------------------------
  // Stellar-mass black holes, near enough to be neighbours
  // ---------------------------------------------------------------------------
  {
    id: 'bh:cygnus-x1',
    name: 'Cygnus X-1',
    eyebrow: 'Stellar-mass black hole · X-ray binary',
    raDeg: 299.59032,
    decDeg: 35.2016,
    distancePc: 2220,
    solarMasses: 21.2,
    objectClass: 'black-hole',
    description:
      'The first object widely accepted to be a black hole, and the subject of a famous 1974 bet between Stephen Hawking and Kip Thorne that Hawking conceded in 1990. It pulls a stream of gas off a blue supergiant companion; the gas heats to millions of degrees on the way in and makes this one of the brightest X-ray sources in the sky.',
    facts: [
      ['Mass', '21.2 M☉'],
      ['Schwarzschild radius', '62.6 km'],
      ['Distance', '2.22 kpc · 7,200 ly'],
      ['Companion', 'HDE 226868, O9.7 Iab supergiant'],
      ['Orbital period', '5.6 days'],
    ],
    source: {
      label: 'Miller-Jones et al. 2021, Science 371, 1046',
      url: 'https://doi.org/10.1126/science.abb3363',
    },
  },
  {
    id: 'bh:v404-cygni',
    name: 'V404 Cygni',
    eyebrow: 'Stellar-mass black hole · X-ray nova',
    raDeg: 306.01588,
    decDeg: 33.86723,
    distancePc: 2390,
    solarMasses: 9,
    objectClass: 'black-hole',
    description:
      'A black hole that spends decades quiet and then erupts. Its 2015 outburst made it briefly the brightest X-ray source in the sky and was watched by essentially every X-ray observatory in orbit. Its distance is one of the most precisely known of any black hole, measured by radio parallax to better than five per cent.',
    facts: [
      ['Mass', '9 M☉'],
      ['Distance', '2.39 kpc · 7,800 ly'],
      ['Orbital period', '6.47 days'],
      ['Last outburst', '2015'],
    ],
    source: {
      label: 'Miller-Jones et al. 2009, ApJ 706, L230',
      url: 'https://doi.org/10.1088/0004-637X/706/2/L230',
    },
  },
  {
    id: 'bh:gaia-bh1',
    name: 'Gaia BH1',
    eyebrow: 'Nearest known black hole',
    raDeg: 262.1712,
    decDeg: -0.58109,
    distancePc: 480,
    solarMasses: 9.62,
    objectClass: 'black-hole',
    description:
      'The closest black hole to Earth yet found, three times nearer than any previously known. It is dormant, so nothing is falling into it and it emits nothing, and it was discovered purely from the wobble it induces in an ordinary Sun-like star orbiting it every 186 days. How a binary like this survives the supernova that made the black hole is still unexplained.',
    facts: [
      ['Mass', '9.62 M☉'],
      ['Schwarzschild radius', '28.4 km'],
      ['Distance', '480 pc · 1,560 ly'],
      ['Companion', 'G-type main sequence star'],
      ['Orbital period', '185.6 days'],
    ],
    source: {
      label: 'El-Badry et al. 2023, MNRAS 518, 1057',
      url: 'https://doi.org/10.1093/mnras/stac3140',
    },
  },
  {
    id: 'bh:grs1915',
    name: 'GRS 1915+105',
    eyebrow: 'Microquasar · superluminal jets',
    raDeg: 288.79813,
    decDeg: 10.94572,
    distancePc: 8600,
    solarMasses: 12.4,
    objectClass: 'black-hole',
    description:
      'The first object in the galaxy seen to launch jets that appear to move faster than light, an illusion of geometry produced by material travelling at 92 per cent of light speed almost straight towards us. It has been in continuous outburst since 1992 and is the most rapidly spinning black hole known, dragging spacetime around itself close to the theoretical maximum.',
    facts: [
      ['Mass', '12.4 M☉'],
      ['Distance', '8.6 kpc · 28,000 ly'],
      ['Jet speed', '0.92 c'],
      ['Spin', 'a* > 0.98'],
    ],
    source: {
      label: 'Mirabel & Rodríguez 1994, Nature 371, 46',
      url: 'https://doi.org/10.1038/371046a0',
    },
  },
  {
    id: 'bh:ss433',
    name: 'SS 433',
    eyebrow: 'Microquasar · precessing jets',
    raDeg: 287.95658,
    decDeg: 4.98278,
    distancePc: 5500,
    solarMasses: 4.2,
    objectClass: 'black-hole',
    description:
      'A compact object firing two opposed jets at a quarter of the speed of light, which precess through a 162-day cone and corkscrew visibly through the surrounding supernova remnant. The Doppler shifts in its spectrum swing by tens of thousands of kilometres per second, and tracking them was how the jets were worked out at all.',
    facts: [
      ['Mass', '~4.2 M☉'],
      ['Distance', '5.5 kpc · 18,000 ly'],
      ['Jet speed', '0.26 c'],
      ['Precession period', '162.5 days'],
    ],
    source: {
      label: 'Margon 1984, ARA&A 22, 507',
      url: 'https://doi.org/10.1146/annurev.aa.22.090184.002451',
    },
  },

  // ---------------------------------------------------------------------------
  // The far edge of what has been observed
  // ---------------------------------------------------------------------------
  {
    id: 'qso:ulas-j1342',
    name: 'ULAS J1342+0928',
    eyebrow: 'Quasar · 690 million years after the Big Bang',
    raDeg: 205.53375,
    decDeg: 9.47731,
    redshift: 7.54,
    solarMasses: 7.8e8,
    objectClass: 'black-hole',
    description:
      'A quasar seen as it was when the universe was five per cent of its present age, during the epoch when the first stars were still finishing the job of reionising intergalactic hydrogen. Its 800-million-solar-mass black hole is a genuine problem: there has not obviously been enough time since the Big Bang for one to grow that large by ordinary accretion.',
    facts: [
      ['Mass', '7.8 × 10⁸ M☉'],
      ['Redshift', 'z = 7.54'],
      ['Age of universe then', '690 million years'],
      ['Light travel time', '~13.1 billion years'],
    ],
    source: {
      label: 'Bañados et al. 2018, Nature 553, 473',
      url: 'https://doi.org/10.1038/nature25180',
    },
  },
  {
    id: 'gal:gn-z11',
    name: 'GN-z11',
    eyebrow: 'Galaxy · 400 million years after the Big Bang',
    raDeg: 189.10604,
    decDeg: 62.24202,
    redshift: 10.6,
    radiusMetres: 1.1e19, // ~1,200 ly across; compact even for its era
    objectClass: 'galaxy',
    description:
      'For several years the most distant object ever confirmed, and still one of the most studied. It is tiny, about one per cent of the Milky Way’s mass in a region 25 times smaller, yet already forming stars twenty times faster, and JWST has since found a growing black hole in it. We see it as it was 13.4 billion years ago.',
    facts: [
      ['Redshift', 'z = 10.60'],
      ['Age of universe then', '~400 million years'],
      ['Light travel time', '~13.4 billion years'],
      ['Diameter', '~2,500 ly'],
    ],
    source: {
      label: 'Oesch et al. 2016, ApJ 819, 129',
      url: 'https://doi.org/10.3847/0004-637X/819/2/129',
    },
  },
]

/** Schwarzschild radius in metres for a mass in solar masses. */
export function schwarzschildRadiusMetres(solarMasses: number): number {
  return SCHWARZSCHILD_METRES_PER_SOLAR_MASS * solarMasses
}

/** The radius the atlas frames and draws this object at. */
export function notableRadiusMetres(object: NotableObject): number {
  if (object.radiusMetres) return object.radiusMetres
  if (object.solarMasses) return schwarzschildRadiusMetres(object.solarMasses)
  return 0
}

/** Catalogue entries, so the inspector has prose and a citation for each. */
export const NOTABLE_ENTITIES: AtlasEntity[] = NOTABLE_OBJECTS.map((object) => ({
  id: object.id,
  name: object.name,
  eyebrow: object.eyebrow,
  kind: 'star',
  bodyId: object.id,
  description: object.description,
  facts: object.facts.map(([label, value]) => ({ label, value })),
  source: object.source,
}))
