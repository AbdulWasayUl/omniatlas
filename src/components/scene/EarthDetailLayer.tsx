import { Html } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { CONTINENTS } from '../../data/catalog'
import { latLonToCartesian } from '../../data/coordinates'
import { useExplorerStore } from '../../store/useExplorerStore'

export function EarthDetailLayer() {
  const root = useRef<THREE.Group>(null)
  const coastline = useRef<THREE.LineSegments>(null)
  const material = useRef<THREE.LineBasicMaterial>(null)
  const visibleIdRef = useRef<string | null>(null)
  const [visibleId, setVisibleId] = useState<string | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const focus = useExplorerStore((state) => state.focus)
  const featuresVisible = useExplorerStore((state) => state.featuresVisible)
  const selectedId = useExplorerStore((state) => state.selectedId)
  const inspect = useExplorerStore((state) => state.inspect)
  const active = focus === 'earth' && featuresVisible
  const center = useMemo(() => new THREE.Vector3(), [])
  const localCameraDirection = useMemo(() => new THREE.Vector3(), [])
  const worldQuaternion = useMemo(() => new THREE.Quaternion(), [])
  const normal = useMemo(() => new THREE.Vector3(), [])
  const anchors = useMemo(
    () =>
      new Map(
        CONTINENTS.map((continent) => [
          continent.id,
          latLonToCartesian(
            continent.coordinates?.latitude ?? 0,
            continent.coordinates?.longitude ?? 0,
            1.027,
          ),
        ]),
      ),
    [],
  )

  useEffect(() => {
    if (!active || positions) return
    const controller = new AbortController()
    fetch('/data/earth/coastline-50m.bin', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Coastline request failed: ${response.status}`)
        return response.arrayBuffer()
      })
      .then((buffer) => setPositions(new Float32Array(buffer)))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) console.error(error)
      })
    return () => controller.abort()
  }, [active, positions])

  const geometry = useMemo(() => {
    if (!positions) return null
    const value = new THREE.BufferGeometry()
    value.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    value.computeBoundingSphere()
    return value
  }, [positions])

  useEffect(() => () => geometry?.dispose(), [geometry])

  useFrame(({ camera }) => {
    if (!root.current) return
    root.current.getWorldPosition(center)
    const distance = camera.position.distanceTo(center)
    const opacity = active ? 1 - THREE.MathUtils.smoothstep(distance, 1.65, 2.85) : 0
    if (coastline.current) coastline.current.visible = opacity > 0.01
    if (material.current) material.current.opacity = opacity * 0.58

    let nextId: string | null = null
    if (active) {
      root.current.getWorldQuaternion(worldQuaternion)
      localCameraDirection
        .copy(camera.position)
        .sub(center)
        .normalize()
        .applyQuaternion(worldQuaternion.invert())

      const selected = CONTINENTS.find((continent) => continent.id === selectedId)
      const selectedAnchor = selected ? anchors.get(selected.id) : null
      if (
        selectedAnchor &&
        distance < 3.3 &&
        normal.copy(selectedAnchor).normalize().dot(localCameraDirection) > 0.72
      ) {
        nextId = selected?.id ?? null
      } else if (distance < 2.3) {
        let bestDot = 0.95
        for (const continent of CONTINENTS) {
          const anchor = anchors.get(continent.id)
          if (!anchor) continue
          const dot = normal.copy(anchor).normalize().dot(localCameraDirection)
          if (dot > bestDot) {
            bestDot = dot
            nextId = continent.id
          }
        }
      }
    }

    if (nextId !== visibleIdRef.current) {
      visibleIdRef.current = nextId
      setVisibleId(nextId)
    }
  })

  const continent = CONTINENTS.find((item) => item.id === visibleId)
  const anchor = continent ? anchors.get(continent.id) : null

  return (
    <group ref={root}>
      {geometry && (
        <lineSegments ref={coastline} geometry={geometry} renderOrder={5} visible={false}>
          <lineBasicMaterial
            ref={material}
            color="#a8d9ed"
            transparent
            opacity={0}
            depthTest
            depthWrite={false}
            toneMapped={false}
          />
        </lineSegments>
      )}
      {continent && anchor && (
        <group position={anchor}>
          <Html center distanceFactor={1.55} zIndexRange={[8, 2]}>
            <button
              type="button"
              className="continent-label"
              onClick={(event) => {
                event.stopPropagation()
                inspect(continent.id, 'earth')
              }}
            >
              {continent.name}
            </button>
          </Html>
        </group>
      )}
    </group>
  )
}
