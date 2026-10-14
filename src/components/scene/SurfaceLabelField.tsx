import { Billboard, Text } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { latLonToCartesian } from '../../data/coordinates'
import { useExplorerStore } from '../../store/useExplorerStore'

export interface SurfaceLabelItem {
  id: string
  name: string
  latitude: number
  longitude: number
  /** Lower numbers are more important and appear first as the camera zooms in. */
  tier: number
  /** 'region' renders centered, uppercase, letter-spaced text with no marker dot
   * (countries, continents). 'point' (default) renders a small dot plus left-anchored
   * text for a discrete place (cities, craters). */
  variant?: 'region' | 'point'
  /** Per-item color override; falls back to the field's `accentColor`. */
  color?: string
}

export interface TierBand {
  /** Show tiers up to `maxTier` once the camera is closer than `minRadii` body-radii away. */
  minRadii: number
  maxTier: number
}

interface SurfaceLabelFieldProps {
  bodyId: string
  radius: number
  items: SurfaceLabelItem[]
  tierBands: TierBand[]
  maxVisible: number
  accentColor: string
  labelScale?: number
  /** Minimum breathing room, in pixels, between two labels' estimated bounding boxes. */
  labelPadding?: number
  /** Target on-screen text height in pixels for the most important (tier 0) label. */
  targetPixelSize?: number
}

const UPDATE_INTERVAL_SECONDS = 0.2
const SCRATCH_WORLD = new THREE.Vector3()
const SCRATCH_CAMERA_LOCAL = new THREE.Vector3()
const SCRATCH_NORMAL = new THREE.Vector3()
const SCRATCH_QUATERNION = new THREE.Quaternion()
const SCRATCH_PROJECTED = new THREE.Vector3()
const SCRATCH_LABEL_WORLD = new THREE.Vector3()

// Rendered-geometry constants, in the same "content units" used by the JSX below —
// kept here too so the declutter pass can estimate each label's actual screen
// footprint (text width included) instead of a uniform circle that neither fits a
// short city name nor a long country name correctly.
const DOT_RADIUS = 0.34
const TEXT_START_X = 1.0
const POINT_FONT_SIZE = 1
const REGION_FONT_SIZE = 1.08
const CHAR_WIDTH_POINT = 0.56
const CHAR_WIDTH_REGION = 0.68
const LINE_HEIGHT_FACTOR = 1.25

function tierThreshold(distanceInRadii: number, bands: TierBand[]): number {
  let best = -1
  for (const band of bands) {
    if (distanceInRadii <= band.minRadii) best = Math.max(best, band.maxTier)
  }
  return best
}

/** More important (lower-tier) labels render larger, like a real map's label hierarchy. */
function sizeForTier(tier: number): number {
  return Math.max(0.58, 1.32 - tier * 0.11)
}

