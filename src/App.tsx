import { useState } from 'react'
import type { AtlasViewer } from './core/AtlasViewer'
import { AppChrome } from './ui/AppChrome'
import { SceneHost } from './ui/SceneHost'

function App() {
  const [viewer, setViewer] = useState<AtlasViewer | null>(null)

  return (
    <main className="app-shell">
      <SceneHost onViewer={setViewer} />
      <AppChrome viewer={viewer} />
    </main>
  )
}

export default App
