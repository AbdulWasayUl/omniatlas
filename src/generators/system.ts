/**
 * Invented planetary systems, for the atlas's immersive mode.
 *
 * Everything in this file is MADE UP. Nothing it returns was observed, and no part of it
 * should ever be presented as though it were: the rest of the atlas goes to some trouble
 * to refuse a Hubble distance below a peculiar-velocity floor and to draw a galaxy with
 * no distance as a hollow ring, and that care is worth nothing if a generated moon can be
 * mistaken for a measured one. Generated nodes are namespaced `gen:` so they cannot
 * collide with a catalogue id, they carry `provenance: 'invention'`, and the mode that
 * creates them is off unless the viewer turns it on.
 *
 * What the generator DOES owe the viewer is plausibility. The point of immersive mode is
 * that a star stops being a point of light and becomes somewhere with a shape, so the
 * systems have to look like systems: orbits that do not cross, moons inside their
 * planet's Hill sphere and outside its Roche limit, ice beyond the frost line, rock
 * inside it, and a habitable zone placed by the star's own luminosity rather than by
 * taste. Where a real relation was cheap to apply, it is applied; where it was not, the
 * shape of the answer is still taken from the solar system and the exoplanet census
 * rather than from nothing.
 *
 * ## Determinism
 *
 * The same star yields the same system on every machine, forever. That is not a nicety:
 * the atlas puts its camera state in the URL, so a permalink to a generated moon has to
 * show the next person the same moon. Every random number here comes from a seed derived
 * only from the star's own id, through the same mulberry32 the Milky Way's disc field
 * already uses in its build script, and nothing consults the clock, the device, or the
 * order in which things happened to load.
 */

import { type Rng, hashSeed, rngFrom } from './random'

// --- constants, in SI unless the name says otherwise -------------------------

const AU_M = 1.495978707e11
const SOLAR_RADIUS_M = 6.957e8
const SOLAR_LUMINOSITY_W = 3.828e26
const EARTH_RADIUS_M = 6.371e6
const EARTH_MASS_KG = 5.972e24
const SIGMA_SB = 5.670374419e-8
const G = 6.6743e-11
const DAY_S = 86400

/**
 * What a generated world is made of, which decides how it is drawn and what it is called.
 *
 * The set is chosen to cover the solar system's own range plus the two kinds the
 * exoplanet census found that it does not contain — the hot Jupiter and the super-Earth —
 * because a generated galaxy whose systems all look like this one would be a worse lie
 * than an obviously invented one.
 */
export type WorldKind =
  | 'lava'
  | 'volcanic'
  | 'carbon'
  | 'iron'
  | 'greenhouse'
  | 'desert'
  | 'rocky'
  | 'terrestrial'
  | 'ocean'
  | 'hycean'
  | 'ice'
  | 'snowball'
  | 'superEarth'
  | 'subNeptune'
  | 'iceGiant'
  | 'gasGiant'
  | 'hotJupiter'

