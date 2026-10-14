import { useEffect, useMemo } from 'react'
import { calculateSolarSystemEphemeris } from '../../astronomy/ephemeris'
import { findEntity } from '../../data/catalog'
import { useExplorerStore } from '../../store/useExplorerStore'
import { DirectoryPanel } from './DirectoryPanel'
import { InfoPanel } from './InfoPanel'
import { LoadingScreen } from './LoadingScreen'

function chooseScaleBar(kilometresPerPixel: number) {
  const ideal = Math.max(kilometresPerPixel, 0.000001) * 54
  const magnitude = 10 ** Math.floor(Math.log10(ideal))
  const multiple = [1, 2, 5, 10].reduce(
    (best, candidate) => (candidate * magnitude <= ideal ? candidate : best),
    1,
  )
  const kilometres = multiple * magnitude
  const label =
    kilometres >= 1_000_000
      ? `${(kilometres / 1_000_000).toLocaleString()} million km`
      : kilometres >= 1
        ? `${kilometres.toLocaleString()} km`
        : `${Math.round(kilometres * 1000).toLocaleString()} m`
  return { kilometres, label, pixels: kilometres / kilometresPerPixel }
}

function formatDistance(kilometres: number) {
  if (kilometres >= 10_000_000) return `${(kilometres / 1_000_000).toFixed(1)} million km`
  if (kilometres >= 1_000_000) return `${(kilometres / 1_000_000).toFixed(2)} million km`
  return `${Math.round(kilometres).toLocaleString()} km`
}

