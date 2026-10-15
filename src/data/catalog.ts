import { NOTABLE_SMALL_BODIES } from './asteroidBelt'
import { DWARF_PLANETS, PLANETS, findPlanet } from './planets'
import { EARTH_MOON, MOONS, moonsOf } from './moons'
import { SUN } from './sun'
import type { AtlasEntity } from './types'

export type { EntityKind, Fact, AtlasEntity, FocusTarget, PlanetId } from './types'
export { PLANET_IDS } from './types'
export {
  EARTH_RADIUS_KM,
  AU_KM,
  AU_IN_EARTH_RADII,
  SUN_RADIUS_KM,
  MOON_RADIUS_KM,
  MEAN_EARTH_MOON_DISTANCE_KM,
  SUN_RADIUS_UNITS,
  MOON_RADIUS_UNITS,
  EARTH_MOON_DISTANCE_UNITS,
  kmToUnits,
  auToUnits,
} from './constants'
export { SUN, PLANETS, DWARF_PLANETS, EARTH_MOON, MOONS, NOTABLE_SMALL_BODIES, findPlanet, moonsOf }
export {
  COUNTRIES_URL,
  COUNTRIES_BOUNDARY_URL,
  CITIES_URL,
  MOON_CRATERS_URL,
  countryToEntity,
  cityToEntity,
  craterToEntity,
  type CountryRecord,
  type CityRecord,
  type CraterRecord,
} from './surfaceLayers'

export const BODIES: AtlasEntity[] = [SUN, ...PLANETS, ...DWARF_PLANETS]

/** Statically-known catalogue: bodies, curated moons, and notable small bodies.
 * Countries, cities, and lunar craters are loaded at runtime (see surfaceLayers.ts)
 * because they number in the hundreds to low thousands and are body-specific layers,
 * not fixed navigational destinations. */
export const CATALOG: AtlasEntity[] = [...BODIES, EARTH_MOON, ...MOONS, ...NOTABLE_SMALL_BODIES]

export function findEntity(id: string | null): AtlasEntity | null {
  if (!id) return null
  return CATALOG.find((entity) => entity.id === id) ?? null
}