/** What each kind is called, and one sentence on what makes it that kind. */
export const WORLD_KINDS: Record<WorldKind, { label: string; description: string }> = {
  lava: { label: 'Lava world', description: 'Close enough to its star that the day side is partly molten rock.' },
  volcanic: {
    label: 'Volcanic world',
    description: 'Kneaded by tides from the world it orbits, and resurfacing itself faster than craters can form.',
  },
  carbon: {
    label: 'Carbon world',
    description: 'Formed where carbon outweighed oxygen, so its crust is graphite and carbides rather than silicates.',
  },
  iron: {
    label: 'Iron world',
    description: 'A stripped core: dense, metallic, and far smaller than its mass would suggest.',
  },
  greenhouse: {
    label: 'Greenhouse world',
    description: 'An atmosphere thick enough to trap its own heat, holding the surface far above the sunlight alone.',
  },
  desert: { label: 'Desert world', description: 'Rock and dust, with whatever water it began with long since gone.' },
  rocky: { label: 'Rocky world', description: 'Bare silicate rock, too small or too dry to have kept much of an atmosphere.' },
  terrestrial: {
    label: 'Terrestrial world',
    description: 'Rock, water and air together: continents, weather, and a surface you could stand on.',
  },
  ocean: { label: 'Ocean world', description: 'Water over the whole surface, with no land breaking it anywhere.' },
  hycean: {
    label: 'Hycean world',
    description: 'A deep warm ocean under a thick hydrogen sky, far larger than a rocky world and far lighter.',
  },
  ice: { label: 'Ice world', description: 'Water, ammonia and methane frozen hard, beyond the reach of its star.' },
  snowball: {
    label: 'Snowball world',
    description: 'Frozen from pole to pole and bright enough to reflect away most of the little light it gets.',
  },
  superEarth: {
    label: 'Super-Earth',
    description: 'Several times Earth\u2019s mass and still rock: the commonest kind of planet, and one this system lacks.',
  },
  subNeptune: {
    label: 'Sub-Neptune',
    description: 'A rocky core under an envelope of hydrogen it never managed to lose. Nothing like it orbits the Sun.',
  },
  iceGiant: { label: 'Ice giant', description: 'A deep mantle of water, ammonia and methane around a small core.' },
  gasGiant: { label: 'Gas giant', description: 'Mostly hydrogen and helium, with no surface anywhere beneath the cloud tops.' },
  hotJupiter: {
    label: 'Hot Jupiter',
    description: 'A giant that migrated inward and now skims its star, puffed up and streaming atmosphere.',
  },
}

export interface GeneratedMoon {
  id: string
  name: string
  kind: WorldKind
  radiusMetres: number
  /** Mean colour, for a body with no map to draw. */
  color: string
  /** Semi-major axis about its planet, metres. */
  semiMajorAxisMetres: number
  eccentricity: number
  inclinationDeg: number
  nodeDeg: number
  periapsisDeg: number
  meanAnomalyDeg: number
  periodDays: number
  /** True where this moon could hold liquid water at its surface. See `habitability`. */
  habitable: boolean
  /** Why it is or is not habitable, in one phrase, for the inspector. */
  habitabilityNote: string
}

export interface GeneratedPlanet extends Omit<GeneratedMoon, 'habitable' | 'habitabilityNote'> {
  massKg: number
  /** Equilibrium temperature, kelvin, for zero albedo and no greenhouse. */
  equilibriumK: number
  hasRings: boolean
  axialTiltDeg: number
  moons: GeneratedMoon[]
  habitable: boolean
  habitabilityNote: string
}

export interface GeneratedStar {
  /** Mass in solar masses. */
  massSun: number
  radiusMetres: number
  /** Bolometric luminosity in solar luminosities. */
  luminositySun: number
  temperatureK: number
  color: string
}

/** A belt of rubble between two planets, or beyond the last one. */
export interface GeneratedBelt {
  id: string
  name: string
  /** Inner and outer edge, metres from the star. */
  innerMetres: number
  outerMetres: number
  /** How many bodies to draw. Not a population estimate, a rendering budget. */
  count: number
  color: string
  /** Mean inclination of the belt, degrees. */
  spreadDeg: number
  description: string
}

export interface GeneratedSystem {
  /** The id of the real star this was invented around. */
  starId: string
  seed: number
  star: GeneratedStar
  /** Conservative habitable zone, in AU. */
  habitableZoneAu: { inner: number; outer: number }
  /** Distance beyond which water is ice during formation, in AU. */
  frostLineAu: number
  planets: GeneratedPlanet[]
  belts: GeneratedBelt[]
}

/** The star properties a caller already knows, where it knows them. */
export interface StarSeedInput {
  /** The real node id. Seeds everything, so it must be stable. */
  id: string
  /** Effective temperature in kelvin, where the catalogue gives a spectral type. */
  temperatureK?: number
  /** Radius in metres, where the catalogue supports an estimate. */
  radiusMetres?: number
}

/**
 * A base colour per kind, varied per world rather than picked from a short list.
 *
 * Four fixed colours per kind gave thirty-two distinct worlds across forty thousand, so
 * every desert in the atlas was one of four identical tans. The hue, saturation and
 * lightness are jittered from the seed instead, which keeps a kind recognisable at a
 * glance while making no two worlds the same.
 */
