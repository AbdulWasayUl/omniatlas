import { useTexture } from '@react-three/drei'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { AtlasEntity } from '../../data/catalog'
import { useExplorerStore } from '../../store/useExplorerStore'

interface PlanetBodyProps {
  planet: AtlasEntity
  radiusUnits: number
}

function useSrgbTexture(url: string) {
  const loaded = useTexture(url)
  const texture = useMemo(() => {
    const clone = loaded.clone()
    clone.colorSpace = THREE.SRGBColorSpace
    clone.anisotropy = 8
    clone.needsUpdate = true
    return clone
  }, [loaded])
  useEffect(() => () => texture.dispose(), [texture])
  return texture
}

function buildAnnulusUvs(geometry: THREE.RingGeometry, innerRadius: number, outerRadius: number) {
  const position = geometry.attributes.position
  const uv = geometry.attributes.uv as THREE.BufferAttribute
  const vertex = new THREE.Vector3()
  for (let index = 0; index < position.count; index += 1) {
    vertex.fromBufferAttribute(position, index)
    const distance = vertex.length()
    const fraction = THREE.MathUtils.clamp((distance - innerRadius) / (outerRadius - innerRadius), 0, 1)
    uv.setXY(index, fraction, 1)
  }
  uv.needsUpdate = true
}

function PlanetRing({ radiusUnits, textureUrl }: { radiusUnits: number; textureUrl: string }) {
  const texture = useSrgbTexture(textureUrl)
  const innerRadius = radiusUnits * 1.15
  const outerRadius = radiusUnits * 2.3
  const geometry = useMemo(() => {
    const value = new THREE.RingGeometry(innerRadius, outerRadius, 128, 1)
    buildAnnulusUvs(value, innerRadius, outerRadius)
    return value
  }, [innerRadius, outerRadius])
  useEffect(() => () => geometry.dispose(), [geometry])

  return (
    <mesh geometry={geometry} rotation={[Math.PI / 2, 0, 0]} renderOrder={2}>
      <meshBasicMaterial
        map={texture}
        transparent
        side={THREE.DoubleSide}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  )
}

function PlanetClickTarget({
  planet,
  radiusUnits,
  children,
}: {
  planet: AtlasEntity
  radiusUnits: number
  children: React.ReactNode
}) {
  const select = useExplorerStore((state) => state.select)
  const focusOn = useExplorerStore((state) => state.focusOn)

  return (
    <group>
      <mesh
        onClick={(event) => {
          event.stopPropagation()
          select(planet.id)
          focusOn(planet.id)
        }}
        onPointerEnter={() => {
          document.body.style.cursor = 'pointer'
        }}
        onPointerLeave={() => {
          document.body.style.cursor = 'default'
        }}
      >
        <sphereGeometry args={[radiusUnits, 96, 64]} />
        {children}
      </mesh>
    </group>
  )
}

function TexturedPlanet({ planet, radiusUnits }: PlanetBodyProps) {
  const texture = useSrgbTexture(planet.textureUrl!)
  return (
    <>
      <PlanetClickTarget planet={planet} radiusUnits={radiusUnits}>
        <meshStandardMaterial map={texture} roughness={0.86} metalness={0} envMapIntensity={0.12} />
      </PlanetClickTarget>
      {planet.atmosphereTextureUrl && (
        <VenusAtmosphere radiusUnits={radiusUnits} textureUrl={planet.atmosphereTextureUrl} />
      )}
      {planet.ringTextureUrl && <PlanetRing radiusUnits={radiusUnits} textureUrl={planet.ringTextureUrl} />}
    </>
  )
}

function VenusAtmosphere({ radiusUnits, textureUrl }: { radiusUnits: number; textureUrl: string }) {
  const texture = useSrgbTexture(textureUrl)
  return (
    <mesh scale={1.012} renderOrder={2}>
      <sphereGeometry args={[radiusUnits, 64, 48]} />
      <meshStandardMaterial
        map={texture}
        transparent
        opacity={0.75}
        roughness={1}
        depthWrite={false}
      />
    </mesh>
  )
}

function PlainPlanet({ planet, radiusUnits }: PlanetBodyProps) {
  return (
    <PlanetClickTarget planet={planet} radiusUnits={radiusUnits}>
      <meshStandardMaterial color="#b7ab97" roughness={0.92} metalness={0} />
    </PlanetClickTarget>
  )
}

export function PlanetBody({ planet, radiusUnits }: PlanetBodyProps) {
  return planet.textureUrl ? (
    <TexturedPlanet planet={planet} radiusUnits={radiusUnits} />
  ) : (
    <PlainPlanet planet={planet} radiusUnits={radiusUnits} />
  )
}
