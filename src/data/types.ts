import type { KeplerianElements } from '../astronomy/orbit'

export type EntityKind =
  | 'star'
  | 'planet'
  | 'dwarf-planet'
  | 'moon'
  | 'small-body-field'
  | 'crater'
  | 'country'
  | 'city'

export interface Fact {
  label: string
  value: string
}

export interface AtlasEntity {
  id: string
  name: string
  eyebrow: string
  kind: EntityKind
  parentId?: string
  /** Which rendered body this entity is anchored to or represents. */
  bodyId: string
  description: string
  facts: Fact[]
  coordinates?: {
    latitude: number
    longitude: number
  }
  source: {
    label: string
    url: string
  }

  /** Mean physical radius in kilometres, for renderable bodies. */
  radiusKm?: number
  /** astronomy-engine `Body` enum key, when this body's state comes from the engine directly. */
  engineBody?: string
  /** True heliocentric semi-major axis in AU, used for facts and exploration-mode placement. */
  semiMajorAxisAu?: number
  textureUrl?: string
  /** Flat base colour for the parts of `textureUrl` that no mission imaged. */
  unimagedFill?: string
  /** Mean disc colour, used when no map is available at all. */
  baseColor?: string
  ringTextureUrl?: string
  atmosphereTextureUrl?: string
  hasClouds?: boolean
  /** Keplerian elements for moons not covered by astronomy-engine's built-in models. */
  elements?: KeplerianElements
  /** Position among sibling moons, nearest first — used to space exploration-mode orbits. */
  orderIndex?: number
}

export const PLANET_IDS = [
  'mercury',
  'venus',
  'earth',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
] as const

export type PlanetId = (typeof PLANET_IDS)[number]

export type FocusTarget = 'system' | 'sun' | PlanetId | (string & {})
