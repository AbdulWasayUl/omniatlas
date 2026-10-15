import { useEffect, useRef } from 'react'
import { AtlasViewer } from '../core/AtlasViewer'
import { applyUrlState, parseUrlState, startUrlSync } from '../state/urlState'
import { useViewStore } from '../state/useViewStore'

/**
 * Mounts the viewer onto a canvas pair and keeps it alive for the app's lifetime.
 *
 * This is the entire React surface of the 3D scene. React owns the two elements; the
 * viewer owns everything inside them. No scene object is a component and no frame goes
 * through a reconciler.
 *
 * The second canvas is the label overlay. It sits above the WebGL canvas but is
 * pointer-transparent, so clicks fall through to the controls — which also run the
 * marker hit-test, so selection and orbiting share one gesture stream.
 */
export function SceneHost({ onViewer }: { onViewer?: (viewer: AtlasViewer | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const labelRef = useRef<HTMLCanvasElement>(null)
  const setSnapshot = useViewStore((state) => state.setSnapshot)
  const setReady = useViewStore((state) => state.setReady)
  const setFailedModules = useViewStore((state) => state.setFailedModules)
  const select = useViewStore((state) => state.select)

  useEffect(() => {
    const canvas = canvasRef.current
    const labelCanvas = labelRef.current
    if (!canvas || !labelCanvas) return
    let stopUrlSync: (() => void) | null = null

    const viewer = new AtlasViewer({
      canvas,
      labelCanvas,
      modules: [
        {
          id: 'solar',
          load: async () => {
            const { SolarModule } = await import('../modules/solar')
            return new SolarModule()
          },
        },
        {
          id: 'smallbodies',
          load: async () => {
            const { SmallBodiesModule } = await import('../modules/smallbodies')
            return new SmallBodiesModule()
          },
        },
        {
          id: 'stars',
          load: async () => {
            const { StarsModule } = await import('../modules/stars')
            return new StarsModule()
          },
        },
        {
          id: 'deepsky',
          load: async () => {
            const { DeepSkyModule } = await import('../modules/deepsky')
            return new DeepSkyModule()
          },
        },
        {
          id: 'galaxy',
          load: async () => {
            const { GalaxyModule } = await import('../modules/galaxy')
            return new GalaxyModule()
          },
        },
        {
          id: 'cosmos',
          load: async () => {
            const { CosmosModule } = await import('../modules/cosmos')
            return new CosmosModule()
          },
        },
        {
          id: 'notable',
          load: async () => {
            const { NotableModule } = await import('../modules/notable')
            return new NotableModule()
          },
        },
        {
          // Last, so its preRender sees the positions every other module just wrote.
          id: 'proxy',
          load: async () => {
            const { ProxyModule } = await import('../modules/proxy')
            return new ProxyModule()
          },
        },
      ],
      onSnapshot: setSnapshot,
      onSelect: select,
      onReady: () => {
        // Restore the shared view before revealing the scene, so a deep link never
        // shows the default camera for a frame and then jumps.
        const urlState = parseUrlState()
        applyUrlState(viewer, urlState)
        if (urlState.focus) select(urlState.focus)
        stopUrlSync = startUrlSync(viewer)
        setReady(true)
        setFailedModules(viewer.engine.failedModules.map((f) => f.id))
      },
    })

    onViewer?.(viewer)
    // A handle for debugging and for driving the browser in end-to-end checks.
    // Development only: shipping a live engine reference on `window` invites both
    // console-poking and a memory leak that survives navigation.
    if (import.meta.env.DEV) {
      ;(window as unknown as { __viewer?: unknown }).__viewer = viewer
    }

    return () => {
      onViewer?.(null)
      stopUrlSync?.()
      viewer.dispose()
    }
    // The viewer is created once and owns its own lifecycle; re-running this effect
    // would tear down the GPU context on every store identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <canvas ref={canvasRef} className="scene-canvas" aria-label="Three-dimensional atlas of the universe" />
      <canvas ref={labelRef} className="label-canvas" aria-hidden="true" />
    </>
  )
}
