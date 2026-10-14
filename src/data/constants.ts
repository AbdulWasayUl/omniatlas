export const EARTH_RADIUS_KM = 6_371
export const AU_KM = 149_597_870.7
export const AU_IN_EARTH_RADII = AU_KM / EARTH_RADIUS_KM

export function kmToUnits(km: number): number {
  return km / EARTH_RADIUS_KM
}

export function auToUnits(au: number): number {
  return au * AU_IN_EARTH_RADII
}

/**
 * Exploration mode compresses true AU separations with a square-root law so the
 * whole system stays comfortably navigable while relative ordering and spacing
 * trends are preserved. This is a disclosed, labeled distortion — never treated
 * as a physical distance.
 */
export function explorationDistanceForAu(au: number): number {
  return 14 * Math.sqrt(au)
}

/** Exploration-mode orbit radius for a moon around its (compressed) parent planet. */
export function explorationMoonDistance(parentRadiusUnits: number, orderIndex: number): number {
  return parentRadiusUnits * (2.3 + orderIndex * 0.85)
}

/**
 * Exploration mode also compresses body RADII, not just separations — otherwise a
 * true-to-scale Jupiter (≈11 Earth radii) or Sun (≈109 Earth radii) would dwarf the
 * compressed orbital distances above and bodies would visually overlap. A power
 * law less aggressive than the distance compression preserves size ORDER (Sun >
 * Jupiter > Saturn > Earth > Mercury) without literal real-world ratios. Earth
 * itself is the unit (1^p = 1 for any p), so this never changes Earth's own size.
 */
export function explorationRadiusUnits(trueRadiusUnits: number): number {
  return trueRadiusUnits ** 0.4
}

export const SUN_RADIUS_KM = 696_340
export const MOON_RADIUS_KM = 1_737.5
export const MEAN_EARTH_MOON_DISTANCE_KM = 385_000

export const SUN_RADIUS_UNITS = kmToUnits(SUN_RADIUS_KM)
export const MOON_RADIUS_UNITS = kmToUnits(MOON_RADIUS_KM)
export const EARTH_MOON_DISTANCE_UNITS = kmToUnits(MEAN_EARTH_MOON_DISTANCE_KM)

export const EXPLORATION_SUN_RADIUS = explorationRadiusUnits(SUN_RADIUS_UNITS)
