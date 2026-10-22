import { type RailRung, railFraction } from './scaleRungs'

/**
 * The scale rail.
 *
 * A logarithmic ladder down the left edge with a marker tracking the current view span.
 * It is the one piece of chrome that makes thirty orders of magnitude legible: it shows
 * where you are in the whole range, what is above and below you, and — crucially — that
 * the range has a defined top and bottom at all. Without it, zooming out of the solar
 * system feels like falling off the edge of the product.
 *
 * The rungs are built for the anchor rather than fixed — see `railFor` — so the rail
 * at a comet is not the rail at a galaxy cluster, and the bottom rung is the object
 * you are at. Rungs with no content yet are drawn greyed rather than hidden, so
 * coverage is still visible.
 */
export function ScaleLadder({
  spanMetres,
  rail,
  active,
  onPick,
}: {
  spanMetres: number
  /** The rungs for the current anchor, closest first. */
  rail: readonly RailRung[]
  /**
   * The rung the view is on. Passed in rather than derived here because the HUD reads
   * the same answer out a few pixels away, and two derivations eventually disagree.
   */
  active: RailRung
  onPick: (rung: RailRung) => void
}) {
  const thumb = railFraction(spanMetres, rail)
  const index = rail.findIndex((rung) => rung.id === active.id)

  return (
    <div
      className="ladder"
      role="slider"
      aria-label="Scale"
      aria-valuemin={0}
      aria-valuemax={rail.length - 1}
      aria-valuenow={Math.max(index, 0)}
      aria-valuetext={`${active.label}. ${active.caption}`}
      tabIndex={0}
      onKeyDown={(event) => {
        // preventDefault does not stop the bubble, and AppChrome's window listener maps
        // the same four keys to orbitBy: every arrow press on the focused rail moved the
        // rung AND pitched the camera, which makes the rail unusable as a slider.
        const up = event.key === 'ArrowUp' || event.key === 'ArrowRight'
        const down = event.key === 'ArrowDown' || event.key === 'ArrowLeft'
        if (!up && !down) return
        event.preventDefault()
        event.stopPropagation()
        const next = Math.min(Math.max((index < 0 ? 0 : index) + (up ? 1 : -1), 0), rail.length - 1)
        onPick(rail[next])
      }}
    >
      <div className="ladder-track">
        {rail.map((rung) => {
          const top = railFraction(rung.spanMetres, rail) * 100
          return (
            <button
              type="button"
              key={rung.id}
              className="ladder-rung"
              style={{ top: `${top}%` }}
              data-active={rung.id === active.id}
              data-shipped={rung.shipped}
              data-anchor={rung.isAnchor}
              title={rung.shipped ? rung.caption : `${rung.caption} (coming in a later release)`}
              aria-label={`${rung.label}${rung.shipped ? '' : ' (not yet available)'}`}
              onClick={() => onPick(rung)}
            >
              <span className="ladder-label">{rung.label}</span>
            </button>
          )
        })}

        {/* The live marker, which moves continuously rather than snapping to a rung. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: '50%',
            top: `${thumb * 100}%`,
            transform: 'translate(-50%, -50%)',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--accent)',
            boxShadow: '0 0 0 3px var(--bg), 0 0 10px var(--accent)',
            pointerEvents: 'none',
            transition: 'top 120ms cubic-bezier(.4,0,.2,1)',
          }}
        />
      </div>
    </div>
  )
}