const WORLD_BASE_COLOR: Record<WorldKind, string> = {
  lava: '#6b2410',
  volcanic: '#c2a24a',
  carbon: '#2e2c30',
  iron: '#8a7f7a',
  greenhouse: '#d8c48a',
  desert: '#c9a06a',
  rocky: '#8d8378',
  terrestrial: '#5f8f5a',
  ocean: '#2f6aa5',
  hycean: '#3f8f93',
  ice: '#cdd9e4',
  snowball: '#eef4fa',
  superEarth: '#9a7f66',
  subNeptune: '#8fb4c9',
  iceGiant: '#6aa3bb',
  gasGiant: '#c8a67e',
  hotJupiter: '#b06a4a',
}

/** How far each kind's colour may wander: hue degrees, then saturation and lightness. */
const WORLD_COLOR_SPREAD: Record<WorldKind, readonly [number, number, number]> = {
  lava: [14, 0.18, 0.1],
  volcanic: [18, 0.2, 0.12],
  carbon: [20, 0.1, 0.05],
  iron: [12, 0.1, 0.1],
  greenhouse: [12, 0.16, 0.09],
  desert: [16, 0.18, 0.12],
  rocky: [20, 0.12, 0.12],
  terrestrial: [26, 0.2, 0.12],
  ocean: [20, 0.2, 0.13],
  hycean: [22, 0.2, 0.12],
  ice: [26, 0.14, 0.08],
  snowball: [30, 0.1, 0.05],
  superEarth: [22, 0.16, 0.12],
  subNeptune: [24, 0.2, 0.12],
  iceGiant: [22, 0.2, 0.12],
  gasGiant: [18, 0.2, 0.12],
  hotJupiter: [16, 0.2, 0.11],
}

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const sat = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, sat, l]
}

function hslToHex(h: number, sat: number, l: number): string {
  const hue = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = l - c / 2
  const seg = Math.floor(hue / 60) % 6
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][seg]
  const to = (v: number) =>
    Math.round(Math.min(255, Math.max(0, (v + m) * 255)))
      .toString(16)
      .padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/** One world's colour: its kind's, moved by an amount the seed decides. */
function worldColor(kind: WorldKind, rng: Rng): string {
  const [dh, ds, dl] = WORLD_COLOR_SPREAD[kind]
  const [h, sat, l] = hexToHsl(WORLD_BASE_COLOR[kind])
  return hslToHex(
    h + rng.signed() * dh,
    Math.min(0.95, Math.max(0.02, sat + rng.signed() * ds)),
    Math.min(0.95, Math.max(0.05, l + rng.signed() * dl)),
  )
}

/** Roman numerals, for moons, which is the convention the solar system's own moons use. */
const ROMAN = [
  'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
  'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX',
]

/** Planet letters, the convention the exoplanet catalogues use: the star is 'a'. */
const LETTERS = 'bcdefghijklmnopqrstuvwxyz'

/**
 * Mass from radius, by the broken power law the transiting-planet census shows.
 *
 * Small worlds are rocky and scale near rho = constant; above about 1.5 Earth radii the
 * relation flattens as volatiles arrive; above about 6 it inverts, because a more massive
 * gas giant is COMPRESSED rather than larger — Jupiter and a thirteen-Jupiter-mass brown
 * dwarf are nearly the same size. That inversion is why this is a function and not a
 * multiplication.
 */
function massFromRadius(radiusMetres: number): number {
  const re = radiusMetres / EARTH_RADIUS_M
  if (re <= 1.5) return EARTH_MASS_KG * Math.pow(re, 3.7)
  if (re <= 6) return EARTH_MASS_KG * 2.69 * Math.pow(re, 1.3)
  // Gas giants: radius is nearly flat against mass, so mass climbs very steeply with
  // the little radius there is. The exponent is set by making Jupiter come out right --
  // 11.2 Earth radii must give 318 Earth masses -- which lands it at 3.9.
  return EARTH_MASS_KG * 2.69 * Math.pow(6, 1.3) * Math.pow(re / 6, 3.9)
}

/** Main-sequence mass from luminosity, by the standard L ~ M^3.5 relation. */
function massFromLuminosity(luminositySun: number): number {
  return Math.pow(Math.max(luminositySun, 1e-6), 1 / 3.5)
}

