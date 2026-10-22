import { AU_M, GPC_M, KPC_M, LY_M, MPC_M, PC_M, lightTravelYears } from '../core/world'

/**
 * Distance formatting.
 *
 * Every distance in the UI goes through here, and every distance carries a *kind*.
 * Past the Local Group "distance" stops being one thing — a redshift-derived number
 * and a Cepheid-derived number are not comparable, and quoting either without saying
 * which is the single easiest way for an atlas to mislead.
 */

export type DistanceKind =
  | 'geometric' /** directly measured: parallax, radar, TRGB, Cepheid */
  | 'redshift' /** inferred from recession velocity and a cosmology */
  | 'comoving' /** present-day separation, cosmology-dependent */
  | 'luminosity' /** from apparent vs absolute brightness */
  | 'model' /** from a fitted structural model, not an observation of this object */

export const DISTANCE_KIND_LABEL: Record<DistanceKind, string> = {
  geometric: 'geometric distance',
  redshift: 'redshift distance',
  comoving: 'comoving distance',
  luminosity: 'luminosity distance',
  model: 'model distance',
}

export interface FormattedDistance {
  /** The number and its unit, ready to render. */
  text: string
  /** Light travel time, where it adds meaning. Empty below one light-minute. */
  lightTime: string
  unit: string
  value: number
}

function round(value: number): string {
  if (value >= 1000) return Math.round(value).toLocaleString('en-GB')
  if (value >= 100) return value.toFixed(0)
  if (value >= 10) return value.toFixed(1)
  if (value >= 1) return value.toFixed(2)
  return value.toFixed(3)
}

/**
 * The unit ladder, smallest first.
 *
 * Note the deliberate gap at the bottom: kilometres give way to AU at about a tenth of
 * an AU, and AU gives way to light-years well before a parsec, because that is where
 * each unit stops being legible rather than where it stops being valid. Above that the
 * breaks are at the unit's own thousand, which is the part that used to be wrong: the
 * ladder was cut in the PARSEC family (0.5 kpc, 0.5 Mpc, 500 Mpc) while the values were
 * printed in the LIGHT-YEAR family, so every band ran to 1,630 of itself before handing
 * over and the HUD read "1,057 Mly" where it meant "1.06 Gly".
 *
 * The breaks inside the light-year family are at 999.5 of the unit, not at 1000,
 * because `round` formats [100, 1000) with toFixed(0): 999.6 kly renders as the string
 * "1000 kly", a four-digit readout the next unit up would have shown as "1.00 Mly".
 * Cutting on the raw magnitude cannot see that; cutting on what will be printed can.
 */
const DISTANCE_UNITS: { divisor: number; unit: string; until: number }[] = [
  { divisor: 1, unit: 'm', until: 1000 },
  { divisor: 1000, unit: 'km', until: 0.05 * AU_M },
  { divisor: AU_M, unit: 'AU', until: 0.2 * LY_M },
  { divisor: LY_M, unit: 'ly', until: 999.5 * LY_M },
  { divisor: 1000 * LY_M, unit: 'kly', until: 999.5e3 * LY_M },
  { divisor: 1e6 * LY_M, unit: 'Mly', until: 999.5e6 * LY_M },
  { divisor: 1e9 * LY_M, unit: 'Gly', until: Number.POSITIVE_INFINITY },
]

/**
 * Format a distance in metres, choosing the unit an astronomer would use at that scale.
 */
export function formatDistance(metres: number): FormattedDistance {
  // NaN reaches here from the camera whenever a flight path degenerates, and a HUD
  // reading "NaN Gly" presents a broken number as a measurement.
  if (!Number.isFinite(metres)) return { text: 'Unknown', unit: '', value: 0, lightTime: '' }

  const m = Math.abs(metres)
  // A caller may hand this a signed separation — a difference of two coordinates, an
  // altitude measured from a catalogue radius — and dropping the sign would claim the
  // opposite of what was measured. Nothing in the UI feeds it a negative today; the
  // branch is here so that the first thing that does cannot print one as positive.
  const sign = metres < 0 ? '−' : ''

  const chosen = DISTANCE_UNITS.find((rung) => m < rung.until) ?? DISTANCE_UNITS[DISTANCE_UNITS.length - 1]
  const value = m / chosen.divisor
  return {
    text: `${sign}${round(value)} ${chosen.unit}`,
    unit: chosen.unit,
    value,
    lightTime: formatLightTime(m),
  }
}

/** Light travel time across a distance, phrased the way a person would say it. */
export function formatLightTime(metres: number): string {
  const seconds = metres / 299_792_458
  if (seconds < 1) return ''
  if (seconds < 90) return `${seconds.toFixed(1)} light-seconds`
  if (seconds < 5400) return `${(seconds / 60).toFixed(1)} light-minutes`
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} light-hours`
  if (seconds < 86_400 * 400) return `${(seconds / 86_400).toFixed(1)} light-days`
  const years = lightTravelYears(metres)
  if (years < 1000) return `${round(years)} years of light travel`
  if (years < 1e6) return `${round(years / 1000)} thousand years of light travel`
  if (years < 1e9) return `${round(years / 1e6)} million years of light travel`
  return `${round(years / 1e9)} billion years of light travel`
}

/**
 * A nice round scale-bar length at or below `metres`, with its label.
 * Snaps to 1, 2 or 5 times a power of ten so the bar reads as a ruler.
 */
export function chooseScaleBar(metres: number): { metres: number; label: string } {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(metres, 1e-6)))
  const multiple = [1, 2, 5, 10].reduce((best, candidate) => (candidate * magnitude <= metres ? candidate : best), 1)
  const chosen = multiple * magnitude
  return { metres: chosen, label: formatDistance(chosen).text }
}

/** Parsecs for callers that work in catalogue units. */
export function metresToParsecs(metres: number): number {
  return metres / PC_M
}

export function parsecsToMetres(parsecs: number): number {
  return parsecs * PC_M
}

export { AU_M, LY_M, PC_M, KPC_M, MPC_M, GPC_M }

/** UTC timestamp, fixed-width so it does not jitter as the clock ticks. */
export function formatUtc(epochMs: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(epochMs))
}

/** Simulation rate as a phrase rather than a multiplier nobody can picture. */
export function formatRate(secondsPerSecond: number): string {
  const r = Math.abs(secondsPerSecond)
  if (r === 0) return 'Paused'
  if (r === 1) return 'Real time'
  const sign = secondsPerSecond < 0 ? '−' : ''
  if (r < 60) return `${sign}${r.toFixed(0)}× real time`
  if (r < 3600) return `${sign}${(r / 60).toFixed(0)} min / second`
  // Pluralise from the number that is actually printed, never from the raw quotient:
  // 3600 and 86,400 are both rungs on the UI's own rate ladder, so "1 hours / second"
  // and "1 days / second" were two ungrammatical stops in a five-item sequence.
  if (r < 86_400) {
    const n = Math.round(r / 3600)
    return `${sign}${n} hour${n === 1 ? '' : 's'} / second`
  }
  if (r < 86_400 * 365) {
    const n = Math.round(r / 86_400)
    return `${sign}${n} day${n === 1 ? '' : 's'} / second`
  }
  const years = (r / (86_400 * 365.25)).toFixed(1).replace(/\.0$/, '')
  return `${sign}${years} year${years === '1' ? '' : 's'} / second`
}
