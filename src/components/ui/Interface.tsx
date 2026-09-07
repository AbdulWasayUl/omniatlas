import { useEffect, useMemo } from 'react'
import { calculateSceneEphemeris } from '../../astronomy/ephemeris'
import { useExplorerStore, type FocusTarget } from '../../store/useExplorerStore'
import { DirectoryPanel } from './DirectoryPanel'
import { InfoPanel } from './InfoPanel'
import { LoadingScreen } from './LoadingScreen'

const destinations: { id: FocusTarget; label: string; shortcut: string }[] = [
  { id: 'system', label: 'System', shortcut: '1' },
  { id: 'earth', label: 'Earth', shortcut: '2' },
  { id: 'moon', label: 'Moon', shortcut: '3' },
  { id: 'sun', label: 'Sun', shortcut: '4' },
]

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
  const setFocus = useExplorerStore((state) => state.setFocus)
  const distanceMode = useExplorerStore((state) => state.distanceMode)
  const setDistanceMode = useExplorerStore((state) => state.setDistanceMode)
  const directoryOpen = useExplorerStore((state) => state.directoryOpen)
  const setDirectoryOpen = useExplorerStore((state) => state.setDirectoryOpen)
  const featuresVisible = useExplorerStore((state) => state.featuresVisible)
  const setFeaturesVisible = useExplorerStore((state) => state.setFeaturesVisible)
  const simulationTimeMs = useExplorerStore((state) => state.simulationTimeMs)
  const setSimulationTime = useExplorerStore((state) => state.setSimulationTime)
  const viewScaleKmPerPixel = useExplorerStore((state) => state.viewScaleKmPerPixel)
  const cameraRangeKm = useExplorerStore((state) => state.cameraRangeKm)
  const dismissPanels = useExplorerStore((state) => state.dismissPanels)

  const ephemeris = useMemo(
    () => calculateSceneEphemeris(new Date(simulationTimeMs), distanceMode),
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
      if (!isTyping && event.key === '1') setFocus('system')
      if (!isTyping && event.key === '2') setFocus('earth')
      if (!isTyping && event.key === '3') setFocus('moon')
      if (!isTyping && event.key === '4') setFocus('sun')
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [dismissPanels, setDirectoryOpen, setFocus])

  const scaleBar = chooseScaleBar(viewScaleKmPerPixel)
  const focusLabel = focus === 'system' ? 'system target' : focus

  return (
    <div className="interface">
      <header className="topbar">
        <div className="brand" aria-label="OmniAtlas">
          <span className="brand-orbit" aria-hidden="true"><i /></span>
          <span>OMNI<strong>ATLAS</strong></span>
        </div>

        <nav className="destination-nav panel" aria-label="Destinations">
          {destinations.map((destination) => (
            <button
              type="button"
              key={destination.id}
              className={focus === destination.id ? 'active' : ''}
              onClick={() => setFocus(destination.id)}
            >
              <kbd>{destination.shortcut}</kbd>
              {destination.label}
            </button>
          ))}
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

      <div className="milestone-chip">
        <span>FOUNDATION 01</span>
        <strong>SUN · EARTH · MOON</strong>
      </div>

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
            True distance
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
        <label className="toggle-row">
          <span>
            <strong>Surface features</strong>
            <small>Reveal the nearest local label on close zoom</small>
          </span>
          <input
            type="checkbox"
            checked={featuresVisible}
            onChange={(event) => setFeaturesVisible(event.target.checked)}
          />
          <i aria-hidden="true" />
        </label>
        <p className="scale-disclosure">
          {distanceMode === 'physical'
            ? `One shared kilometre scale · Moon ${Math.round(ephemeris.moonDistanceKm).toLocaleString()} km · Sun ${Math.round(ephemeris.sunDistanceKm / 1_000_000)} million km`
            : `Local body scale is true · Moon ${Math.round(ephemeris.moonDistanceKm).toLocaleString()} km actual · scene spacing compressed`}
        </p>
      </section>

      <InfoPanel />
      <DirectoryPanel />

      <div className="interaction-hint panel">
        <span><i className="mouse-icon" /> Drag to orbit</span>
        <span><i className="scroll-icon" /> Scroll to zoom</span>
        <span><i className="pan-icon" /> Right-drag to pan</span>
      </div>

      <footer className="attribution">
        <span>LIVE UTC EPHEMERIS · IAU ROTATION MODEL</span>
        <span>
          Surface data: <a href="https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry/" target="_blank" rel="noreferrer">NASA Blue Marble</a>
          {' · '}
          <a href="https://svs.gsfc.nasa.gov/4720/" target="_blank" rel="noreferrer">LRO / LOLA</a>
          {' · '}
          <a href="https://www.naturalearthdata.com/downloads/50m-physical-vectors/50m-coastline/" target="_blank" rel="noreferrer">Natural Earth</a>
          {' · '}
          <a href="https://planetarynames.wr.usgs.gov/Nomenclature" target="_blank" rel="noreferrer">USGS Gazetteer</a>
        </span>
      </footer>

      <LoadingScreen />
    </div>
  )
}
