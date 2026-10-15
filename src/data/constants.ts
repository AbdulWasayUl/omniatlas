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

