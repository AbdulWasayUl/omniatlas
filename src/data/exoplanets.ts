import { assetUrl } from './assetUrl'
import {
  type GeneratedPlanet,
  type GeneratedSystem,
  classify,
  frostLineAu,
  habitableZoneAu,
  starColor,
  worldColor,
} from '../generators/system'
import { hashSeed, rngFrom } from '../generators/random'

/**
 * The planets that are actually there.
 *
 * The atlas has shipped a NASA Exoplanet Archive match manifest since the star data was
 * built: it knows that 1,018 of the stars it draws have measured planets. Nothing read
 * it. So immersive mode cheerfully invented planets around Cervantes, which has four
 * real ones, and around 129 other named stars whose systems are in the literature — the
 * single thing this atlas is built not to do, done at scale and in the one mode whose
 * whole job is to be honest about invention.
 *
 * `exoplanet-systems.json` adds the orbits. This module turns a row of it into the same
 * shape the generator produces, so one renderer can draw both and the only difference is
 * what the inspector is allowed to claim.
 *
 * WHAT IS MEASURED, and it is worth being exact, because a planet drawn beside an
 * invented one has to be able to say how it differs:
 *
 *   - measured: the size, shape and period of the orbit; the planet's radius and mass,
 *     where the archive publishes them.
 *   - derived: anything the archive leaves null that physics can supply from what it
 *     does publish — a period from a separation and a stellar mass, a radius from a
 *     mass, an equilibrium temperature from the star and the separation.
 *   - drawn: everything about the body's appearance, and WHERE ALONG its orbit it sits
 *     at a given instant. The archive gives a transit mid-point for some and nothing for
 *     most, so phase is seeded from the planet's name. The inspector says so.
 */

const DATA = '/data/stars'

const EARTH_RADIUS_M = 6.371e6
const EARTH_MASS_KG = 5.9722e24
const SOLAR_RADIUS_M = 6.957e8
const AU_M = 1.495978707e11
const SUN_TEFF_K = 5772

export interface ExoplanetRow {
  name: string
  semiMajorAxisAu: number | null
  periodDays: number | null
  radiusEarths: number | null
  massEarths: number | null
  eccentricity: number | null
  inclinationDeg: number | null
  equilibriumK: number | null
}

export interface ExoplanetSystemRow {
  host: string
  /** Global index into the l0 ++ l1 star concatenation; `star:<i>` is the node id. */
  star: number
  tier: string
  via: string
  teffK: number | null
  radiusSun: number | null
  massSun: number | null
  planets: ExoplanetRow[]
}

/** Which of a world's numbers came from the archive, as opposed to physics or a seed. */
export interface Measured {
  semiMajorAxis: boolean
  period: boolean
  radius: boolean
  mass: boolean
  eccentricity: boolean
  inclination: boolean
  equilibrium: boolean
}

export interface MeasuredWorld extends GeneratedPlanet {
  /** The archive's name for it, e.g. "55 Cnc e". */
  catalogueName: string
  measured: Measured
}

export interface MeasuredSystem extends GeneratedSystem {
  host: string
  planets: MeasuredWorld[]
  /** How many of this system's planets have a published radius. */
  withPublishedRadius: number
}

interface Payload {
  retrieved: string
  attribution: string
  systemCount: number
  planetCount: number
  systems: ExoplanetSystemRow[]
}

let cache: Promise<Map<number, ExoplanetSystemRow>> | null = null

/**
 * The table, indexed by star index, fetched once.
 *
 * 48 KB over the wire. Deferred like every other dataset, and a failure is not fatal:
 * without it the atlas is exactly what it was before, which is to say it invents.
 */
export function loadExoplanetSystems(): Promise<Map<number, ExoplanetSystemRow>> {
  if (cache) return cache
  cache = fetch(assetUrl(`${DATA}/exoplanet-systems.json`))
    .then((r) => (r.ok ? (r.json() as Promise<Payload>) : null))
    .then((payload) => {
      const byStar = new Map<number, ExoplanetSystemRow>()
      if (!payload) return byStar
      for (const system of payload.systems) byStar.set(system.star, system)
      return byStar
    })
    .catch(() => new Map<number, ExoplanetSystemRow>())
  return cache
}

/** Only for tests, which must not inherit a map another test loaded. */
export function resetExoplanetCache(): void {
  cache = null
}

