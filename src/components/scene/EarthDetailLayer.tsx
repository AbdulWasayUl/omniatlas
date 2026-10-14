import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import {
  CITIES_URL,
  COUNTRIES_BOUNDARY_URL,
  COUNTRIES_URL,
  type CityRecord,
  type CountryRecord,
} from '../../data/catalog'
import { useRemoteBinary, useRemoteJson } from '../../data/remoteAssets'
import { useExplorerStore } from '../../store/useExplorerStore'
import { SurfaceLabelField, type SurfaceLabelItem, type TierBand } from './SurfaceLabelField'

const COASTLINE_URL = '/data/earth/coastline-50m.bin'
const COUNTRY_COLOR = '#e7c98a'
const CITY_COLOR = '#9ad4ef'

// One shared reveal schedule for both layers so a big country and a megacity can
// appear together at the same zoom, the way a real map interleaves label classes
// instead of showing one whole category before the other ever starts.
const LABEL_TIER_BANDS: TierBand[] = [
  { minRadii: 12, maxTier: 1 },
  { minRadii: 6, maxTier: 2 },
  { minRadii: 3.4, maxTier: 4 },
  { minRadii: 2.1, maxTier: 6 },
  { minRadii: 1.5, maxTier: 8 },
  { minRadii: 1.15, maxTier: 12 },
]

interface BoundaryLayerProps {
  url: string
  active: boolean
  color: string
  baseOpacity: number
  renderOrder: number
}

function BoundaryLayer({ url, active, color, baseOpacity, renderOrder }: BoundaryLayerProps) {
  const positions = useRemoteBinary(url, active)
  const geometry = useMemo(() => {
    if (!positions) return null
    const value = new THREE.BufferGeometry()
    value.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    value.computeBoundingSphere()
    return value
  }, [positions])

  const line = useRef<THREE.LineSegments>(null)
  const material = useRef<THREE.LineBasicMaterial>(null)

  useFrame(({ camera }) => {
    const mesh = line.current
    const mat = material.current
    if (!mesh || !mat) return
    const center = mesh.getWorldPosition(SCRATCH_CENTER)
    const distance = camera.position.distanceTo(center)
    const opacity = active ? 1 - THREE.MathUtils.smoothstep(distance, 1.65, 3.1) : 0
    mesh.visible = opacity > 0.01
    mat.opacity = opacity * baseOpacity
  })

  if (!geometry) return null

  return (
    <lineSegments ref={line} geometry={geometry} renderOrder={renderOrder} visible={false}>
      <lineBasicMaterial
        ref={material}
        color={color}
        transparent
        opacity={0}
        depthTest
        depthWrite={false}
        toneMapped={false}
      />
    </lineSegments>
  )
}

const SCRATCH_CENTER = new THREE.Vector3()

export function EarthDetailLayer() {
  const focus = useExplorerStore((state) => state.focus)
  const featuresVisible = useExplorerStore((state) => state.featuresVisible)
  const showCountryBorders = useExplorerStore((state) => state.showCountryBorders)
  const active = focus === 'earth' && featuresVisible

  const countries = useRemoteJson<CountryRecord[]>(COUNTRIES_URL, active)
  const cities = useRemoteJson<CityRecord[]>(CITIES_URL, active)

  const labelItems: SurfaceLabelItem[] = useMemo(() => {
    const countryItems: SurfaceLabelItem[] = (countries ?? []).map((country) => ({
      id: country.id,
      name: country.name,
      latitude: country.latitude,
      longitude: country.longitude,
      tier: country.labelRank,
      variant: 'region',
      color: COUNTRY_COLOR,
    }))
    const cityItems: SurfaceLabelItem[] = (cities ?? []).map((city) => ({
      id: city.id,
      name: city.name,
      latitude: city.latitude,
      longitude: city.longitude,
      tier: city.tier,
      variant: 'point',
      color: CITY_COLOR,
    }))
    return [...countryItems, ...cityItems].sort((a, b) => a.tier - b.tier)
  }, [countries, cities])

  return (
    <group>
      <BoundaryLayer url={COASTLINE_URL} active={active} color="#a8d9ed" baseOpacity={0.58} renderOrder={5} />
      <BoundaryLayer
        url={COUNTRIES_BOUNDARY_URL}
        active={active && showCountryBorders}
        color={COUNTRY_COLOR}
        baseOpacity={0.4}
        renderOrder={6}
      />
      <SurfaceLabelField
        bodyId="earth"
        radius={1}
        items={labelItems}
        tierBands={LABEL_TIER_BANDS}
        maxVisible={90}
        accentColor={CITY_COLOR}
      />
    </group>
  )
}
