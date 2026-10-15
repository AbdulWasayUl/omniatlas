/**
 * Visibility of a structure against the width of the view.
 *
 * An orbit is a statement about a path, and a path you cannot see the shape of is
 * not a statement, it is a line across the screen. Standing 20,000 km above Earth,
 * the orbits of Jupiter, Saturn and Neptune each cross the whole frame as a straight
 * coloured streak: three strokes of noise that tell the viewer nothing about three
 * orbits. The same drawing an eighth of a light-day out, where the inner planets'
 * orbits collapse into a single bright knot, is equally uninformative.
 *
 * So structures declare their own size and are drawn only while the view is in the
 * range where that size reads. Everything is feathered in log space, because scale in
 * this atlas is logarithmic and a linear fade would snap.
 */

/** Smooth 0→1 ramp. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

/** Below this ratio of view span to structure size, the shape cannot be read at all. */
const TOO_CLOSE_HIDDEN = 0.5
const TOO_CLOSE_SHOWN = 1.8
/** Above this ratio the structure is a point, and its path is a smear. */
const TOO_FAR_SHOWN = 1800
const TOO_FAR_HIDDEN = 9000

/**
 * Opacity multiplier for a structure of characteristic size `sizeMetres` seen in a
 * view `viewSpanMetres` wide. 1 while the structure frames well, falling to 0 when
 * the view is far inside it or far outside it.
 */
export function spanVisibility(viewSpanMetres: number, sizeMetres: number): number {
  if (!(sizeMetres > 0) || !(viewSpanMetres > 0)) return 0
  const ratio = viewSpanMetres / sizeMetres
  const logRatio = Math.log10(ratio)
  return (
    smoothstep(Math.log10(TOO_CLOSE_HIDDEN), Math.log10(TOO_CLOSE_SHOWN), logRatio) *
    (1 - smoothstep(Math.log10(TOO_FAR_SHOWN), Math.log10(TOO_FAR_HIDDEN), logRatio))
  )
}