/**
 * A radius from a mass, for the planets the archive weighed but never measured.
 *
 * Chen & Kipping (2017), the broken power law their hierarchical fit produces, with the
 * breaks at 2.04 and 132 Earth masses. It is a population relation and not a measurement
 * of this planet, which is why anything using it is flagged derived rather than measured.
 */
export function radiusFromMassEarths(massEarths: number): number {
  const m = Math.max(1e-3, massEarths)
  if (m < 2.04) return Math.pow(m, 0.279)
  const terranAtBreak = Math.pow(2.04, 0.279)
  if (m < 132) return terranAtBreak * Math.pow(m / 2.04, 0.589)
  const neptunianAtBreak = terranAtBreak * Math.pow(132 / 2.04, 0.589)
  // Degenerate: a Jovian gets very slightly SMALLER as mass rises.
  return neptunianAtBreak * Math.pow(m / 132, -0.044)
}

/** Kepler's third law, in the units the archive publishes. */
function periodFromAxis(axisAu: number, massSun: number): number {
  return 365.25 * Math.sqrt(Math.pow(axisAu, 3) / Math.max(0.02, massSun))
}
function axisFromPeriod(periodDays: number, massSun: number): number {
  return Math.cbrt(Math.max(0.02, massSun) * Math.pow(periodDays / 365.25, 2))
}

/**
 * A measured system in the shape the renderer already understands.
 *
 * Returns null where the row has no planet that can be placed at all, which keeps the
 * caller from building an empty system and standing invention down for nothing.
 */
