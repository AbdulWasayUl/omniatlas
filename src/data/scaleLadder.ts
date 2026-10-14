import type { LayerId } from '../core/Layer'

/**
 * The scale ladder: the user-facing map of the atlas.
 *
 * Fourteen rungs from a crater floor to the cosmic microwave background. The thumb
 * tracks VIEW SPAN — the width of what is on screen — rather than camera distance,
 * because span is what a person actually perceives.
 *
 * Rungs that are not yet populated ship greyed and labelled rather than hidden. That
 * is a stronger product statement than pretending the ladder ends where the data does,
 * and it matches the spec's own commitment to exposing coverage instead of implying
 * completeness.
 */

export type Provenance = 'measured' | 'derived' | 'illustration'

export interface ScaleRung {
  id: string
  /** Short name, rendered in the rail. */
  label: string
  /** Representative view span in metres. The ladder is logarithmic in this value. */
  spanMetres: number
  /** Which engine layer dominates here. */
  layer: LayerId
  /** One line explaining what becomes visible. */
  caption: string
  /** Whether this rung has content in the current build. */
  shipped: boolean
  /** What kind of thing the user is looking at. */
  provenance: Provenance
  /** Named datasets backing the rung, shown in the evidence panel. */
  datasets: string[]
}

export const SCALE_LADDER: readonly ScaleRung[] = [
  {
    id: 'surface',
    label: 'Surface',
    spanMetres: 1e4,
    layer: 'surface',
    caption: 'Terrain, coastlines, craters and cities on a single world.',
    shipped: false,
    provenance: 'measured',
    datasets: ['Natural Earth 1:50m', 'USGS Gazetteer of Planetary Nomenclature'],
  },
  {
    id: 'body',
    label: 'Body',
    spanMetres: 2.2e7,
    layer: 'helio',
    caption: 'A whole world, its atmosphere and its rings.',
    shipped: true,
    provenance: 'measured',
    datasets: ['NASA Blue Marble', 'LRO WAC / LOLA', 'Solar System Scope textures'],
  },
  {
    id: 'moon-system',
    label: 'Moon system',
    spanMetres: 1.1e9,
    layer: 'helio',
    caption: 'A planet with its moons and their orbits.',
    shipped: true,
    provenance: 'measured',
    datasets: ['astronomy-engine VSOP87/ELP', 'JPL SSD satellite mean elements'],
  },
  {
    id: 'inner-system',
    label: 'Inner system',
    spanMetres: 6.0e11,
    layer: 'helio',
    caption: 'Mercury to Mars, and the inner edge of the asteroid belt.',
    shipped: true,
    provenance: 'measured',
    datasets: ['astronomy-engine VSOP87', 'JPL Small-Body Database'],
  },
  {
    id: 'outer-system',
    label: 'Outer system',
    spanMetres: 1.3e13,
    layer: 'helio',
    caption: 'Every planet, the main belt, and the Kuiper belt beyond Neptune.',
    shipped: true,
    provenance: 'measured',
    datasets: ['astronomy-engine VSOP87', 'JPL Small-Body Database'],
  },
  {
    id: 'heliosphere',
    label: 'Heliosphere',
    spanMetres: 1.5e14,
    layer: 'helio',
    caption: 'The heliopause at 121 AU, where Voyager 1 crossed into interstellar space.',
    shipped: false,
    provenance: 'measured',
    datasets: ['Voyager 1 plasma wave instrument, 2012-08-25'],
  },
  {
    id: 'oort',
    label: 'Oort cloud',
    spanMetres: 3.0e16,
    layer: 'stellar',
    // The honest case: no catalogue of Oort cloud objects exists, so anything drawn
    // here is a shell standing in for an inference, and is badged as such.
    caption: 'A hypothesised shell of icy bodies. No catalogue of it exists.',
    shipped: false,
    provenance: 'illustration',
    datasets: [],
  },
  {
    id: 'nearest-stars',
    label: 'Nearest stars',
    spanMetres: 5.0e17,
    layer: 'stellar',
    caption: 'Proxima Centauri at 4.25 light-years. Constellations begin to distort here.',
    shipped: true,
    provenance: 'measured',
    datasets: ['AT-HYG v4.0', 'NASA Exoplanet Archive'],
  },
  {
    id: 'local-bubble',
    label: 'Local Bubble',
    spanMetres: 5.0e18,
    layer: 'stellar',
    caption: 'The Hyades, the Pleiades, and the nebulae of the solar neighbourhood.',
    shipped: true,
    provenance: 'measured',
    datasets: ['AT-HYG v4.0', 'OpenNGC'],
  },
  {
    id: 'milky-way',
    label: 'Milky Way',
    spanMetres: 1.5e21,
    layer: 'galactic',
    caption: 'The disc, its spiral arms, and 157 globular clusters. The arms are a fitted model.',
    shipped: true,
    provenance: 'derived',
    datasets: ['Reid et al. 2019 maser parallaxes', 'Harris 2010 globular catalogue'],
  },
  {
    id: 'local-group',
    label: 'Local Group',
    spanMetres: 5.0e22,
    layer: 'galactic',
    caption: 'The Magellanic Clouds, Andromeda, and the dwarf galaxies between them.',
    shipped: true,
    provenance: 'measured',
    datasets: ['Updated Nearby Galaxy Catalog'],
  },
  {
    id: 'supercluster',
    label: 'Supercluster',
    spanMetres: 1.2e24,
    layer: 'cosmic',
    caption: 'Virgo, the Local Supercluster, and the flows that define Laniakea.',
    shipped: true,
    provenance: 'measured',
    datasets: ['Cosmicflows-4'],
  },
  {
    id: 'cosmic-web',
    label: 'Cosmic web',
    spanMetres: 6.0e25,
    layer: 'cosmic',
    caption: 'Filaments and voids, with the zone our own galaxy hides drawn explicitly.',
    shipped: true,
    provenance: 'measured',
    datasets: ['2MASS Redshift Survey', 'Cosmicflows-4'],
  },
  {
    id: 'observable',
    label: 'Observable universe',
    spanMetres: 8.8e26,
    layer: 'cosmic',
    caption: 'The microwave background: the limit of what can be seen, not the edge of the universe.',
    shipped: false,
    provenance: 'measured',
    datasets: ['Planck 2018 SMICA'],
  },
] as const

/** The rung whose span is closest to the current view, in log space. */
export function rungForSpan(spanMetres: number): ScaleRung {
  const target = Math.log10(Math.max(spanMetres, 1))
  let best = SCALE_LADDER[0]
  let bestDelta = Infinity
  for (const rung of SCALE_LADDER) {
    const delta = Math.abs(Math.log10(rung.spanMetres) - target)
    if (delta < bestDelta) {
      bestDelta = delta
      best = rung
    }
  }
  return best
}

const MIN_LOG = Math.log10(SCALE_LADDER[0].spanMetres)
const MAX_LOG = Math.log10(SCALE_LADDER[SCALE_LADDER.length - 1].spanMetres)

/** Position of a span on the rail, 0 at the top (largest) to 1 at the bottom. */
export function ladderFraction(spanMetres: number): number {
  const value = Math.log10(Math.max(spanMetres, 1))
  const t = (value - MIN_LOG) / (MAX_LOG - MIN_LOG)
  return Math.min(Math.max(1 - t, 0), 1)
}