/**
 * Effective temperature of a main-sequence star of this radius, in kelvin.
 *
 * From R ~ M^0.8 and L ~ M^3.5, with L = 4 pi R^2 sigma T^4. Only used where the
 * catalogue gave a radius and no spectral type, to keep the invented temperature from
 * contradicting the measured size.
 */
function mainSequenceTemperature(radiusMetres: number): number {
  const rSun = Math.max(radiusMetres / SOLAR_RADIUS_M, 1e-3)
  const mSun = Math.pow(rSun, 1 / 0.8)
  const lSun = Math.pow(mSun, 3.5)
  return 5772 * Math.pow(lSun / (rSun * rSun), 0.25)
}

/** Blackbody colour, roughly, for a star of this temperature. */
function starColor(temperatureK: number): string {
  const stops: readonly [number, string][] = [
    [2400, '#ffb56b'],
    [3200, '#ffc993'],
    [4200, '#ffdcb4'],
    [5200, '#ffeedd'],
    [6000, '#fff6ee'],
    [7500, '#f4f2ff'],
    [10000, '#dce4ff'],
    [20000, '#c3d2ff'],
    [40000, '#b4c6ff'],
  ]
  for (let i = 0; i < stops.length; i++) if (temperatureK <= stops[i][0]) return stops[i][1]
  return stops[stops.length - 1][1]
}

/**
 * Equilibrium temperature at a given distance, in kelvin, for zero albedo.
 *
 * The real quantity depends on albedo and on whatever greenhouse the atmosphere provides,
 * neither of which a generated world has in any meaningful sense. This is the version
 * with both set aside, which is also the version the habitable-zone bounds below assume,
 * so the two at least agree with each other.
 */
function equilibriumTemperature(luminositySun: number, distanceAu: number): number {
  const l = luminositySun * SOLAR_LUMINOSITY_W
  const d = distanceAu * AU_M
  return Math.pow(l / (16 * Math.PI * SIGMA_SB * d * d), 0.25)
}

/**
 * The conservative habitable zone, in AU, scaled from the solar case by sqrt(L).
 *
 * The bounds are the classic runaway-greenhouse and maximum-greenhouse limits, which for
 * the Sun fall near 0.95 and 1.67 AU. Scaling by the square root of luminosity is exact
 * for the flux at a given distance and ignores the temperature dependence of the limits
 * themselves, which is a percent-level effect and far below the honesty floor of a thing
 * that is invented anyway.
 */
export function habitableZoneAu(luminositySun: number): { inner: number; outer: number } {
  const s = Math.sqrt(Math.max(luminositySun, 1e-9))
  return { inner: 0.95 * s, outer: 1.67 * s }
}

/** Where water ice survives during formation. Beyond it, worlds are volatile-rich. */
export function frostLineAu(luminositySun: number): number {
  return 4.85 * Math.sqrt(Math.max(luminositySun, 1e-9))
}

/** Orbital period from Kepler's third law, in days. */
function periodDays(semiMajorAxisMetres: number, centralMassKg: number): number {
  const a = semiMajorAxisMetres
  return (2 * Math.PI * Math.sqrt((a * a * a) / (G * centralMassKg))) / DAY_S
}

/** The radius inside which tides would pull a moon apart, for similar densities. */
function rocheLimitMetres(planetRadius: number, planetMass: number, moonDensity = 3000): number {
  const planetDensity = planetMass / ((4 / 3) * Math.PI * Math.pow(planetRadius, 3))
  return planetRadius * 2.44 * Math.pow(planetDensity / moonDensity, 1 / 3)
}

/** The radius beyond which the star, not the planet, owns a moon's orbit. */
function hillRadiusMetres(semiMajorAxisMetres: number, planetMass: number, starMassKg: number): number {
  return semiMajorAxisMetres * Math.pow(planetMass / (3 * starMassKg), 1 / 3)
}