export function measuredSystem(row: ExoplanetSystemRow, starId: string): MeasuredSystem | null {
  const teffK = row.teffK && row.teffK > 1000 ? row.teffK : SUN_TEFF_K
  const radiusSun = row.radiusSun && row.radiusSun > 0 ? row.radiusSun : 1
  const massSun = row.massSun && row.massSun > 0 ? row.massSun : 1
  const starRadiusMetres = radiusSun * SOLAR_RADIUS_M
  const luminositySun = radiusSun * radiusSun * Math.pow(teffK / SUN_TEFF_K, 4)
  const zone = habitableZoneAu(luminositySun)
  const frostAu = frostLineAu(luminositySun)

  const planets: MeasuredWorld[] = []
  let withPublishedRadius = 0

  for (const p of row.planets) {
    const hasAxis = p.semiMajorAxisAu !== null && p.semiMajorAxisAu > 0
    const hasPeriod = p.periodDays !== null && p.periodDays > 0
    if (!hasAxis && !hasPeriod) continue

    const axisAu = hasAxis ? (p.semiMajorAxisAu as number) : axisFromPeriod(p.periodDays as number, massSun)
    const periodDays = hasPeriod ? (p.periodDays as number) : periodFromAxis(axisAu, massSun)
    const hasMass = p.massEarths !== null && p.massEarths > 0
    const hasRadius = p.radiusEarths !== null && p.radiusEarths > 0
    if (hasRadius) withPublishedRadius += 1
    const radiusEarths = hasRadius
      ? (p.radiusEarths as number)
      : hasMass
        ? radiusFromMassEarths(p.massEarths as number)
        : 1
    const massEarths = hasMass ? (p.massEarths as number) : Math.pow(radiusEarths, 1 / 0.279)

    // Equilibrium temperature for zero albedo, the same convention the generator uses.
    const equilibriumK =
      p.equilibriumK !== null && p.equilibriumK > 0
        ? p.equilibriumK
        : teffK * Math.sqrt(starRadiusMetres / (2 * axisAu * AU_M))

    // Seeded from the planet's OWN catalogue name, so two atlases agree and a link to
    // 55 Cnc e shows the same world. Nothing here is a measurement and the inspector
    // never says it is.
    const rng = rngFrom(hashSeed(`exo:${p.name}`))
    const radiusMetres = radiusEarths * EARTH_RADIUS_M
    const kind = classify(radiusMetres, equilibriumK, axisAu, frostAu, {
      wet: rng.next(),
      rare: rng.next(),
      tidallyHeated: false,
    })
    const habitable = (kind === 'ocean' || kind === 'terrestrial') && axisAu >= zone.inner && axisAu <= zone.outer

    planets.push({
      // Same shape as a generated world's id and for the same reason: the id carries
      // its own host, so a permalink straight to a planet can anchor the star, wait for
      // the system to build, and then land. Both prefixes are four characters, which is
      // what lets `urlState` slice the host out of either without a second branch.
      id: `exo:${starId}/${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      catalogueName: p.name,
      name: p.name,
      kind,
      radiusMetres,
      color: worldColor(kind, rng),
      semiMajorAxisMetres: axisAu * AU_M,
      eccentricity: p.eccentricity !== null && p.eccentricity >= 0 ? p.eccentricity : 0,
      // Published inclination is against the LINE OF SIGHT, not a shared plane, so it
      // cannot be dropped straight into a common orbital frame: two planets of one
      // system both published at 89 degrees are not thereby edge-on to each other. The
      // atlas draws a near-common plane with a seeded tilt and says the plane is drawn.
      inclinationDeg: rng.range(-2.5, 2.5),
      nodeDeg: rng.range(0, 360),
      periapsisDeg: rng.range(0, 360),
      meanAnomalyDeg: rng.range(0, 360),
      periodDays,
      massKg: massEarths * EARTH_MASS_KG,
      equilibriumK,
      hasRings: false,
      axialTiltDeg: 0,
      moons: [],
      habitable,
      habitabilityNote: habitable
        ? 'Inside the conservative habitable zone for this star. Nothing is known about its surface.'
        : 'Outside the conservative habitable zone for this star.',
      measured: {
        semiMajorAxis: hasAxis,
        period: hasPeriod,
        radius: hasRadius,
        mass: hasMass,
        eccentricity: p.eccentricity !== null,
        inclination: p.inclinationDeg !== null,
        equilibrium: p.equilibriumK !== null,
      },
    })
  }

  if (planets.length === 0) return null
  planets.sort((a, b) => a.semiMajorAxisMetres - b.semiMajorAxisMetres)

  return {
    host: row.host,
    starId,
    seed: hashSeed(`exo:${row.host}`),
    star: {
      massSun,
      radiusMetres: starRadiusMetres,
      luminositySun,
      temperatureK: teffK,
      color: starColor(teffK),
    },
    habitableZoneAu: zone,
    frostLineAu: frostAu,
    planets,
    belts: [],
    withPublishedRadius,
  }
}

/**
 * What the archive actually says about a world, as a sentence.
 *
 * Deliberately NOT `describeWorld`. That writes evocative prose about an invented place
 * — what the ground is like underfoot, what the sky does — which is exactly right for
 * something invented and a lie about something real. A measured planet gets its numbers,
 * with every one of them marked as published or derived, and nothing else.
 */
export function describeMeasuredWorld(world: MeasuredWorld, starName: string): string {
  const parts: string[] = []
  const au = world.semiMajorAxisMetres / AU_M
  const re = world.radiusMetres / EARTH_RADIUS_M
  const me = world.massKg / EARTH_MASS_KG

  const axis = au < 0.1 ? `${au.toFixed(4)} AU` : `${au.toFixed(3)} AU`
  const period =
    world.periodDays < 1
      ? `${(world.periodDays * 24).toFixed(1)} hours`
      : world.periodDays < 900
        ? `${world.periodDays.toFixed(world.periodDays < 10 ? 2 : 1)} days`
        : `${(world.periodDays / 365.25).toFixed(1)} years`

  parts.push(
    `Orbits ${starName} at ${axis}${world.measured.semiMajorAxis ? '' : ' (derived)'}, ` +
      `once every ${period}${world.measured.period ? '' : ' (derived)'}.`,
  )
  parts.push(
    `${re < 10 ? re.toFixed(2) : re.toFixed(1)} Earth radii` +
      `${world.measured.radius ? '' : ' (estimated from its mass)'}, ` +
      `${me < 10 ? me.toFixed(2) : Math.round(me).toLocaleString('en-GB')} Earth masses` +
      `${world.measured.mass ? '' : ' (estimated from its radius)'}.`,
  )
  if (world.eccentricity > 0.08) {
    parts.push(
      `Its orbit is noticeably eccentric at e = ${world.eccentricity.toFixed(3)}` +
        `${world.measured.eccentricity ? '' : ' (assumed circular)'}.`,
    )
  }
  parts.push(
    `Equilibrium temperature ${Math.round(world.equilibriumK)} K` +
      `${world.measured.equilibrium ? '' : ', computed from the star and this separation'}.`,
  )
  return parts.join(' ')
}
