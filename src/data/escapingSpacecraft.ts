/**
 * The five spacecraft on their way out of the solar system.
 *
 * Shared because two modules need the same numbers and must not disagree about them:
 * `heliosphere` draws the four Voyager boundary crossings along these bearings, and
 * `spacecraft` draws the probes themselves. A bearing written down twice is a bearing
 * that will eventually be written down differently.
 *
 * ## Where the positions come from
 *
 * One table, read at one moment, rather than five press releases of five different
 * ages: Heavens-Above's solar-escape page, retrieved 2026-11-10. It publishes
 * heliocentric distance — which matters, because almost every figure in circulation
 * for these craft ("Voyager 1 is 172.5 AU away") is the distance from EARTH, a
 * different number by up to an AU depending on the time of year.
 *
 * It is an ephemeris, not an observation, and for the two Pioneers it is not even a
 * prediction anybody is checking: nothing has been heard from Pioneer 11 since 1995 or
 * Pioneer 10 since 2003. `lastContactIso` is what separates the two cases, and the
 * inspector says which it is looking at.
 *
 * ## Why the Voyagers are not anchored here
 *
 * They are, for the bearing, and are not, for the distance. The `heliosphere` module
 * propagates them from their heliopause crossings instead, because those are dated
 * heliocentric distances in primary literature. That model and this table were
 * computed independently and agree to 0.07 AU for Voyager 1 and 0.5 AU for Voyager 2,
 * which is the cross-check that says the propagation is sound; see the test.
 */

/** A spacecraft leaving the solar system, with a dated heliocentric state. */
export interface EscapingSpacecraft {
  id: string
  name: string
  /** Escape bearing, ICRS. At these distances the asymptote moves by well under a degree per decade. */
  raDeg: number
  decDeg: number
  /** Heliocentric distance at `epochIso`, AU. */
  distanceAu: number
  epochIso: string
  /** Recession rate at that epoch, AU per year. */
  auPerYear: number
  /** Heliocentric speed at that epoch, km/s — the same quantity, in the unit it is usually quoted in. */
  speedKmS: number
  /** Null while it is still being tracked; otherwise the date the last signal arrived. */
  lastContactIso: string | null
  launchedIso: string
  /** The constellation it is heading into. Not a destination: nothing is waiting there. */
  heading: string
  /** Which schematic to build; see the `spacecraft` module. */
  design: 'voyager' | 'pioneer' | 'new-horizons'
  /** Half the high-gain antenna, in metres — the published dimension, and the largest one. */
  antennaRadiusMetres: number
}

const SOURCE = 'Heavens-Above solar-escape ephemeris, retrieved 2026-11-10'

export const ESCAPE_STATE_SOURCE = SOURCE

export const ESCAPING_SPACECRAFT: readonly EscapingSpacecraft[] = [
  {
    id: 'craft:voyager-1',
    name: 'Voyager 1',
    raDeg: 259.0,
    decDeg: 12.083,
    distanceAu: 172.367,
    epochIso: '2026-11-10',
    auPerYear: 3.569,
    speedKmS: 16.917,
    lastContactIso: null,
    launchedIso: '1977-09-05',
    heading: 'Ophiuchus',
    design: 'voyager',
    antennaRadiusMetres: 1.85,
  },
  {
    id: 'craft:voyager-2',
    name: 'Voyager 2',
    raDeg: 301.25,
    decDeg: -59.733,
    distanceAu: 144.39,
    epochIso: '2026-11-10',
    auPerYear: 3.218,
    speedKmS: 15.255,
    lastContactIso: null,
    launchedIso: '1977-08-20',
    heading: 'Pavo',
    design: 'voyager',
    antennaRadiusMetres: 1.85,
  },
  {
    id: 'craft:pioneer-10',
    name: 'Pioneer 10',
    raDeg: 78.5,
    decDeg: 26.017,
    distanceAu: 142.262,
    epochIso: '2026-11-10',
    auPerYear: 2.502,
    speedKmS: 11.862,
    // The RTGs faded until the transmitter could not run. Nobody has heard it since.
    lastContactIso: '2003-01-23',
    launchedIso: '1972-03-03',
    heading: 'Taurus',
    design: 'pioneer',
    antennaRadiusMetres: 1.37,
  },
  {
    id: 'craft:pioneer-11',
    name: 'Pioneer 11',
    raDeg: 283.5,
    decDeg: -9.017,
    distanceAu: 119.637,
    epochIso: '2026-11-10',
    auPerYear: 2.346,
    speedKmS: 11.123,
    lastContactIso: '1995-11-24',
    launchedIso: '1973-04-06',
    heading: 'Scutum',
    design: 'pioneer',
    antennaRadiusMetres: 1.37,
  },
  {
    id: 'craft:new-horizons',
    name: 'New Horizons',
    raDeg: 288.75,
    decDeg: -20.3,
    distanceAu: 66.011,
    epochIso: '2026-11-10',
    auPerYear: 2.861,
    speedKmS: 13.562,
    lastContactIso: null,
    launchedIso: '2006-01-19',
    heading: 'Sagittarius',
    design: 'new-horizons',
    antennaRadiusMetres: 1.05,
  },
]

/** Look one up by id, for the modules that only want one or two of them. */
export function escapingSpacecraft(id: string): EscapingSpacecraft | undefined {
  return ESCAPING_SPACECRAFT.find((craft) => craft.id === id)
}