interface ScreenBox {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

/** Estimated on-screen bounding box for one label, in pixels, from character count
 * rather than actual glyph metrics — cheap enough to run on every zoom-level
 * recompute, and accurate enough to stop long country names from overlapping
 * their neighbors the way a fixed-radius circle check could not. */
function estimateLabelBox(item: SurfaceLabelItem, screenX: number, screenY: number, pixelScale: number): ScreenBox {
  const isRegion = item.variant === 'region'
  const fontSizePx = (isRegion ? REGION_FONT_SIZE : POINT_FONT_SIZE) * pixelScale
  const textWidthPx = item.name.length * (isRegion ? CHAR_WIDTH_REGION : CHAR_WIDTH_POINT) * fontSizePx
  const heightPx = fontSizePx * LINE_HEIGHT_FACTOR

  if (isRegion) {
    return {
      xMin: screenX - textWidthPx / 2,
      xMax: screenX + textWidthPx / 2,
      yMin: screenY - heightPx / 2,
      yMax: screenY + heightPx / 2,
    }
  }

  const dotRadiusPx = DOT_RADIUS * pixelScale
  const textStartPx = TEXT_START_X * pixelScale
  return {
    xMin: screenX - dotRadiusPx,
    xMax: screenX + textStartPx + textWidthPx,
    yMin: screenY - heightPx / 2,
    yMax: screenY + heightPx / 2,
  }
}

function boxesOverlap(a: ScreenBox, b: ScreenBox, padding: number): boolean {
  return (
    a.xMin - padding < b.xMax && a.xMax + padding > b.xMin && a.yMin - padding < b.yMax && a.yMax + padding > b.yMin
  )
}

export function SurfaceLabelField({
  bodyId,
  radius,
  items,
  tierBands,
  maxVisible,
  accentColor,
  labelScale = 1,
  labelPadding = 5,
  targetPixelSize = 12,
}: SurfaceLabelFieldProps) {
  const root = useRef<THREE.Group>(null)
  const elapsed = useRef(0)
  const [visibleIds, setVisibleIds] = useState<string[]>([])
  const scaledRefs = useRef(new Map<string, THREE.Group>())
  const focus = useExplorerStore((state) => state.focus)
  const selectedId = useExplorerStore((state) => state.selectedId)
  const inspect = useExplorerStore((state) => state.inspect)
  const active = focus === bodyId

  const anchors = useMemo(
    () => items.map((item) => latLonToCartesian(item.latitude, item.longitude, radius * 1.006)),
    [items, radius],
  )

  useFrame(({ camera, size }, delta) => {
    if (!active || !root.current) {
      if (visibleIds.length) setVisibleIds([])
      return
    }
    elapsed.current += delta
    if (elapsed.current < UPDATE_INTERVAL_SECONDS) return
    elapsed.current = 0

    root.current.getWorldPosition(SCRATCH_WORLD)
    const distanceInRadii = camera.position.distanceTo(SCRATCH_WORLD) / radius
    const maxTier = tierThreshold(distanceInRadii, tierBands)
    if (maxTier < 0) {
      if (visibleIds.length) setVisibleIds([])
      return
    }

    const worldQuaternion = root.current.getWorldQuaternion(SCRATCH_QUATERNION)
    SCRATCH_CAMERA_LOCAL.copy(camera.position).sub(SCRATCH_WORLD).normalize().applyQuaternion(worldQuaternion.clone().invert())

    const selectedIndex = items.findIndex((item) => item.id === selectedId)
    const candidates: number[] = []
    for (let index = 0; index < items.length; index += 1) {
      if (items[index].tier > maxTier && index !== selectedIndex) continue
      const dot = SCRATCH_NORMAL.copy(anchors[index]).normalize().dot(SCRATCH_CAMERA_LOCAL)
      if (dot > 0.1) candidates.push(index)
      if (candidates.length >= 400) break
    }

    if (selectedIndex >= 0 && !candidates.includes(selectedIndex)) candidates.unshift(selectedIndex)

    const accepted: number[] = []
    const acceptedBoxes: ScreenBox[] = []
    for (const index of candidates) {
      if (accepted.length >= maxVisible) break
      SCRATCH_PROJECTED.copy(anchors[index]).applyMatrix4(root.current.matrixWorld).project(camera)
      const screenX = (SCRATCH_PROJECTED.x * 0.5 + 0.5) * size.width
      const screenY = (1 - (SCRATCH_PROJECTED.y * 0.5 + 0.5)) * size.height
      const pixelScale = sizeForTier(items[index].tier) * labelScale * targetPixelSize
      const box = estimateLabelBox(items[index], screenX, screenY, pixelScale)
      const overlapsExisting = acceptedBoxes.some((other) => boxesOverlap(box, other, labelPadding))
      if (overlapsExisting && index !== selectedIndex) continue
      accepted.push(index)
      acceptedBoxes.push(box)
    }

    const nextIds = accepted.map((index) => items[index].id)
    const changed =
      nextIds.length !== visibleIds.length || nextIds.some((id, index) => id !== visibleIds[index])
    if (changed) setVisibleIds(nextIds)
  })

  // Keep each visible label's on-screen size roughly constant as the camera zooms,
  // rather than shrinking to invisibility far away or ballooning up close.
  useFrame(({ camera, size }) => {
    if (!active) return
    const perspective = camera as THREE.PerspectiveCamera
    const pixelToWorld = (2 * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2)) / size.height
    scaledRefs.current.forEach((group, id) => {
      const item = items.find((entry) => entry.id === id)
      const tierSize = item ? sizeForTier(item.tier) : 1
      group.getWorldPosition(SCRATCH_LABEL_WORLD)
      const distance = camera.position.distanceTo(SCRATCH_LABEL_WORLD)
      group.scale.setScalar(distance * pixelToWorld * targetPixelSize * tierSize * labelScale)
    })
  })

  const visibleSet = useMemo(() => new Set(visibleIds), [visibleIds])
  const visibleEntries = useMemo(
    () =>
      items
        .map((item, index) => ({ item, anchor: anchors[index] }))
        .filter(({ item }) => visibleSet.has(item.id)),
    [items, anchors, visibleSet],
  )

  return (
    <group ref={root}>
      {visibleEntries.map(({ item, anchor }) => {
        const isRegion = item.variant === 'region'
        const color = item.color ?? accentColor
        const isSelected = item.id === selectedId
        return (
          <group key={item.id} position={anchor}>
            <group
              ref={(instance) => {
                if (instance) scaledRefs.current.set(item.id, instance)
                else scaledRefs.current.delete(item.id)
              }}
            >
              <Billboard>
                {!isRegion && (
                  <mesh
                    position={[0, 0, 0]}
                    onClick={(event) => {
                      event.stopPropagation()
                      inspect(item.id, bodyId)
                    }}
                  >
                    <circleGeometry args={[DOT_RADIUS, 12]} />
                    <meshBasicMaterial color={color} toneMapped={false} />
                  </mesh>
                )}
                <Text
                  position={isRegion ? [0, 0, 0] : [TEXT_START_X, 0.13, 0]}
                  fontSize={isRegion ? REGION_FONT_SIZE : POINT_FONT_SIZE}
                  letterSpacing={isRegion ? 0.06 : 0}
                  anchorX={isRegion ? 'center' : 'left'}
                  anchorY="middle"
                  fontWeight={isRegion || item.tier <= 1 ? 700 : 500}
                  color={isSelected ? '#ffffff' : color}
                  outlineWidth={0.05}
                  outlineColor="#03060a"
                  outlineOpacity={0.85}
                  onClick={(event) => {
                    event.stopPropagation()
                    inspect(item.id, bodyId)
                  }}
                >
                  {isRegion ? item.name.toUpperCase() : item.name}
                </Text>
              </Billboard>
            </group>
          </group>
        )
      })}
    </group>
  )
}