/**
 * A planet's radius in Earth radii, drawn from something shaped like the real one.
 *
 * Two features of the observed distribution are worth having. Sub-Neptunes -- a rocky
 * core under hydrogen it never lost -- are the commonest planets the transit surveys
 * found, and there is nothing remotely like one in the solar system, so a generator
 * seeded only on this system's intuitions produces a galaxy that looks wrong in a way
 * that is hard to name. And there is a real DEFICIT between about 1.5 and 2 Earth radii,
 * the radius valley: the planets that were going to lose their envelopes lost them, and
 * the ones that kept them kept more than that. Sampling flat across the gap would smear
 * away the one feature of the population a reader might recognise.
 *
 * Beyond the frost line there was ice to accrete, so giants dominate; inside it they are
 * rare and arrive by migration.
 */
function sampleRadiusEarths(rng: Rng, beyondFrost: boolean): number {
  const u = rng.next()
  if (beyondFrost) {
    if (u < 0.4) return rng.range(6, 13)
    if (u < 0.72) return rng.range(3.5, 6)
    if (u < 0.9) return rng.range(2, 3.5)
    return rng.logRange(0.3, 2)
  }
  if (u < 0.4) return rng.logRange(0.35, 1.5)
  // The valley. Narrow on purpose: this band is a fifth as likely per unit radius as
  // the ones either side of it.
  if (u < 0.45) return rng.range(1.5, 2)
  if (u < 0.84) return rng.range(2, 3.5)
  if (u < 0.96) return rng.range(3.5, 6)
  return rng.range(6, 12)
}

/** The seeded rolls that decide composition where size and temperature leave a choice. */
export interface WorldRolls {
  /** How much water the world kept, 0 to 1. Decides desert against ocean. */
  wet: number
  /** Draws the uncommon compositions, 0 to 1. */
  rare: number
  /** True for a moon close enough to its planet to be kneaded by tides. */
  tidallyHeated: boolean
}

/**
 * Which kind of world this is, from its size, its temperature and what it kept.
 *
 * Size decides first, because it decides whether there is a surface at all. Below that,
 * temperature sets the broad band and the seeded rolls settle what the data could never
 * tell you anyway: two worlds the same size at the same distance can be an ocean and a
 * desert, and which one you get is a question about its history.
 */
function classify(
  radiusMetres: number,
  equilibriumK: number,
  distanceAu: number,
  frostAu: number,
  roll: WorldRolls,
): WorldKind {
  const re = radiusMetres / EARTH_RADIUS_M

  // No surface anywhere: these are decided by size and temperature alone.
  // 700 K rather than 1000: the giants that migrated in span the hot and warm Jupiters,
  // and drawing the line at incandescence made the whole class round to zero per cent.
  if (re >= 6) return equilibriumK > 700 ? 'hotJupiter' : 'gasGiant'
  if (re >= 3.5) return 'iceGiant'
  if (re >= 2) return equilibriumK > 350 && equilibriumK < 800 && roll.rare < 0.3 ? 'hycean' : 'subNeptune'

  // Rocky worlds. The uncommon compositions first, since they override everything else
  // about what the surface is made of.
  if (roll.rare < 0.04) return 'carbon'
  if (roll.rare < 0.08 && re < 1.2) return 'iron'
  // Tidal heating needs the moon to be close AND the resonance to be there. Without the
  // second condition every giant's two inner moons came out volcanic and Io's kind was
  // the commonest world in the atlas at seventeen per cent, which is the opposite of
  // what makes Io worth knowing about.
  if (roll.tidallyHeated && equilibriumK < 500 && roll.rare < 0.45) return 'volcanic'

  if (equilibriumK > 1100) return 'lava'
  if (equilibriumK > 600) return roll.wet > 0.55 ? 'greenhouse' : 'desert'

  // Temperate, and inside the frost line, so whatever water it has is liquid. This is
  // the band that was unreachable before: `terrestrial` and `ocean` were declared,
  // given palettes, and never returned by anything, so no world in the atlas was ever
  // green or blue.
  if (equilibriumK >= 215 && equilibriumK <= 330 && distanceAu <= frostAu) {
    if (roll.wet > 0.74) return 'ocean'
    if (roll.wet > 0.26) return 'terrestrial'
    return 'desert'
  }

  if (equilibriumK < 150) return roll.wet > 0.5 ? 'ice' : 'snowball'
  if (distanceAu > frostAu) return 'ice'
  if (re >= 1.25) return 'superEarth'
  return 'rocky'
}

