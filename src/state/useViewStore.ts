import { create } from 'zustand'
import type { ViewerSnapshot } from '../core/AtlasViewer'

/**
 * UI state only.
 *
 * The rule that makes this fast: nothing written every frame lives here. The viewer
 * publishes a throttled snapshot at 10 Hz; the camera, the ephemeris and the scene
 * graph are never React state. The old store mixed `directoryOpen` with
 * `viewScaleKmPerPixel`, which was written 6.7 times a second from inside a render
 * loop and re-rendered the whole tree each time.
 */

export type PanelId = 'inspector' | 'palette' | 'layers' | 'help' | 'stats'

interface ViewState {
  /** Latest throttled snapshot from the viewer. */
  snapshot: ViewerSnapshot | null
  /** Currently selected object id — distinct from the camera's anchor. */
  selectedId: string | null
  openPanels: Set<PanelId>
  /** Whether the first frame has been drawn. */
  ready: boolean
  /** Modules that failed to load, surfaced rather than hidden. */
  failedModules: string[]

  setSnapshot: (snapshot: ViewerSnapshot) => void
  select: (id: string | null) => void
  togglePanel: (id: PanelId, open?: boolean) => void
  isOpen: (id: PanelId) => boolean
  setReady: (ready: boolean) => void
  setFailedModules: (ids: string[]) => void
  closeAll: () => void
}

export const useViewStore = create<ViewState>((set, get) => ({
  snapshot: null,
  selectedId: null,
  openPanels: new Set<PanelId>(),
  ready: false,
  failedModules: [],

  setSnapshot: (snapshot) => set({ snapshot }),
  select: (selectedId) =>
    set((state) => {
      const openPanels = new Set(state.openPanels)
      if (selectedId) openPanels.add('inspector')
      else openPanels.delete('inspector')
      return { selectedId, openPanels }
    }),
  togglePanel: (id, open) =>
    set((state) => {
      const openPanels = new Set(state.openPanels)
      const shouldOpen = open ?? !openPanels.has(id)
      if (shouldOpen) openPanels.add(id)
      else openPanels.delete(id)
      return { openPanels }
    }),
  isOpen: (id) => get().openPanels.has(id),
  setReady: (ready) => set({ ready }),
  setFailedModules: (failedModules) => set({ failedModules }),
  closeAll: () => set({ openPanels: new Set<PanelId>(), selectedId: null }),
}))
