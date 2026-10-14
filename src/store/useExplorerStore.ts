import { create } from 'zustand'
import type { FocusTarget } from '../data/types'

export type { FocusTarget }
export type DistanceMode = 'exploration' | 'physical'

interface ExplorerState {
  focus: FocusTarget
  /** Previously-focused targets, most recent last — powers the back button. */
  focusStack: FocusTarget[]
  distanceMode: DistanceMode
  selectedId: string | null
  directoryOpen: boolean
  featuresVisible: boolean
  showCountryBorders: boolean
  showOrbits: boolean
  simulationTimeMs: number
  viewScaleKmPerPixel: number
  cameraRangeKm: number
  /** Navigate to a target, remembering where we came from for `goBack`. */
  focusOn: (focus: FocusTarget) => void
  /** Return to the previously-focused target, or the system view if none. */
  goBack: () => void
  /** Jump straight to the system view and clear the back history. */
  goHome: () => void
  setDistanceMode: (mode: DistanceMode) => void
  select: (id: string | null) => void
  /** Select and navigate to an object in one step (search results, directory rows). */
  inspect: (id: string, bodyId: string) => void
  setSimulationTime: (timeMs: number) => void
  setViewScaleKmPerPixel: (scale: number) => void
  setCameraRangeKm: (distance: number) => void
  setDirectoryOpen: (open: boolean) => void
  setFeaturesVisible: (visible: boolean) => void
  setShowCountryBorders: (visible: boolean) => void
  setShowOrbits: (visible: boolean) => void
  dismissPanels: () => void
}

export const useExplorerStore = create<ExplorerState>((set, get) => ({
  focus: 'system',
  focusStack: [],
  distanceMode: 'exploration',
  selectedId: null,
  directoryOpen: false,
  featuresVisible: true,
  showCountryBorders: true,
  showOrbits: true,
  simulationTimeMs: Date.now(),
  viewScaleKmPerPixel: 100,
  cameraRangeKm: 80_000,
  focusOn: (focus) => {
    const current = get().focus
    if (focus === current) return
    set({ focus, focusStack: [...get().focusStack, current] })
  },
  goBack: () => {
    const stack = [...get().focusStack]
    const previous = stack.pop()
    set({ focus: previous ?? 'system', focusStack: stack })
  },
  goHome: () => set({ focus: 'system', focusStack: [] }),
  setDistanceMode: (distanceMode) => set({ distanceMode }),
  select: (selectedId) => set({ selectedId }),
  inspect: (selectedId, bodyId) => {
    const current = get().focus
    const focusStack = bodyId === current ? get().focusStack : [...get().focusStack, current]
    set({ selectedId, focus: bodyId, focusStack, directoryOpen: false })
  },
  setSimulationTime: (simulationTimeMs) => set({ simulationTimeMs }),
  setViewScaleKmPerPixel: (viewScaleKmPerPixel) => set({ viewScaleKmPerPixel }),
  setCameraRangeKm: (cameraRangeKm) => set({ cameraRangeKm }),
  setDirectoryOpen: (directoryOpen) => set({ directoryOpen }),
  setFeaturesVisible: (featuresVisible) => set({ featuresVisible }),
  setShowCountryBorders: (showCountryBorders) => set({ showCountryBorders }),
  setShowOrbits: (showOrbits) => set({ showOrbits }),
  dismissPanels: () => set({ directoryOpen: false, selectedId: null }),
}))