/**
 * Whether a world could hold liquid water at its surface, and the reason either way.
 *
 * Deliberately conservative and deliberately explained. The atlas says "habitable" about
 * nothing real, so when it says it about an invention it should at least mean something
 * definite: inside the star's habitable zone, solid, and big enough to keep an atmosphere
 * but not so big it is all atmosphere. A moon qualifies on the same terms as a planet,
 * which is the case the solar system never got to test and which the request asks for
 * explicitly.
 */
function habitability(
  kind: WorldKind,
  radiusMetres: number,
  distanceAu: number,
  zone: { inner: number; outer: number },
): { habitable: boolean; note: string } {
  const re = radiusMetres / EARTH_RADIUS_M
  if (kind === 'gasGiant' || kind === 'hotJupiter' || kind === 'iceGiant' || kind === 'subNeptune') {
    return { habitable: false, note: 'no surface to stand on' }
  }
  if (kind === 'hycean') return { habitable: false, note: 'an ocean, but under hydrogen rather than air' }
  if (kind === 'greenhouse') return { habitable: false, note: 'its own atmosphere holds the surface too hot' }
  if (kind === 'lava' || kind === 'carbon') return { habitable: false, note: 'no liquid water at this surface' }
  if (distanceAu < zone.inner) return { habitable: false, note: 'inside the inner edge: water boils off' }
  if (distanceAu > zone.outer) return { habitable: false, note: 'beyond the outer edge: water is ice' }
  if (re < 0.4) return { habitable: false, note: 'too small to hold an atmosphere' }
  if (re > 1.9) return { habitable: false, note: 'massive enough to have kept a thick envelope' }
  return { habitable: true, note: 'inside the habitable zone, with the size to keep an atmosphere' }
}

/**
 * Invent a plausible planetary system for a star.
 *
 * Pure, and a function of `star.id` alone through the seed, so the same star gives the
 * same system on every machine and a permalink stays true.
 */
export function generateSystem(star: StarSeedInput): GeneratedSystem {
  const seed = hashSeed(star.id)
  const rng = rngFrom(seed)

  // Where the catalogue gave a temperature or a radius, use them: the invention should at
  // least sit on whatever the atlas actually knows about this star.
  const radiusMetres =
    star.radiusMetres && star.radiusMetres > 0 ? star.radiusMetres : SOLAR_RADIUS_M * rng.logRange(0.2, 2.2)
  // Where the catalogue gave a radius but no spectral type, the temperature is taken
  // from the main sequence rather than from the seed. A star's radius and temperature
  // are not independent, and inventing them separately would produce a luminosity that
  // contradicts the one real number the atlas has about this star -- and with it a
  // habitable zone in the wrong place. R ~ M^0.8 and L ~ M^3.5 give both from the radius.
  const temperatureK =
    star.temperatureK && star.temperatureK > 1000
      ? star.temperatureK
      : mainSequenceTemperature(radiusMetres) * rng.range(0.94, 1.06)
  const luminositySun =
    (4 * Math.PI * radiusMetres * radiusMetres * SIGMA_SB * Math.pow(temperatureK, 4)) / SOLAR_LUMINOSITY_W
  const massSun = massFromLuminosity(luminositySun)
  const starMassKg = massSun * 1.98892e30

  const zone = habitableZoneAu(luminositySun)
  const frost = frostLineAu(luminositySun)

  const starOut: GeneratedStar = {
    massSun,
    radiusMetres,
    luminositySun,
    temperatureK,
    color: starColor(temperatureK),
  }

  // Orbits are laid out as a jittered geometric progression, which is what the solar
  // system and most multi-planet systems approximately are. A ratio always above 1.3
  // is what keeps neighbouring orbits from crossing no matter how the jitter falls, so
  // the non-crossing property is structural rather than something to check for after.
  const count = 1 + Math.floor(Math.pow(rng.next(), 0.75) * 9)
  const innermost = rng.logRange(0.05, 0.45) * Math.sqrt(Math.max(luminositySun, 0.02))
  const planets: GeneratedPlanet[] = []
  let axisAu = innermost

  for (let i = 0; i < count; i++) {
    if (i > 0) axisAu *= rng.range(1.45, 2.3)
    if (axisAu > 120) break

    const eqK = equilibriumTemperature(luminositySun, axisAu)
    // Size: giants form beyond the frost line where there was ice to accrete, and small
    // worlds dominate inside it. Hot Jupiters exist because some giants migrated in, so
    // a few are allowed to, rather than being forbidden by construction.
    const beyondFrost = axisAu > frost
    const radius = EARTH_RADIUS_M * sampleRadiusEarths(rng, beyondFrost)
    const massKg = massFromRadius(radius)
    const rolls: WorldRolls = { wet: rng.next(), rare: rng.next(), tidallyHeated: false }
    const kind = classify(radius, eqK, axisAu, frost, rolls)
    const { habitable, note } = habitability(kind, radius, axisAu, zone)

    const axisMetres = axisAu * AU_M
    const planet: GeneratedPlanet = {
      id: `${star.id}/${LETTERS[i] ?? `p${i}`}`,
      name: '',
      kind,
      radiusMetres: radius,
      massKg,
      color: worldColor(kind, rng),
      semiMajorAxisMetres: axisMetres,
      // Inner worlds circularise; outer ones keep more of what they formed with.
      eccentricity: Math.min(0.35, Math.abs(rng.signed()) * (beyondFrost ? 0.18 : 0.08)),
      inclinationDeg: rng.signed() * 3.5,
      nodeDeg: rng.range(0, 360),
      periapsisDeg: rng.range(0, 360),
      meanAnomalyDeg: rng.range(0, 360),
      periodDays: periodDays(axisMetres, starMassKg),
      equilibriumK: eqK,
      // Rings need a cold giant and something to have broken up inside the Roche limit.
      hasRings: (kind === 'gasGiant' || kind === 'iceGiant') && rng.chance(0.35),
      axialTiltDeg: Math.abs(rng.signed()) * 70,
      moons: [],
      habitable,
      habitabilityNote: note,
    }

    planet.moons = generateMoons(rng, planet, starMassKg, axisAu, zone)
    planets.push(planet)
  }

  return {
    starId: star.id,
    seed,
    star: starOut,
    habitableZoneAu: zone,
    frostLineAu: frost,
    planets,
    belts: generateBelts(rng, star.id, planets, frost),
  }
}

