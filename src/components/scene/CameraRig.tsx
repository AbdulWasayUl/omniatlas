import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import {
  calculateSolarSystemEphemeris,
  isRefinableMoon,
  refineFocusedMoonPosition,
  type SolarSystemEphemeris,
} from '../../astronomy/ephemeris'
import { EARTH_RADIUS_KM, findEntity } from '../../data/catalog'
import { latLonToCartesian } from '../../data/coordinates'
import {
  useExplorerStore,
  type DistanceMode,
  type FocusTarget,
} from '../../store/useExplorerStore'

interface CameraGoal {
  position: THREE.Vector3
  target: THREE.Vector3
  systemRadius: number
}

function configureCameraClipping(camera: THREE.Camera, distanceMode: DistanceMode) {
  const perspective = camera as THREE.PerspectiveCamera
  perspective.near = distanceMode === 'physical' ? 0.0005 : 0.005
  perspective.far = distanceMode === 'physical' ? 2_500_000 : 500
  perspective.updateProjectionMatrix()
}

function systemGoal(ephemeris: SolarSystemEphemeris, portrait: boolean): CameraGoal {
  // Orbit around the Sun's own position (the true center of this heliocentric
  // scene), not a bounding-box centroid that drifts off-center as planets move
  // around it — a moving pivot is what made "just looking around" feel wrong.
  const center = ephemeris.bodies.get('sun')?.position.clone() ?? new THREE.Vector3()
  let radius = 4.2
  ephemeris.bodies.forEach((state) => {
    radius = Math.max(radius, state.position.distanceTo(center) + state.radiusUnits)
  })
  const viewOffset = new THREE.Vector3(0.12, 0.32, 1).normalize()
  return {
    target: center,
    position: center.clone().addScaledVector(viewOffset, radius * (portrait ? 3.4 : 2.35)),
    systemRadius: radius,
  }
}

function buildCameraGoal(
  focus: FocusTarget,
  ephemeris: SolarSystemEphemeris,
  selectedId: string | null,
  portrait: boolean,
): CameraGoal {
  if (focus === 'system') return systemGoal(ephemeris, portrait)

  const state = ephemeris.bodies.get(focus)
  if (!state) return systemGoal(ephemeris, portrait)

  const selected = findEntity(selectedId)
  if (selected?.coordinates && selected.bodyId === focus) {
    const outward = latLonToCartesian(
      selected.coordinates.latitude,
      selected.coordinates.longitude,
      state.radiusUnits,
    )
      .applyQuaternion(state.quaternion)
      .normalize()

    return {
      target: state.position.clone().addScaledVector(outward, state.radiusUnits * 0.72),
      position: state.position
        .clone()
        .addScaledVector(outward, state.radiusUnits * 2.65)
        .add(new THREE.Vector3(0, state.radiusUnits * 0.3, state.radiusUnits * 0.5)),
      systemRadius: Math.max(8, state.radiusUnits * 3),
    }
  }

  return {
    target: state.position.clone(),
    position: state.position
      .clone()
      .add(new THREE.Vector3(0, state.radiusUnits * 0.6, state.radiusUnits * 3.2)),
    systemRadius: Math.max(8, state.radiusUnits * 3),
  }
}

/** Best-available current position for a focus target: frame-accurate for a focused
 * moon (its fast orbital motion needs continuous tracking), otherwise the coarse
 * (~1 Hz) ephemeris snapshot — planets and the Sun barely move within a second. */
function currentFocusPosition(
  focus: FocusTarget,
  date: Date,
  distanceMode: DistanceMode,
  coarse: SolarSystemEphemeris,
): THREE.Vector3 | null {
  if (focus === 'system') return null
  if (isRefinableMoon(focus)) {
    const refined = refineFocusedMoonPosition(focus, date, distanceMode, coarse)
    if (refined) return refined
  }
  return coarse.bodies.get(focus)?.position.clone() ?? null
}

