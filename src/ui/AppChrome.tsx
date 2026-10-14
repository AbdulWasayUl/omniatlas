import { useEffect, useRef, useState } from 'react'
import type { AtlasViewer } from '../core/AtlasViewer'
import { chooseScaleBar, formatDistance, formatRate, formatUtc } from '../format/units'
import { rungForSpan } from '../data/scaleLadder'
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
  const closeAll = useViewStore((state) => state.closeAll)

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
        closeAll()
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
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [viewer, togglePanel, closeAll])

  const span = snapshot?.viewSpanMetres ?? 1
  const rung = rungForSpan(span)

  return (
    <>
      <a className="skip-link" href="#inspector-region">
        Skip the 3D view
      </a>

      <TopBar
        onSearch={() => togglePanel('palette', true)}
        onToggleStats={() => togglePanel('stats')}
        statsOn={showStats}
      />

      <CosmicAddress
        path={snapshot?.addressPath ?? []}
        onPick={(id) => {
          viewer?.focus(id)
          select(id)
        }}
      />

      <ScaleLadder
        spanMetres={span}
        onPick={(targetSpan) => viewer?.setViewSpanMetres(targetSpan)}
      />

      <Hud snapshot={snapshot} rungLabel={rung.label} rungCaption={rung.caption} />

      <Inspector viewer={viewer} />

      <TimeBar viewer={viewer} epochMs={snapshot?.epochMs ?? null} />

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

      <LoadingScreen done={ready} />
    </>
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
        <span>ATLAS</span>
      </div>
      <div className="topbar-spacer" />
      <button type="button" className="search-trigger" onClick={onSearch} aria-label="Search the atlas">
        <span className="search-label-long">Search the atlas</span>
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
  onPick,
}: {
  path: { id: string; name: string }[]
  onPick: (id: string) => void
}) {
  if (path.length === 0) return null
  return (
    <nav className="cosmic-address" aria-label="Cosmic address">
      {path.map((entry, index) => (
        <span key={entry.id} style={{ display: 'contents' }}>
          {index > 0 && <span className="address-sep" aria-hidden="true">›</span>}
          <button
            type="button"
            className="address-crumb"
            aria-current={index === path.length - 1}
            onClick={() => onPick(entry.id)}
          >
            {entry.name}
          </button>
        </span>
      ))}
    </nav>
  )
}

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
  const bar = chooseScaleBar(snapshot.viewSpanMetres / 5)
  const barPixels = Math.round((bar.metres / snapshot.viewSpanMetres) * (window.innerWidth || 1200))

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
          <div className="scale-bar-rule" style={{ width: `${Math.max(24, Math.min(barPixels, 240))}px` }} />
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

function TimeBar({ viewer, epochMs }: { viewer: AtlasViewer | null; epochMs: number | null }) {
  const [rateIndex, setRateIndex] = useState(1)
  const [live, setLive] = useState(true)

  const apply = (index: number) => {
    const next = Math.max(0, Math.min(index, RATES.length - 1))
    setRateIndex(next)
    setLive(next === 1)
    viewer?.setTimeRate(RATES[next])
  }

  return (
    <footer className="timebar">
      <div className="time-now">
        {live && <span className="live-dot" aria-hidden="true" />}
        <span className="time-stamp num">{epochMs === null ? '—' : `${formatUtc(epochMs)} UTC`}</span>
      </div>

      <div className="rate-group">
        <button
          type="button"
          className="icon-button"
          aria-label="Slower"
          onClick={() => apply(rateIndex - 1)}
        >
          ‹
        </button>
        <span className="rate-label num">{formatRate(RATES[rateIndex])}</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Faster"
          onClick={() => apply(rateIndex + 1)}
        >
          ›
        </button>
        <button
          type="button"
          className="tool-button now-button"
          onClick={() => {
            viewer?.resumeLive()
            apply(1)
          }}
        >
          Now
        </button>
      </div>
    </footer>
  )
}

function Credits() {
  return (
    <div className="credits">
      Positions from astronomy-engine (VSOP87/ELP) · Textures NASA / USGS / Solar System Scope · Stars AT-HYG v4.0
      CC&nbsp;BY-SA&nbsp;4.0
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
