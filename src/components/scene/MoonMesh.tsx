import { useTexture } from '@react-three/drei'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { AtlasEntity } from '../../data/catalog'
import { useExplorerStore } from '../../store/useExplorerStore'

interface MoonMeshProps {
  moon: AtlasEntity
  radiusUnits: number
  color?: string
}

function ClickableSphere({
  moon,
  radiusUnits,
  children,
}: {
  moon: AtlasEntity
  radiusUnits: number
  children: React.ReactNode
}) {
  const select = useExplorerStore((state) => state.select)
  const focusOn = useExplorerStore((state) => state.focusOn)

  return (
    <mesh
      onClick={(event) => {
        event.stopPropagation()
        select(moon.id)
        focusOn(moon.id)
      }}
      onPointerEnter={() => {
        document.body.style.cursor = 'pointer'
      }}
      onPointerLeave={() => {
        document.body.style.cursor = 'default'
      }}
    >
      <sphereGeometry args={[radiusUnits, 48, 32]} />
      {children}
    </mesh>
  )
}

function TexturedMoon({ moon, radiusUnits }: MoonMeshProps) {
  const loaded = useTexture(moon.textureUrl!)
  const texture = useMemo(() => {
    const clone = loaded.clone()
    clone.colorSpace = THREE.SRGBColorSpace
    clone.anisotropy = 8
    clone.needsUpdate = true
    return clone
  }, [loaded])
  useEffect(() => () => texture.dispose(), [texture])

  return (
    <ClickableSphere moon={moon} radiusUnits={radiusUnits}>
      <meshStandardMaterial map={texture} roughness={0.95} metalness={0} />
    </ClickableSphere>
  )
}

function PlainMoon({ moon, radiusUnits, color }: MoonMeshProps) {
  return (
    <ClickableSphere moon={moon} radiusUnits={radiusUnits}>
      <meshStandardMaterial color={color ?? '#aaaaaa'} roughness={0.95} metalness={0} />
    </ClickableSphere>
  )
}

export function MoonMesh({ moon, radiusUnits, color }: MoonMeshProps) {
  return moon.textureUrl ? (
    <TexturedMoon moon={moon} radiusUnits={radiusUnits} />
  ) : (
    <PlainMoon moon={moon} radiusUnits={radiusUnits} color={color} />
  )
}