/**
 * Where the rubble is.
 *
 * A belt sits where a planet did not form, and the usual reason is that something large
 * nearby kept stirring the material until it could not accrete. So they are placed in the
 * widest gap between neighbouring orbits, and beyond the outermost planet, which is where
 * the solar system keeps both of its own.
 */
function generateBelts(rng: Rng, starId: string, planets: GeneratedPlanet[], frostAu: number): GeneratedBelt[] {
  const belts: GeneratedBelt[] = []
  if (planets.length === 0) return belts

  // The widest ratio gap between neighbours, if it is wide enough to be worth drawing.
  let widest = -1
  let gap = 1
  for (let i = 1; i < planets.length; i++) {
    const ratio = planets[i].semiMajorAxisMetres / planets[i - 1].semiMajorAxisMetres
    if (ratio > gap) {
      gap = ratio
      widest = i
    }
  }
  if (widest > 0 && gap > 1.9 && rng.chance(0.75)) {
    const inner = planets[widest - 1].semiMajorAxisMetres * rng.range(1.22, 1.38)
    const outer = planets[widest].semiMajorAxisMetres * rng.range(0.68, 0.82)
    if (outer > inner * 1.1) {
      belts.push({
        id: `${starId}/belt`,
        name: '',
        innerMetres: inner,
        outerMetres: outer,
        count: 2600 + Math.floor(rng.next() * 3200),
        color: '#9d8f7e',
        spreadDeg: rng.range(4, 14),
        description:
          'Asteroid belt. A planet did not form here. Something heavy nearby kept stirring the ' +
          'material until it could no longer stick together, and what is left has been grinding ' +
          'itself smaller ever since.',
      })
    }
  }

  // And the outer debris, beyond everything, where the ice never got used.
  const outermost = planets[planets.length - 1].semiMajorAxisMetres
  if (rng.chance(0.8)) {
    const inner = outermost * rng.range(1.25, 1.7)
    belts.push({
      id: `${starId}/outer-belt`,
      name: '',
      innerMetres: inner,
      outerMetres: inner * rng.range(1.6, 2.6),
      count: 3200 + Math.floor(rng.next() * 4200),
      color: '#8fa6b4',
      spreadDeg: rng.range(8, 26),
      description:
        'Outer debris belt. Ice and rock that never joined anything larger, spread thin and cold ' +
        `well beyond the frost line at ${frostAu.toFixed(1)} AU. Most of it has not been warm since it formed.`,
    })
  }
  return belts
}

