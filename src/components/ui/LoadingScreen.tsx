import { useProgress } from '@react-three/drei'

export function LoadingScreen() {
  const { active, progress } = useProgress()

  return (
    <div className={`loading-screen ${active ? '' : 'loading-screen--hidden'}`} aria-live="polite">
      <div className="loading-mark" aria-hidden="true">
        <span />
        <i />
      </div>
      <p className="kicker">Solar System atlas</p>
      <strong>Loading planetary data</strong>
      <div className="loading-track">
        <span style={{ width: `${Math.round(progress)}%` }} />
      </div>
      <small>{Math.round(progress)}% · NASA / USGS / Natural Earth</small>
    </div>
  )
}
