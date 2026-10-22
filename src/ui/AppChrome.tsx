import { useEffect, useMemo, useRef, useState } from 'react'
import type { AtlasViewer, ViewerSnapshot } from '../core/AtlasViewer'
import { chooseScaleBar, formatDistance, formatRate, formatUtc } from '../format/units'
import { epochIsFitted } from '../astronomy/ephemeris'
import { railFor, rungForView } from './scaleRungs'
import { useViewStore } from '../state/useViewStore'
import { ScaleLadder } from './ScaleLadder'
import { Inspector } from './Inspector'
import { CommandPalette } from './CommandPalette'

/**
 * The chrome.
 *
 * Five zones over the canvas. Everything here reads from the viewer's throttled
 * snapshot — nothing subscribes to a per-frame value, which is what keeps a 3D app
 * from re-reconciling its entire UI sixty times a second.
 */
export function AppChrome({ viewer }: { viewer: AtlasViewer | null }) {
  const snapshot = useViewStore((state) => state.snapshot)
  const ready = useViewStore((state) => state.ready)
  const failedModules = useViewStore((state) => state.failedModules)
  const togglePanel = useViewStore((state) => state.togglePanel)
  const openPanels = useViewStore((state) => state.openPanels)
  const select = useViewStore((state) => state.select)

  const showStats = openPanels.has('stats')
  const paletteOpen = openPanels.has('palette')

  // --- keyboard ------------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'

      if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing)) {
        event.preventDefault()
        togglePanel('palette', true)
        return
      }
      if (event.key === 'Escape') {
        // One layer per press, read from live store state: this effect never
        // re-subscribes (viewer and the zustand actions are its only deps), so any
        // panel set captured in the closure would be the empty one from first render.
        // Escape used to close every panel and drop the selection in one action, which
        // threw away the selection as a side effect of closing the palette — look
        // something up with Mars open and Mars went with it.
        const { openPanels: open, selectedId } = useViewStore.getState()
        if (open.has('palette')) togglePanel('palette', false)
        else if (open.has('stats')) togglePanel('stats', false)
        else if (selectedId) select(null)
        return
      }
      if (typing) return

      if (event.key === ' ') {
        event.preventDefault()
        viewer?.setPaused(!viewer.paused)
      }
      if (event.key === 'n' || event.key === 'N') {
        viewer?.resumeLive()
      }
      // Up one level in the containment hierarchy: moon to planet, planet to Sun.
      if (event.key === 'Backspace' || event.key === 'u' || event.key === 'U') {
        event.preventDefault()
        viewer?.focusParent()
      }
      if (event.key === 'ArrowLeft') viewer?.controls.orbitBy(0.12, 0)
      if (event.key === 'ArrowRight') viewer?.controls.orbitBy(-0.12, 0)
      if (event.key === 'ArrowUp') viewer?.controls.orbitBy(0, -0.08)
      if (event.key === 'ArrowDown') viewer?.controls.orbitBy(0, 0.08)
      if (event.key === '=' || event.key === '+') viewer?.controls.zoomBy(1 / 1.6)
      if (event.key === '-' || event.key === '_') viewer?.controls.zoomBy(1.6)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [viewer, togglePanel, select])

  const span = snapshot?.viewSpanMetres ?? 1
  // The rail is built for the object the camera is at, not fixed: see `railFor`. Read
  // from the registry rather than the snapshot so this needs nothing from the viewer's
  // payload beyond the anchor's id.
  const anchorNode = snapshot?.anchorId ? (viewer?.engine.node(snapshot.anchorId) ?? null) : null
  const rail = useMemo(
    () =>
      railFor(
        anchorNode
          ? {
              radiusMetres: anchorNode.radiusMetres || anchorNode.framingRadiusMetres || 0,
              name: anchorNode.name,
              objectClass: anchorNode.objectClass,
              inSolarSystem:
                anchorNode.layer === 'helio' || anchorNode.layer === 'system' || anchorNode.layer === 'surface',
            }
          : null,
      ),
    // The rail depends on the anchor, not on the frame: rebuilding it ten times a
    // second would hand ScaleLadder a new array on every snapshot. The dependency is
    // the anchor's identity and the four fields read above; the node object itself is
    // mutable and its reference never changes, so listing it would be the wrong
    // dependency, not a safer one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      anchorNode?.id,
      anchorNode?.radiusMetres,
      anchorNode?.framingRadiusMetres,
      anchorNode?.name,
      anchorNode?.objectClass,
      anchorNode?.layer,
    ],
  )
  const rung = rungForView(span, rail)
  const rungCaption = rung.caption

  return (
    <>
      {/* The readouts region always exists; #inspector-region does not — it is rendered
          only while something is selected, so on first load the first thing in the tab
          order led nowhere. */}
      <a className="skip-link" href="#atlas-readouts">
        Skip the 3D view
      </a>

      <TopBar
        onSearch={() => togglePanel('palette', true)}
        onToggleStats={() => togglePanel('stats')}
        statsOn={showStats}
      />

      <CosmicAddress
        path={snapshot?.addressPath ?? []}
        isReal={(id) => !!viewer?.engine.node(id)}
        onPick={(id) => {
          viewer?.focus(id)
          select(id)
        }}
      />

      <ScaleLadder
        spanMetres={span}
        rail={rail}
        active={rung}
        onPick={(picked) => viewer?.setViewSpanMetres(picked.spanMetres)}
      />

      <div id="atlas-readouts" tabIndex={-1}>
        <Hud snapshot={snapshot} rungLabel={rung.label} rungCaption={rungCaption} />

        <Inspector viewer={viewer} />
      </div>

      <TimeBar viewer={viewer} snapshot={snapshot} />

      {showStats && snapshot && (
        <div className="stats" aria-hidden="true">
          <div>{snapshot.fps.toFixed(0)} fps</div>
          <div>{snapshot.drawCalls} draw calls · {snapshot.registered} objects</div>
          <div>{snapshot.activeLayers.join(' · ') || 'no layers'}</div>
        </div>
      )}

      {!showStats && <Credits />}

      {paletteOpen && (
        <CommandPalette
          viewer={viewer}
          onClose={() => togglePanel('palette', false)}
        />
      )}

      {failedModules.length > 0 && (
        <div className="credits" role="status" style={{ bottom: 'auto', top: 'calc(var(--topbar-h) + 44px)' }}>
          Could not load: {failedModules.join(', ')}
        </div>
      )}

      <ControlHint ready={ready} />

      <LoadingScreen done={ready} />
    </>
  )
}

