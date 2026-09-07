import { useTexture } from '@react-three/drei'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { MOON_RADIUS_UNITS, SURFACE_FEATURES } from '../../data/catalog'
import { useExplorerStore } from '../../store/useExplorerStore'
import { FeatureMarkers } from './FeatureMarkers'

export function MoonBody() {
  const [loadedSurface, loadedElevation] = useTexture([
    '/textures/moon/lroc-color-4k.jpg',
    '/textures/moon/lola-elevation-4ppd.jpg',
  ])
  const surface = useMemo(() => {
    const texture = loadedSurface.clone()
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 8
    texture.needsUpdate = true
    return texture
  }, [loadedSurface])
  const elevation = useMemo(() => {
    const texture = loadedElevation.clone()
    texture.colorSpace = THREE.NoColorSpace
    texture.anisotropy = 8
    texture.needsUpdate = true
    return texture
  }, [loadedElevation])
  const select = useExplorerStore((state) => state.select)
  const setFocus = useExplorerStore((state) => state.setFocus)
  const moonFeatures = SURFACE_FEATURES.filter((feature) => feature.bodyId === 'moon')

  useEffect(() => {
    return () => {
      surface.dispose()
      elevation.dispose()
    }
  }, [surface, elevation])

  return (
    <group>
      <mesh
        onClick={(event) => {
          event.stopPropagation()
          select('moon')
        }}
        onDoubleClick={(event) => {
          event.stopPropagation()
          setFocus('moon')
          select('moon')
        }}
        onPointerEnter={() => {
          document.body.style.cursor = 'pointer'
        }}
        onPointerLeave={() => {
          document.body.style.cursor = 'default'
        }}
      >
        <sphereGeometry args={[MOON_RADIUS_UNITS, 128, 96]} />
        <meshStandardMaterial
          map={surface}
          bumpMap={elevation}
          bumpScale={0.018}
          roughness={0.96}
          metalness={0}
        />
      </mesh>
      <FeatureMarkers
        bodyId="moon"
        radius={MOON_RADIUS_UNITS}
        features={moonFeatures}
      />
    </group>
  )
}
