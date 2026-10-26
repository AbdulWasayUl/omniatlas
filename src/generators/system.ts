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

/** 32-bit string hash (xmur3), used only to turn a stable id into a stable seed. */
function hashSeed(text: string): number {
  let h = 1779033703 ^ text.length
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^= h >>> 16) >>> 0
}

/** mulberry32: the same generator `scripts/build-galaxy.mjs` seeds the disc field with. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A small deterministic random source with the shapes this file actually needs. */
interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number
  /** Log-uniform in [lo, hi): the right default for a quantity spanning decades. */
  logRange(lo: number, hi: number): number
  /** True with probability p. */
  chance(p: number): boolean
  /** One item, uniformly. */
  pick<T>(items: readonly T[]): T
  /** Roughly normal, via the sum of three uniforms; clamped to +/- 1. */
  signed(): number
}

function rngFrom(seed: number): Rng {
  const r = mulberry32(seed)
  const rng: Rng = {
    next: r,
    range: (lo, hi) => lo + (hi - lo) * r(),
    logRange: (lo, hi) => Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * r()),
    chance: (p) => r() < p,
    pick: (items) => items[Math.min(items.length - 1, Math.floor(r() * items.length))],
    signed: () => Math.min(1, Math.max(-1, ((r() + r() + r()) / 3 - 0.5) * 3.4)),
  }
  return rng
}

// --- constants, in SI unless the name says otherwise -------------------------

const AU_M = 1.495978707e11
const SOLAR_RADIUS_M = 6.957e8
const SOLAR_LUMINOSITY_W = 3.828e26
const EARTH_RADIUS_M = 6.371e6
const EARTH_MASS_KG = 5.972e24
const JUPITER_RADIUS_M = 6.9911e7
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
  | 'desert'
  | 'rocky'
  | 'terrestrial'
  | 'ocean'
  | 'ice'
  | 'superEarth'
  | 'iceGiant'
  | 'gasGiant'
  | 'hotJupiter'

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

const WORLD_COLORS: Record<WorldKind, readonly string[]> = {
  lava: ['#4a1a10', '#5a1f12', '#6b2410', '#7a2b14'],
  desert: ['#c9a06a', '#d4b483', '#b8895a', '#caa472'],
  rocky: ['#8d8378', '#9b9188', '#7a7066', '#a09488'],
  terrestrial: ['#6f8f6a', '#7d9a72', '#5f8468', '#86a07a'],
  ocean: ['#3b6ea5', '#2f5f93', '#4a7cb0', '#35689c'],
  ice: ['#cdd9e4', '#dae4ee', '#bccadb', '#e2eaf2'],
  superEarth: ['#8a7f6f', '#9a8b76', '#7b7264', '#a3917a'],
  iceGiant: ['#7fb6c9', '#6aa3bb', '#8ec3d4', '#5f9ab4'],
  gasGiant: ['#c8a67e', '#d8b98f', '#b89270', '#cfae86'],
  hotJupiter: ['#b06a4a', '#c07a52', '#a05c40', '#cc8a5e'],
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

/** Which kind of world sits at this distance, given its size and temperature. */
function classify(radiusMetres: number, equilibriumK: number, distanceAu: number, frostAu: number): WorldKind {
  const re = radiusMetres / EARTH_RADIUS_M
  if (re >= 6) return equilibriumK > 700 ? 'hotJupiter' : 'gasGiant'
  if (re >= 3.5) return 'iceGiant'
  if (equilibriumK > 800) return 'lava'
  if (distanceAu > frostAu || equilibriumK < 180) return 'ice'
  if (re >= 1.6) return 'superEarth'
  if (equilibriumK > 320) return 'desert'
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
  if (kind === 'gasGiant' || kind === 'hotJupiter' || kind === 'iceGiant') {
    return { habitable: false, note: 'no surface to stand on' }
  }
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
    const migrated = !beyondFrost && rng.chance(0.06)
    let radius: number
    if (beyondFrost || migrated) {
      radius = rng.chance(0.55) ? JUPITER_RADIUS_M * rng.range(0.55, 1.35) : EARTH_RADIUS_M * rng.range(3.4, 5.6)
    } else {
      radius = EARTH_RADIUS_M * rng.logRange(0.32, 2.4)
    }
    const massKg = massFromRadius(radius)
    const kind = classify(radius, eqK, axisAu, frost)
    const { habitable, note } = habitability(kind, radius, axisAu, zone)

    const axisMetres = axisAu * AU_M
    const planet: GeneratedPlanet = {
      id: `${star.id}/${LETTERS[i] ?? `p${i}`}`,
      name: '',
      kind,
      radiusMetres: radius,
      massKg,
      color: rng.pick(WORLD_COLORS[kind]),
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

  return { starId: star.id, seed, star: starOut, habitableZoneAu: zone, frostLineAu: frost, planets }
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
    const kind = classify(radius, eqK, planetAxisAu, Infinity)
    const { habitable, note } = habitability(kind, radius, planetAxisAu, zone)
    moons.push({
      id: `${planet.id}/${ROMAN[i] ?? `m${i}`}`,
      name: '',
      kind,
      radiusMetres: radius,
      color: rng.pick(WORLD_COLORS[kind]),
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
  for (let i = 0; i < system.planets.length; i++) {
    const planet = system.planets[i]
    planet.name = `${starName} ${LETTERS[i] ?? `p${i}`}`
    for (let j = 0; j < planet.moons.length; j++) {
      planet.moons[j].name = `${planet.name} ${ROMAN[j] ?? `m${j}`}`
    }
  }
  return system
}
