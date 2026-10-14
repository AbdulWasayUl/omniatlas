import { SCALE_LADDER, ladderFraction, rungForSpan } from '../data/scaleLadder'

/**
 * The scale rail.
 *
 * A logarithmic ladder down the left edge with a marker tracking the current view span.
 * It is the one piece of chrome that makes thirty orders of magnitude legible: it shows
 * where you are in the whole range, what is above and below you, and — crucially — that
 * the range has a defined top and bottom at all. Without it, zooming out of the solar
 * system feels like falling off the edge of the product.
 *
 * Rungs with no content yet are drawn greyed rather than hidden, so coverage is visible.
 */
export function ScaleLadder({
  spanMetres,
  onPick,
}: {
  spanMetres: number
  onPick: (spanMetres: number) => void
}) {
  const active = rungForSpan(spanMetres)
  const thumb = ladderFraction(spanMetres)

  return (
    <div
      className="ladder"
      role="slider"
      aria-label="Scale"
      aria-valuemin={0}
      aria-valuemax={SCALE_LADDER.length - 1}
      aria-valuenow={SCALE_LADDER.indexOf(active)}
      aria-valuetext={`${active.label}. ${active.caption}`}
      tabIndex={0}
      onKeyDown={(event) => {
        const index = SCALE_LADDER.indexOf(active)
        if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
          event.preventDefault()
          onPick(SCALE_LADDER[Math.min(index + 1, SCALE_LADDER.length - 1)].spanMetres)
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
          event.preventDefault()
          onPick(SCALE_LADDER[Math.max(index - 1, 0)].spanMetres)
        }
      }}
    >
      <div className="ladder-track">
        {SCALE_LADDER.map((rung) => {
          const top = ladderFraction(rung.spanMetres) * 100
          return (
            <button
              type="button"
              key={rung.id}
              className="ladder-rung"
              style={{ top: `${top}%` }}
              data-active={rung.id === active.id}
              data-shipped={rung.shipped}
              title={rung.shipped ? rung.caption : `${rung.caption} — coming in a later release`}
              aria-label={`${rung.label}${rung.shipped ? '' : ' (not yet available)'}`}
              onClick={() => onPick(rung.spanMetres)}
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