/**
 * The search glyph.
 *
 * Inline rather than a sprite reference: it is nine path commands, and the one
 * sprite in `public/` is unrelated template leftover. `currentColor` lets the
 * trigger's own hover rule tint it without a second selector.
 */
function SearchGlyph() {
  return (
    <svg className="search-glyph" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.4 10.4 14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function TopBar({
  onSearch,
  onToggleStats,
  statsOn,
}: {
  onSearch: () => void
  onToggleStats: () => void
  statsOn: boolean
}) {
  return (
    <header className="topbar">
      <div className="wordmark">
        <b>OMNI</b>
        <span>Atlas</span>
      </div>
      <div className="topbar-spacer" />
      <button type="button" className="search-trigger brackets" onClick={onSearch} aria-label="Search the atlas">
        <SearchGlyph />
        {/* The long form names the scope, which is the whole point of the control
            here: the atlas is not only the solar system, and a bare "Search" let
            people assume it was. */}
        <span className="search-label-long">Search anything in the atlas</span>
        <span className="search-label-short" aria-hidden="true">Search</span>
        <kbd>⌘K</kbd>
      </button>
      <button type="button" className="tool-button" aria-pressed={statsOn} onClick={onToggleStats}>
        Stats
      </button>
    </header>
  )
}

/**
 * The cosmic address.
 *
 * Derived from the containment hierarchy, not from navigation history — it answers
 * "where am I", which is a different question from "how did I get here". The last two
 * segments always show; earlier ones collapse behind an ellipsis on narrow viewports.
 */
function CosmicAddress({
  path,
  isReal,
  onPick,
}: {
  path: { id: string; name: string }[]
  /** Whether a crumb names something the registry can actually fly to. */
  isReal: (id: string) => boolean
  onPick: (id: string) => void
}) {
  if (path.length === 0) return null
  return (
    <nav className="cosmic-address" aria-label="Cosmic address">
      {path.map((entry, index) => {
        // The outermost crumb can be synthetic — 'solar-system' is a name for a chain,
        // not a registered node. Rendered as a button it was a dead control that still
        // ran select(), which set a selectedId nothing resolves and made the inspector
        // silently vanish. A span says the same thing and promises nothing.
        const live = isReal(entry.id)
        return (
          <span key={entry.id} style={{ display: 'contents' }}>
            {index > 0 && <span className="address-sep" aria-hidden="true">›</span>}
            {live ? (
              <button
                type="button"
                className="address-crumb"
                aria-current={index === path.length - 1}
                onClick={() => onPick(entry.id)}
              >
                {entry.name}
              </button>
            ) : (
              <span className="address-crumb" data-static="true" aria-current={index === path.length - 1}>
                {entry.name}
              </span>
            )}
          </span>
        )
      })}
    </nav>
  )
}

/** Pixel budget for the scale bar. The drawn rule lands between 80 and 200 px of it. */
const TARGET_BAR_PX = 200

/**
 * The heads-up readouts.
 *
 * Distance, light travel time, a ruler, and the name of the scale you are at. This is
 * the honest replacement for a scale-compression toggle: it tells you the scale instead
 * of distorting the scene to make the scale comfortable.
 */
function Hud({
  snapshot,
  rungLabel,
  rungCaption,
}: {
  snapshot: ReturnType<typeof useViewStore.getState>['snapshot']
  rungLabel: string
  rungCaption: string
}) {
  if (!snapshot) return null
  const distance = formatDistance(snapshot.altitudeMetres)
  const span = formatDistance(snapshot.viewSpanMetres)
  // Choose the bar from a PIXEL budget, then draw it at its exact true ratio. The old
  // form asked for span/5 and then clamped the drawn width to 240 px while printing the
  // unclamped label, so on a 1,920 px window the ruler was 240 px under a caption worth
  // 384 — anything measured against it read 1.6x too large. chooseScaleBar snaps down by
  // at most 0.4x, so budgeting first keeps the bar inside [0.4B, B] with no clamp at all.
  const viewportPx = Math.max(window.innerWidth || 1200, 1)
  const bar = chooseScaleBar(snapshot.viewSpanMetres * (TARGET_BAR_PX / viewportPx))
  const barPixels = Math.round((bar.metres / snapshot.viewSpanMetres) * viewportPx)

  return (
    <div className="hud">
      <div className="hud-readout">
        <div className="kicker hud-text">{rungLabel}</div>
        <div className="hud-value num">{distance.text}</div>
        <div className="hud-sub">
          {snapshot.anchorName === 'Space' ? 'from the camera' : `above ${snapshot.anchorName}`}
          {distance.lightTime ? ` · ${distance.lightTime}` : ''}
        </div>
      </div>

      <div className="hud-readout">
        <div className="hud-sub hud-text">View spans {span.text}</div>
        <div className="scale-bar">
          <div className="scale-bar-rule" style={{ width: `${Math.max(8, barPixels)}px` }} />
          <div className="hud-sub num">{bar.label}</div>
        </div>
      </div>

      <div className="hud-sub hud-text" style={{ maxWidth: 260 }}>
        {rungCaption}
      </div>
    </div>
  )
}

/** Discrete rate ladder. Continuous rate sliders are impossible to return to 1× on. */
const RATES = [0, 1, 60, 3600, 86_400, 86_400 * 30, 86_400 * 365.25]

/** The rung nearest a rate in log space, for stepping away from an off-ladder value. */
function nearestRateIndex(rate: number): number {
  if (!(rate > 0)) return 0
  let best = 1
  let bestDelta = Infinity
  for (let i = 1; i < RATES.length; i++) {
    const delta = Math.abs(Math.log(rate / RATES[i]))
    if (delta < bestDelta) {
      bestDelta = delta
      best = i
    }
  }
  return best
}

/**
 * The clock.
 *
 * Everything shown here is read back from the viewer, never from local state. The rate
 * label and the live dot used to be `useState` written only by these buttons, so the
 * three other routes that change the clock — the space key, the n key and a deep link's
 * `rate=` — left the footer asserting "Real time" over a clock that was frozen, or
 * racing at 60x. The footer is the only clock readout in the product.
 *
 * The buttons step from `viewer.timeRate`, which `setTimeRate` writes synchronously,
 * rather than from the 10 Hz snapshot: two clicks inside one snapshot window would
 * otherwise read the same stale rate and collapse into a single step.
 */
function TimeBar({ viewer, snapshot }: { viewer: AtlasViewer | null; snapshot: ViewerSnapshot | null }) {
  // The snapshot is what re-renders this component; the viewer is what it reads. Both
  // are needed: the fields below are plain mutable fields with no subscription.
  const epochMs = snapshot?.epochMs ?? null
  const rate = viewer?.timeRate ?? 1
  const paused = viewer?.paused ?? false
  // A pause at 60x is still a stopped clock, and formatRate(60) would deny it.
  const effective = paused ? 0 : rate
  // The green dot means "this is now", so it asks the viewer whether the clock is
  // actually on the present instant. `!paused && rate === 1` is a different question
  // and answered yes over a clock five years fast; see `AtlasViewer.trackingNow`.
  const live = snapshot?.trackingNow ?? false

  const apply = (step: number) => {
    if (!viewer) return
    // Read the rate at click time, not the one this render closed over: two clicks
    // inside one 100 ms snapshot window would otherwise both step from the same value
    // and the second would be swallowed.
    //
    // A paused clock keeps its rate — `setPaused` writes nothing to `timeRate` — so the
    // ladder has to step from the stored value and not from the zero the readout shows.
    // Stepping from zero resumed at real time, which threw away a 1 year/s setting on
    // the first click after the space bar. The space bar is a stop, not a reset.
    if (viewer.paused) {
      // Faster restarts the clock where it stopped. Slower has nowhere to go: a stopped
      // clock is already the slowest thing the ladder can express, and stepping it to
      // RATES[0] would write that zero into `timeRate` and lose the rate for good.
      if (step > 0) viewer.setTimeRate(viewer.timeRate > 0 ? viewer.timeRate : RATES[1])
      return
    }
    // A reversed clock (?rate=-86400) is a legitimate state the footer prints
    // honestly, so the ladder steps its MAGNITUDE and keeps the sign. Stepping the
    // signed value instead sent the first press to +1 and destroyed the only way to
    // run time backwards, with no way back except editing the URL.
    const sign = viewer.timeRate < 0 ? -1 : 1
    const index = Math.max(0, Math.min(nearestRateIndex(Math.abs(viewer.timeRate)) + step, RATES.length - 1))
    viewer.setTimeRate(sign * RATES[index])
  }

  return (
    <footer className="timebar">
      <div className="time-now">
        {live && <span className="live-dot" aria-hidden="true" />}
        <span className="time-stamp num">{epochMs === null ? 'Syncing' : `${formatUtc(epochMs)} UTC`}</span>
        {/* Past about half a turn per frame the renderer stops integrating a body's spin
            and shows a smoothed stand-in, because sampled rotation below Nyquist runs
            backwards. Saying so is cheaper than letting someone read a planet's
            direction of rotation off a stroboscope. */}
        {snapshot?.rotationAliased && (
          <span className="time-note" role="status">
            Rotation too fast to show at this rate. Spin is smoothed.
          </span>
        )}
        {/* Outside the window the ephemeris is fitted over, the positions are an
            extrapolation that looks exactly like a measurement: three minutes on the
            top rung reaches it, and nothing else in the product would say so. */}
        {epochMs !== null && !epochIsFitted(epochMs) && (
          <span className="time-note" role="status">
            Outside the ephemeris window (1700 to 2200). Positions are extrapolated.
          </span>
        )}
      </div>

      <div className="rate-group">
        <div className="rate-stepper">
          <button
            type="button"
            className="icon-button"
            aria-label="Slower"
            // A stopped clock is already the slowest rung, so the control says so
            // instead of silently swallowing the press — `apply` has always ignored
            // it, and a button that does nothing when clicked reads as broken.
            disabled={paused}
            onClick={() => apply(-1)}
          >
            ‹
          </button>
          <span className="rate-label num" data-paused={paused} aria-live="polite">
            {formatRate(effective)}
          </span>
          <button type="button" className="icon-button" aria-label="Faster" onClick={() => apply(1)}>
            ›
          </button>
        </div>
        <button
          type="button"
          className="tool-button now-button"
          disabled={live}
          onClick={() => viewer?.resumeLive()}
        >
          Now
        </button>
      </div>
    </footer>
  )
}

/**
 * A one-time hint.
 *
 * A 3D canvas advertises none of its own affordances: nothing on screen says the scene
 * can be dragged, scrolled or double-clicked. This says it once, then gets out of the
 * way for good on the first interaction.
 */
function ControlHint({ ready }: { ready: boolean }) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem('omniatlas.hint-seen') === '1'
    } catch {
      // Private browsing, blocked storage: show the hint, just do not remember.
      return false
    }
  })

  useEffect(() => {
    if (dismissed || !ready) return
    const dismiss = () => {
      setDismissed(true)
      try {
        localStorage.setItem('omniatlas.hint-seen', '1')
      } catch {
        /* nothing to do; the hint simply returns next visit */
      }
    }
    window.addEventListener('pointerdown', dismiss, { once: true })
    window.addEventListener('wheel', dismiss, { once: true, passive: true })
    window.addEventListener('keydown', dismiss, { once: true })
    const timer = window.setTimeout(dismiss, 14000)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('wheel', dismiss)
      window.removeEventListener('keydown', dismiss)
      window.clearTimeout(timer)
    }
  }, [dismissed, ready])

  if (dismissed || !ready) return null
  return (
    <div className="control-hint" role="note">
      {/* Each line is its own block: as bare inline content in a flex column, the
          words became separate flex items and stacked one per line. */}
      <div className="control-hint-main">
        <b>Drag</b> to orbit · <b>Scroll</b> to travel · <b>Double-click</b> to fly to anything
      </div>
      <div className="control-hint-sub">⌘K to search · U to go up a level</div>
    </div>
  )
}

function Credits() {
  return (
    <div className="credits">
      Positions from astronomy-engine (VSOP87/ELP) · Textures NASA / USGS / Solar System Scope, Triton map by
      A.&nbsp;Anpilogov CC&nbsp;BY&nbsp;3.0 · Stars AT-HYG v4.0 CC&nbsp;BY-SA&nbsp;4.0
    </div>
  )
}

/**
 * The loading screen lifts as soon as the focus object is ready, not when every module
 * has finished — otherwise the overlay hides a scene that is already interactive.
 */
function LoadingScreen({ done }: { done: boolean }) {
  const [hidden, setHidden] = useState(false)
  const timer = useRef<number>(0)

  useEffect(() => {
    if (!done) return
    timer.current = window.setTimeout(() => setHidden(true), 400)
    return () => window.clearTimeout(timer.current)
  }, [done])

  if (hidden) return null
  return (
    <div className="loading" data-done={done} role="status" aria-live="polite">
      <div className="loading-mark">
        <b>OMNI</b>ATLAS
      </div>
      <div className="loading-bar">
        <i />
      </div>
      <div className="hud-sub">{done ? 'Ready' : 'Computing ephemerides for the current instant'}</div>
    </div>
  )
}
