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
 * Format a distance in metres, choosing the unit an astronomer would use at that scale.
 * Note the deliberate gap: kilometres give way to AU at about a tenth of an AU, and AU
 * gives way to light-years well before a parsec, because that is where each unit stops
 * being legible rather than where it stops being valid.
 */
export function formatDistance(metres: number): FormattedDistance {
  const m = Math.abs(metres)
  let text: string
  let unit: string
  let value: number

  if (m < 1000) {
    value = m
    unit = 'm'
    text = `${round(value)} m`
  } else if (m < 0.05 * AU_M) {
    value = m / 1000
    unit = 'km'
    text = `${round(value)} km`
  } else if (m < 0.2 * LY_M) {
    value = m / AU_M
    unit = 'AU'
    text = `${round(value)} AU`
  } else if (m < 0.5 * KPC_M) {
    value = m / LY_M
    unit = 'ly'
    text = `${round(value)} ly`
  } else if (m < 0.5 * MPC_M) {
    value = m / (1000 * LY_M)
    unit = 'kly'
    text = `${round(value)} kly`
  } else if (m < 500 * MPC_M) {
    value = m / (1e6 * LY_M)
    unit = 'Mly'
    text = `${round(value)} Mly`
  } else {
    value = m / (1e9 * LY_M)
    unit = 'Gly'
    text = `${round(value)} Gly`
  }

  return { text, unit, value, lightTime: formatLightTime(m) }
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
  if (r < 86_400) return `${sign}${(r / 3600).toFixed(0)} hours / second`
  if (r < 86_400 * 365) return `${sign}${(r / 86_400).toFixed(0)} days / second`
  return `${sign}${(r / (86_400 * 365.25)).toFixed(1)} years / second`
}
