import { create } from 'zustand'

export type FocusTarget = 'system' | 'sun' | 'earth' | 'moon'
export type DistanceMode = 'exploration' | 'physical'

interface ExplorerState {
  focus: FocusTarget
  distanceMode: DistanceMode
  selectedId: string | null
  directoryOpen: boolean
  featuresVisible: boolean
  simulationTimeMs: number
  viewScaleKmPerPixel: number
  cameraRangeKm: number
  setFocus: (focus: FocusTarget) => void
  setDistanceMode: (mode: DistanceMode) => void
  select: (id: string | null) => void
  inspect: (id: string, bodyId: 'earth' | 'moon' | 'sun') => void
  setSimulationTime: (timeMs: number) => void
  setViewScaleKmPerPixel: (scale: number) => void
  setCameraRangeKm: (distance: number) => void
  setDirectoryOpen: (open: boolean) => void
  setFeaturesVisible: (visible: boolean) => void
  dismissPanels: () => void
}

export const useExplorerStore = create<ExplorerState>((set) => ({
  focus: 'system',
  distanceMode: 'exploration',
  selectedId: null,
  directoryOpen: false,
  featuresVisible: true,
  simulationTimeMs: Date.now(),
  viewScaleKmPerPixel: 100,
  cameraRangeKm: 80_000,
  setFocus: (focus) => set({ focus }),
  setDistanceMode: (distanceMode) => set({ distanceMode }),
  select: (selectedId) => set({ selectedId }),
  inspect: (selectedId, bodyId) =>
    set({ selectedId, focus: bodyId, directoryOpen: false }),
  setSimulationTime: (simulationTimeMs) => set({ simulationTimeMs }),
  setViewScaleKmPerPixel: (viewScaleKmPerPixel) => set({ viewScaleKmPerPixel }),
  setCameraRangeKm: (cameraRangeKm) => set({ cameraRangeKm }),
  setDirectoryOpen: (directoryOpen) => set({ directoryOpen }),
  setFeaturesVisible: (featuresVisible) => set({ featuresVisible }),
  dismissPanels: () => set({ directoryOpen: false, selectedId: null }),
}))