/**
 * Moons for one planet, between its Roche limit and a third of its Hill radius.
 *
 * The outer bound is the usual stability rule for prograde satellites; the inner one is
 * where tides would take a moon apart, which is also where rings come from. A giant in
 * the habitable zone can therefore carry a habitable moon — the configuration the solar
 * system happens not to have and the one most worth being able to visit.
 */
function generateMoons(
  rng: Rng,
  planet: GeneratedPlanet,
  starMassKg: number,
  planetAxisAu: number,
  zone: { inner: number; outer: number },
): GeneratedMoon[] {
  const re = planet.radiusMetres / EARTH_RADIUS_M
  // Big worlds keep more moons; a sub-Earth rarely keeps any.
  const expected = re >= 6 ? rng.range(3, 12) : re >= 3.5 ? rng.range(2, 7) : re >= 1 ? rng.range(0, 2.6) : rng.range(0, 1.2)
  const count = Math.floor(expected)
  if (count <= 0) return []

  const roche = rocheLimitMetres(planet.radiusMetres, planet.massKg)
  const hill = hillRadiusMetres(planet.semiMajorAxisMetres, planet.massKg, starMassKg)
  const inner = Math.max(roche * 1.25, planet.radiusMetres * 2.2)
  const outer = hill / 3
  if (!(outer > inner * 1.4)) return []

  const moons: GeneratedMoon[] = []
  let axis = inner * rng.range(1.0, 1.6)
  for (let i = 0; i < count; i++) {
    if (i > 0) axis *= rng.range(1.4, 2.1)
    if (axis > outer) break

    // A moon is at its planet's distance from the star, so it shares the planet's
    // temperature and therefore its place relative to the habitable zone.
    const radius = EARTH_RADIUS_M * rng.logRange(0.02, re >= 6 ? 0.42 : 0.25)
    const eqK = planet.equilibriumK
    // The inner moons of a giant are kneaded by tides the way Io is, which is what makes
    // the most volcanically active body in the solar system a moon rather than a planet.
    const rolls: WorldRolls = { wet: rng.next(), rare: rng.next(), tidallyHeated: re >= 3.5 && i === 0 }
    const kind = classify(radius, eqK, planetAxisAu, Infinity, rolls)
    const { habitable, note } = habitability(kind, radius, planetAxisAu, zone)
    moons.push({
      id: `${planet.id}/${ROMAN[i] ?? `m${i}`}`,
      name: '',
      kind,
      radiusMetres: radius,
      color: worldColor(kind, rng),
      semiMajorAxisMetres: axis,
      eccentricity: Math.abs(rng.signed()) * 0.06,
      inclinationDeg: rng.signed() * 6,
      nodeDeg: rng.range(0, 360),
      periapsisDeg: rng.range(0, 360),
      meanAnomalyDeg: rng.range(0, 360),
      periodDays: periodDays(axis, planet.massKg),
      habitable,
      habitabilityNote: habitable ? 'a habitable moon: in the zone, and large enough to hold air' : note,
    })
  }
  return moons
}

/** Human-readable names, applied in place once the caller knows the star's own name. */
export function nameSystem(system: GeneratedSystem, starName: string): GeneratedSystem {
  for (const belt of system.belts) {
    belt.name = belt.id.endsWith('outer-belt') ? `${starName} Outer Belt` : `${starName} Belt`
  }
  for (let i = 0; i < system.planets.length; i++) {
    const planet = system.planets[i]
    planet.name = `${starName} ${LETTERS[i] ?? `p${i}`}`
    for (let j = 0; j < planet.moons.length; j++) {
      planet.moons[j].name = `${planet.name} ${ROMAN[j] ?? `m${j}`}`
    }
  }
  return system
}
