/**
 * Object classes.
 *
 * Eleven classes at equal perceptual lightness, each with a distinct glyph. The glyph
 * is the encoding and the colour is reinforcement, not the other way round: several of
 * these hues are indistinguishable under deuteranopia, and at a 6px marker almost all
 * of them are indistinguishable to everyone.
 */

export type ObjectClass =
  | 'star'
  | 'planet'
  | 'moon'
  | 'dwarf-planet'
  | 'asteroid'
  | 'comet'
  | 'spacecraft'
  | 'galaxy'
  | 'nebula'
  | 'cluster'
  | 'region'
  | 'black-hole'

export interface ObjectClassStyle {
  label: string
  color: string
  /** Rendered at the marker and in the inspector header. */
  glyph: 'disc' | 'ring' | 'small-disc' | 'dashed-ring' | 'diamond' | 'teardrop' | 'chevron' | 'spiral' | 'cloud' | 'dots' | 'dark-disc'
  /** Label priority when the declutterer has to drop something. Higher survives. */
  priority: number
}

export const OBJECT_CLASSES: Record<ObjectClass, ObjectClassStyle> = {
  star: { label: 'Star', color: '#dcbc33', glyph: 'ring', priority: 90 },
  planet: { label: 'Planet', color: '#7dc1ff', glyph: 'disc', priority: 100 },
  moon: { label: 'Moon', color: '#a0c4d4', glyph: 'small-disc', priority: 70 },
  'dwarf-planet': { label: 'Dwarf planet', color: '#d1a8ff', glyph: 'dashed-ring', priority: 80 },
  asteroid: { label: 'Asteroid', color: '#ffa460', glyph: 'diamond', priority: 40 },
  comet: { label: 'Comet', color: '#4cd7c8', glyph: 'teardrop', priority: 50 },
  spacecraft: { label: 'Spacecraft', color: '#81d584', glyph: 'chevron', priority: 45 },
  galaxy: { label: 'Galaxy', color: '#f59cd8', glyph: 'spiral', priority: 65 },
  nebula: { label: 'Nebula', color: '#ff9395', glyph: 'cloud', priority: 60 },
  // A volume rather than a body: a belt, a galactic core, a zone. Already used by two
  // registered nodes before this entry existed, which meant both fell through to the
  // default and an asteroid belt was labelled "Planet" in the inspector header.
  region: { label: 'Region', color: '#9fb4c4', glyph: 'dashed-ring', priority: 48 },
  cluster: { label: 'Star cluster', color: '#a5b6ff', glyph: 'dots', priority: 55 },
  'black-hole': { label: 'Black hole', color: '#aebde5', glyph: 'dark-disc', priority: 75 },
}

export function classStyle(id: string): ObjectClassStyle {
  return OBJECT_CLASSES[id as ObjectClass] ?? OBJECT_CLASSES.planet
}
