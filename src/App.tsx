import { SceneManager } from './components/scene/SceneManager'
import { Interface } from './components/ui/Interface'
import './styles/ui.css'

function App() {
  return (
    <main className="app-shell">
      <SceneManager />
      <Interface />
    </main>
  )
}

export default App
