import { SCALE_LADDER, type ScaleRung } from '../data/scaleLadder'

/**
 * The scale rail, built for the object the camera is actually at.
 *
 * The ladder in `src/data/scaleLadder.ts` is a fixed list of fourteen absolute spans,
 * and showing all fourteen everywhere made the rail the one piece of chrome that never
 * changed: at the Milky Way, eight of its rungs named views that are inside the galaxy
 * you are standing on and cannot be reached, and the whole reachable range — galaxy to
 * observable universe — was squeezed into the top fifth of the track. The thumb lived
 * up there, the ticks below it were decoration, and pressing one moved the camera to
 * somewhere the rail then could not describe.
 *
 * So the rail is derived per anchor. Rungs the camera cannot reach from here are left
 * out, the object itself becomes the bottom rung, and the track is scaled to what is
 * left — which makes it a different, and much shorter, rail at Saturn than at Virgo.
 * Everything a rail rung carries is absolute, so `rungForView` is a true inverse of a
 * click again, and nothing has to be floored or re-derived.
 */

export interface RailRung {
  id: string
  /** Shown in the rail and read out by the HUD. */
  label: string
  /** Absolute view span, in metres, that this rung means. */
  spanMetres: number
  /** One line about what is visible at this scale. */
  caption: string
  /** Whether this rung has content in the current build. */
  shipped: boolean
  /** True for the synthetic bottom rung that frames the anchor itself. */
  isAnchor: boolean
}

/** What the rail needs to know about the object the camera is anchored to. */
export interface RailAnchor {
  radiusMetres: number
  name: string
  objectClass: string
  inSolarSystem: boolean
}

/**
 * How wide a view of the anchor itself is, in anchor radii.
 *
 * 3.2 frames a body with room around it, which is what the arrival camera does and
 * what "you are looking at this object" should mean on the rail.
 */
const ANCHOR_SPAN_IN_RADII = 3.2

/**
 * How far above the anchor rung the next rung has to sit to be worth drawing.
 *
 * Without a gap, the catalogue rung just above an anchor's own span lands a few pixels
 * from it and means the same view: at Earth the "Body" rung (2.2e7 m) is 8 per cent
 * from the anchor rung (2.04e7 m), which is two ticks for one place.
 */
const RUNG_CLEARANCE = 1.6

/** Classes whose rung captions the fixed ladder was actually written about. */
const BODY_CLASSES = new Set(['planet', 'dwarf-planet', 'moon', 'asteroid', 'comet'])

/**
 * The rungs to draw for an anchor, from the closest view outwards.
 *
 * With no anchor radius — a point-like destination, or no anchor at all — this is the
 * plain absolute ladder, which is the right answer: there is no body whose size could
 * say where the bottom of the rail goes.
 */
export function railFor(anchor: RailAnchor | null): RailRung[] {
  const atABody = !!anchor && anchor.inSolarSystem && BODY_CLASSES.has(anchor.objectClass)
  const fixed = (rung: ScaleRung): RailRung => ({
    id: rung.id,
    // Both the name and the line under it are written about the solar system, and
    // both are only a description of the view when the camera is at a body in it.
    label: atABody ? rung.label : rung.scaleLabel,
    spanMetres: rung.spanMetres,
    // The ladder's own captions name solar-system landmarks, which describe the view
    // only when the camera is at a solar-system body; everywhere else the rung can
    // still state a size, and that is all it honestly knows. See `scaleCaption`.
    caption: atABody ? rung.caption : rung.scaleCaption,
    shipped: rung.shipped,
    isAnchor: false,
  })

  if (!anchor || !(anchor.radiusMetres > 0)) return SCALE_LADDER.map(fixed)

  const anchorSpan = anchor.radiusMetres * ANCHOR_SPAN_IN_RADII
  const anchorRung: RailRung = {
    id: 'anchor',
    label: anchor.name,
    spanMetres: anchorSpan,
    caption: `${anchor.name}, framed whole.`,
    shipped: true,
    isAnchor: true,
  }
  const rest = SCALE_LADDER.filter((rung) => rung.spanMetres > anchorSpan * RUNG_CLEARANCE).map(fixed)
  return [anchorRung, ...rest]
}

/** Which rung of this rail a view is on: nearest in log space, as the ladder is. */
export function rungForView(spanMetres: number, rail: readonly RailRung[]): RailRung {
  const target = Math.log10(Math.max(spanMetres, 1))
  let best = rail[0]
  let bestDelta = Infinity
  for (const rung of rail) {
    const delta = Math.abs(Math.log10(rung.spanMetres) - target)
    if (delta < bestDelta) {
      bestDelta = delta
      best = rung
    }
  }
  return best
}

/**
 * Where a span sits on this rail, 0 at the top (widest) to 1 at the bottom.
 *
 * Over the rail's own range rather than the ladder's, so the thumb uses the whole
 * track at every anchor instead of pinning itself to the top at a galaxy and to the
 * bottom at a comet. Clamped, because the camera can be a little outside both ends:
 * below the anchor rung while skimming a surface, and above the top rung at the zoom
 * ceiling.
 */
export function railFraction(spanMetres: number, rail: readonly RailRung[]): number {
  const low = Math.log10(rail[0].spanMetres)
  const high = Math.log10(rail[rail.length - 1].spanMetres)
  if (!(high > low)) return 0
  const t = (Math.log10(Math.max(spanMetres, 1)) - low) / (high - low)
  return Math.min(Math.max(1 - t, 0), 1)
}
