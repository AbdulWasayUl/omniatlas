import { Canvas } from '@react-three/fiber'
import { Suspense } from 'react'
import * as THREE from 'three'
import { useExplorerStore } from '../../store/useExplorerStore'
import { CameraRig } from './CameraRig'
import { SolarSystemScene } from './SolarSystemScene'

export function SceneManager() {
  const select = useExplorerStore((state) => state.select)

  return (
    <Canvas
      className="scene-canvas"
      dpr={[1, 2]}
      camera={{ position: [3.6, 2.2, 12.5], fov: 42, near: 0.01, far: 400 }}
      gl={{
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
        logarithmicDepthBuffer: true,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.05,
      }}
      onPointerMissed={() => select(null)}
    >
      <Suspense fallback={null}>
        <SolarSystemScene />
        <CameraRig />
      </Suspense>
    </Canvas>
  )
}