export function Interface() {
  const focus = useExplorerStore((state) => state.focus)
  const goBack = useExplorerStore((state) => state.goBack)
  const goHome = useExplorerStore((state) => state.goHome)
  const distanceMode = useExplorerStore((state) => state.distanceMode)
  const setDistanceMode = useExplorerStore((state) => state.setDistanceMode)
  const directoryOpen = useExplorerStore((state) => state.directoryOpen)
  const setDirectoryOpen = useExplorerStore((state) => state.setDirectoryOpen)
  const featuresVisible = useExplorerStore((state) => state.featuresVisible)
  const setFeaturesVisible = useExplorerStore((state) => state.setFeaturesVisible)
  const showCountryBorders = useExplorerStore((state) => state.showCountryBorders)
  const setShowCountryBorders = useExplorerStore((state) => state.setShowCountryBorders)
  const showOrbits = useExplorerStore((state) => state.showOrbits)
  const setShowOrbits = useExplorerStore((state) => state.setShowOrbits)
  const simulationTimeMs = useExplorerStore((state) => state.simulationTimeMs)
  const setSimulationTime = useExplorerStore((state) => state.setSimulationTime)
  const viewScaleKmPerPixel = useExplorerStore((state) => state.viewScaleKmPerPixel)
  const cameraRangeKm = useExplorerStore((state) => state.cameraRangeKm)
  const dismissPanels = useExplorerStore((state) => state.dismissPanels)

  const ephemeris = useMemo(
    () => calculateSolarSystemEphemeris(new Date(simulationTimeMs), distanceMode),
    [distanceMode, simulationTimeMs],
  )
  const utcLabel = useMemo(
    () =>
      new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'medium',
        timeZone: 'UTC',
      }).format(new Date(simulationTimeMs)),
    [simulationTimeMs],
  )

  useEffect(() => {
    setSimulationTime(Date.now())
    const timer = window.setInterval(() => setSimulationTime(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [setSimulationTime])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement
      const isTyping = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA'

      if (event.key === 'Escape') dismissPanels()
      if (event.key === '/' && !isTyping) {
        event.preventDefault()
        setDirectoryOpen(true)
      }
      if (!isTyping && (event.key === 'Backspace' || event.key === 'ArrowLeft')) goBack()
      if (!isTyping && event.key === '1') goHome()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [dismissPanels, setDirectoryOpen, goBack, goHome])

  const scaleBar = chooseScaleBar(viewScaleKmPerPixel)
  const focusEntity = findEntity(focus === 'system' ? null : focus)
  const focusLabel = focus === 'system' ? 'system target' : (focusEntity?.name ?? focus)
  const canGoBack = focus !== 'system'

  return (
    <div className="interface">
      <header className="topbar">
        <div className="brand" aria-label="OmniAtlas">
          <span className="brand-orbit" aria-hidden="true"><i /></span>
          <span>OMNI<strong>ATLAS</strong></span>
        </div>

        <nav className="focus-nav panel" aria-label="Navigation">
          <button
            type="button"
            className="icon-button"
            onClick={goBack}
            disabled={!canGoBack}
            aria-label="Go back"
          >
            ‹
          </button>
          <button
            type="button"
            className={`focus-nav-home ${focus === 'system' ? 'active' : ''}`}
            onClick={goHome}
            aria-label="Return to system view"
          >
            <span aria-hidden="true">⊙</span>
            <span className="focus-nav-home-label">System</span>
          </button>
          {focus !== 'system' && (
            <>
              <span className="focus-nav-sep" aria-hidden="true">/</span>
              <span className="focus-nav-current">{focusLabel}</span>
            </>
          )}
        </nav>

        <button
          type="button"
          className={`directory-trigger panel ${directoryOpen ? 'active' : ''}`}
          onClick={() => setDirectoryOpen(!directoryOpen)}
          aria-expanded={directoryOpen}
          aria-controls="object-directory"
        >
          <span className="directory-grid" aria-hidden="true">▦</span>
          Directory
          <kbd>/</kbd>
        </button>
      </header>

      <div className="time-chip panel">
        <span className="live-dot" aria-hidden="true" />
        <div>
          <strong>LIVE UTC</strong>
          <time dateTime={new Date(simulationTimeMs).toISOString()}>{utcLabel}</time>
        </div>
      </div>

      <section className="view-controls panel" aria-label="View controls">
        <p className="kicker">View model</p>
        <div className="segmented-control">
          <button
            type="button"
            className={distanceMode === 'exploration' ? 'active' : ''}
            onClick={() => setDistanceMode('exploration')}
          >
            Explore
          </button>
          <button
            type="button"
            className={distanceMode === 'physical' ? 'active' : ''}
            onClick={() => setDistanceMode('physical')}
          >
            Real
          </button>
        </div>
        <div className="distance-readout">
          <span className="map-scale" aria-label={`${scaleBar.label} at the camera target`}>
            <i style={{ width: `${scaleBar.pixels}px` }} />
            <small>{scaleBar.label}</small>
          </span>
          <div>
            <strong>{formatDistance(cameraRangeKm)}</strong>
            <small>Camera to {focusLabel} · updates while zooming</small>
          </div>
        </div>
        <p className="scale-disclosure">
          {distanceMode === 'physical'
            ? `One shared kilometre scale · Moon ${Math.round(ephemeris.moonDistanceKm).toLocaleString()} km · Sun ${Math.round(ephemeris.sunDistanceKm / 1_000_000)} million km`
            : `Body sizes are true to scale · distances between bodies are compressed for navigation`}
        </p>

        <div className="layer-toggles">
          <p className="kicker">Layers</p>
          <label className="toggle-row">
            <span>
              <strong>Surface labels</strong>
              <small>Countries, cities, and named craters on zoom</small>
            </span>
            <input
              type="checkbox"
              checked={featuresVisible}
              onChange={(event) => setFeaturesVisible(event.target.checked)}
            />
            <i aria-hidden="true" />
          </label>
          <label className="toggle-row">
            <span>
              <strong>Country borders</strong>
              <small>Natural Earth boundary outlines</small>
            </span>
            <input
              type="checkbox"
              checked={showCountryBorders}
              onChange={(event) => setShowCountryBorders(event.target.checked)}
            />
            <i aria-hidden="true" />
          </label>
          <label className="toggle-row">
            <span>
              <strong>Orbit paths</strong>
              <small>Reference circles at each planet’s mean distance</small>
            </span>
            <input
              type="checkbox"
              checked={showOrbits}
              onChange={(event) => setShowOrbits(event.target.checked)}
            />
            <i aria-hidden="true" />
          </label>
        </div>
      </section>

      <InfoPanel />
      <DirectoryPanel />

      <div className="interaction-hint panel">
        <span><i className="mouse-icon" /> Drag to orbit</span>
        <span><i className="scroll-icon" /> Scroll to zoom</span>
        <span><i className="pan-icon" /> Right-drag to pan</span>
      </div>

      <footer className="attribution">
        <span>LIVE UTC EPHEMERIS · IAU ROTATION MODEL · KEPLERIAN MOON ORBITS</span>
        <span>
          Surface data: <a href="https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry/" target="_blank" rel="noreferrer">NASA Blue Marble</a>
          {' · '}
          <a href="https://svs.gsfc.nasa.gov/4720/" target="_blank" rel="noreferrer">LRO / LOLA</a>
          {' · '}
          <a href="https://www.naturalearthdata.com/" target="_blank" rel="noreferrer">Natural Earth</a>
          {' · '}
          <a href="https://planetarynames.wr.usgs.gov/Nomenclature" target="_blank" rel="noreferrer">USGS Gazetteer</a>
          {' · '}
          <a href="https://www.solarsystemscope.com/textures/" target="_blank" rel="noreferrer">Solar System Scope</a>
          {' · '}
          <a href="https://ssd.jpl.nasa.gov/" target="_blank" rel="noreferrer">JPL Solar System Dynamics</a>
        </span>
      </footer>

      <LoadingScreen />
    </div>
  )
}
