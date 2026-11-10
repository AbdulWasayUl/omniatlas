export const EARTH_RADIUS_KM = 6_371
export const AU_KM = 149_597_870.7
export const AU_IN_EARTH_RADII = AU_KM / EARTH_RADIUS_KM

export function kmToUnits(km: number): number {
  return km / EARTH_RADIUS_KM
}

export function auToUnits(au: number): number {
  return au * AU_IN_EARTH_RADII
}

export const SUN_RADIUS_KM = 696_340
export const MOON_RADIUS_KM = 1_737.5
export const MEAN_EARTH_MOON_DISTANCE_KM = 385_000

export const SUN_RADIUS_UNITS = kmToUnits(SUN_RADIUS_KM)
export const MOON_RADIUS_UNITS = kmToUnits(MOON_RADIUS_KM)
export const EARTH_MOON_DISTANCE_UNITS = kmToUnits(MEAN_EARTH_MOON_DISTANCE_KM)


/**
 * Aphelion, in AU, beyond which a small body counts as reaching the Oort region.
 *
 * Shared between two modules that must agree about it exactly. `oort` draws the orbit
 * of everything past this line, and `smallbodies` keeps a registry node for everything
 * past it regardless of where the notability cap would otherwise put it — because an
 * orbit drawn with nothing behind it to click is the defect those two rules exist to
 * prevent, and the two modules initialise CONCURRENTLY, so the ownership has to be
 * decided here rather than raced for at runtime.
 */
export const OORT_REACHING_APHELION_AU = 500
