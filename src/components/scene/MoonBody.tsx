import { useTexture } from '@react-three/drei'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { MOON_CRATERS_URL, MOON_RADIUS_UNITS, type CraterRecord } from '../../data/catalog'
import { useRemoteJson } from '../../data/remoteAssets'
import { useExplorerStore } from '../../store/useExplorerStore'
import { SurfaceLabelField, type SurfaceLabelItem, type TierBand } from './SurfaceLabelField'

const CRATER_TIER_BANDS: TierBand[] = [
  { minRadii: 5.5, maxTier: 0 },
  { minRadii: 3.2, maxTier: 1 },
  { minRadii: 2.1, maxTier: 2 },
  { minRadii: 1.5, maxTier: 3 },
  { minRadii: 1.2, maxTier: 4 },
  { minRadii: 1.06, maxTier: 5 },
]

interface MoonBodyProps {
  radiusUnits?: number
}

export function MoonBody({ radiusUnits = MOON_RADIUS_UNITS }: MoonBodyProps) {
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
  const focusOn = useExplorerStore((state) => state.focusOn)
  const focus = useExplorerStore((state) => state.focus)
  const featuresVisible = useExplorerStore((state) => state.featuresVisible)
  const active = focus === 'moon' && featuresVisible
  const craters = useRemoteJson<CraterRecord[]>(MOON_CRATERS_URL, active)

  const craterItems: SurfaceLabelItem[] = useMemo(
    () =>
      (craters ?? []).map((crater) => ({
        id: crater.id,
        name: crater.name,
        latitude: crater.latitude,
        longitude: crater.longitude,
        tier: crater.tier,
      })),
    [craters],
  )

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
          focusOn('moon')
        }}
        onPointerEnter={() => {
          document.body.style.cursor = 'pointer'
        }}
        onPointerLeave={() => {
          document.body.style.cursor = 'default'
        }}
      >
        <sphereGeometry args={[radiusUnits, 128, 96]} />
        <meshStandardMaterial
          map={surface}
          bumpMap={elevation}
          bumpScale={0.018}
          roughness={0.96}
          metalness={0}
        />
      </mesh>
      <SurfaceLabelField
        bodyId="moon"
        radius={radiusUnits}
        items={craterItems}
        tierBands={CRATER_TIER_BANDS}
        maxVisible={60}
        accentColor="#cbd3d7"
      />
    </group>
  )
}