export function CameraRig() {
  const controls = useRef<React.ComponentRef<typeof OrbitControls>>(null)
  const animating = useRef(true)
  const initialized = useRef(false)
  const lastScaleUpdate = useRef(0)
  const lastFocusPosition = useRef<THREE.Vector3 | null>(null)
  const { camera, size } = useThree()
  const focus = useExplorerStore((state) => state.focus)
  const distanceMode = useExplorerStore((state) => state.distanceMode)
  const selectedId = useExplorerStore((state) => state.selectedId)
  const simulationTimeMs = useExplorerStore((state) => state.simulationTimeMs)
  const setViewScaleKmPerPixel = useExplorerStore(
    (state) => state.setViewScaleKmPerPixel,
  )
  const setCameraRangeKm = useExplorerStore((state) => state.setCameraRangeKm)
  const portrait = size.width / size.height < 0.78

  const coarseEphemeris = useMemo(
    () => calculateSolarSystemEphemeris(new Date(simulationTimeMs), distanceMode),
    [simulationTimeMs, distanceMode],
  )
  const goal = useMemo(
    () => buildCameraGoal(focus, coarseEphemeris, selectedId, portrait),
    [focus, selectedId, portrait, coarseEphemeris],
  )

  useLayoutEffect(() => {
    configureCameraClipping(camera, distanceMode)
    lastFocusPosition.current = currentFocusPosition(focus, new Date(), distanceMode, coarseEphemeris)

    if (!initialized.current) {
      camera.position.copy(goal.position)
      controls.current?.target.copy(goal.target)
      controls.current?.update()
      initialized.current = true
      animating.current = false
      return
    }

    animating.current = true
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reducedMotion) {
      camera.position.copy(goal.position)
      controls.current?.target.copy(goal.target)
      controls.current?.update()
      animating.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, distanceMode, focus, selectedId])

  useFrame((state, delta) => {
    if (animating.current && controls.current) {
      const easing = 1 - Math.exp(-delta * 4.4)
      camera.position.lerp(goal.position, easing)
      controls.current.target.lerp(goal.target, easing)

      const arrivalDistance = Math.max(0.007, goal.systemRadius * 0.00001)
      if (
        camera.position.distanceTo(goal.position) < arrivalDistance &&
        controls.current.target.distanceTo(goal.target) < arrivalDistance
      ) {
        camera.position.copy(goal.position)
        controls.current.target.copy(goal.target)
        animating.current = false
      }
    } else if (controls.current) {
      // The fly-to animation is done (or was never needed) — keep following the
      // focused body's own motion so the framing doesn't go stale while it orbits.
      const nowPosition = currentFocusPosition(focus, new Date(), distanceMode, coarseEphemeris)
      if (nowPosition && lastFocusPosition.current) {
        const drift = nowPosition.clone().sub(lastFocusPosition.current)
        if (drift.lengthSq() > 0) {
          camera.position.add(drift)
          controls.current.target.add(drift)
        }
      }
      lastFocusPosition.current = nowPosition
    }
    controls.current?.update()

    if (controls.current && state.clock.elapsedTime - lastScaleUpdate.current > 0.15) {
      lastScaleUpdate.current = state.clock.elapsedTime
      const targetDistance = camera.position.distanceTo(controls.current.target)
      const perspective = camera as THREE.PerspectiveCamera
      const verticalSpan =
        2 * targetDistance * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2)
      setViewScaleKmPerPixel((verticalSpan * EARTH_RADIUS_KM) / state.size.height)
      setCameraRangeKm(targetDistance * EARTH_RADIUS_KM)
    }
  })

  const focusRadiusUnits =
    focus === 'system' ? goal.systemRadius : coarseEphemeris.bodies.get(focus)?.radiusUnits ?? 1
  const minDistance = focus === 'system' ? 1.15 : focusRadiusUnits * 1.12
  const maxDistance = focus === 'system' ? goal.systemRadius * 8 : focusRadiusUnits * 12

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.06}
      rotateSpeed={0.55}
      zoomSpeed={0.8}
      zoomToCursor
      panSpeed={0.55}
      minDistance={minDistance}
      maxDistance={maxDistance}
      minPolarAngle={0.02}
      maxPolarAngle={Math.PI - 0.02}
      onStart={() => {
        animating.current = false
      }}
    />
  )
}
