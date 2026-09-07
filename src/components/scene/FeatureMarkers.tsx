import { Html } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import type { AtlasEntity } from '../../data/catalog'
import { latLonToCartesian } from '../../data/coordinates'
import { useExplorerStore } from '../../store/useExplorerStore'

interface FeatureMarkersProps {
  bodyId: 'earth' | 'moon'
  radius: number
  features: AtlasEntity[]
}

export function FeatureMarkers({ bodyId, radius, features }: FeatureMarkersProps) {
  const root = useRef<THREE.Group>(null)
  const [visibleId, setVisibleId] = useState<string | null>(null)
  const visibleIdRef = useRef<string | null>(null)
  const focus = useExplorerStore((state) => state.focus)
  const featuresVisible = useExplorerStore((state) => state.featuresVisible)
  const selectedId = useExplorerStore((state) => state.selectedId)
  const inspect = useExplorerStore((state) => state.inspect)
  const center = useMemo(() => new THREE.Vector3(), [])
  const localCameraDirection = useMemo(() => new THREE.Vector3(), [])
  const worldQuaternion = useMemo(() => new THREE.Quaternion(), [])
  const normal = useMemo(() => new THREE.Vector3(), [])
  const anchors = useMemo(
    () =>
      new Map(
        features.map((feature) => [
          feature.id,
          feature.coordinates
            ? latLonToCartesian(
                feature.coordinates.latitude,
                feature.coordinates.longitude,
                radius * 1.018,
              )
            : new THREE.Vector3(),
        ]),
      ),
    [features, radius],
  )
  useFrame(({ camera }) => {
    let nextId: string | null = null
    if (root.current && featuresVisible && focus === bodyId) {
      root.current.getWorldPosition(center)
      const distanceInRadii = camera.position.distanceTo(center) / radius
      root.current.getWorldQuaternion(worldQuaternion)
      localCameraDirection
        .copy(camera.position)
        .sub(center)
        .normalize()
        .applyQuaternion(worldQuaternion.invert())

      const selected = features.find((feature) => feature.id === selectedId)
      const selectedAnchor = selected ? anchors.get(selected.id) : null
      if (
        selectedAnchor &&
        distanceInRadii < 3.05 &&
        normal.copy(selectedAnchor).normalize().dot(localCameraDirection) > 0.72
      ) {
        nextId = selected?.id ?? null
      } else if (distanceInRadii < (bodyId === 'moon' ? 2.15 : 2.25)) {
        let bestDot = bodyId === 'moon' ? 0.965 : 0.95
        for (const feature of features) {
          const anchor = anchors.get(feature.id)
          if (!anchor) continue
          const dot = normal.copy(anchor).normalize().dot(localCameraDirection)
          if (dot > bestDot) {
            bestDot = dot
            nextId = feature.id
          }
        }
      }
    }

    if (nextId !== visibleIdRef.current) {
      visibleIdRef.current = nextId
      setVisibleId(nextId)
    }
  })

  const visibleFeature = features.find((feature) => feature.id === visibleId)
  const visibleAnchor = visibleFeature ? anchors.get(visibleFeature.id) : null

  return (
    <group ref={root}>
      {visibleFeature && visibleAnchor && (
        <Html position={visibleAnchor} zIndexRange={[20, 10]}>
          <div
            className={`surface-callout surface-callout--${bodyId}`}
          >
            <svg
              className="surface-callout__leader"
              viewBox="0 0 30 19"
              aria-hidden="true"
            >
              <path d="M 0 18 L 17 1 H 29" />
            </svg>
            <button
              type="button"
              className="surface-name-label"
              onClick={(event) => {
                event.stopPropagation()
                inspect(visibleFeature.id, bodyId)
              }}
            >
              {visibleFeature.name}
            </button>
          </div>
        </Html>
      )}
    </group>
  )
}
