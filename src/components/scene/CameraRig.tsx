import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { calculateSceneEphemeris } from '../../astronomy/ephemeris'
import {
  EARTH_RADIUS_KM,
  MOON_RADIUS_UNITS,
  SUN_RADIUS_UNITS,
  findEntity,
} from '../../data/catalog'
import { latLonToCartesian } from '../../data/coordinates'
import {
  useExplorerStore,
  type DistanceMode,
  type FocusTarget,
} from '../../store/useExplorerStore'
import { EXPLORATION_SUN_RADIUS } from './SunBody'

interface CameraGoal {
  position: THREE.Vector3
  target: THREE.Vector3
  systemRadius: number
}

function configureCameraClipping(camera: THREE.Camera, distanceMode: DistanceMode) {
  const perspective = camera as THREE.PerspectiveCamera
  perspective.near = distanceMode === 'physical' ? 0.001 : 0.01
  perspective.far = distanceMode === 'physical' ? 100_000 : 400
  perspective.updateProjectionMatrix()
}

function buildCameraGoal(
  focus: FocusTarget,
  distanceMode: DistanceMode,
  selectedId: string | null,
  portrait: boolean,
): CameraGoal {
  const ephemeris = calculateSceneEphemeris(new Date(), distanceMode)
  const sunRadius =
    distanceMode === 'physical' ? SUN_RADIUS_UNITS : EXPLORATION_SUN_RADIUS
  const selected = findEntity(selectedId)
  const bodyCenter =
    selected?.bodyId === 'moon'
      ? ephemeris.moonPosition
      : selected?.bodyId === 'sun'
        ? ephemeris.sunPosition
        : new THREE.Vector3()
  const bodyQuaternion =
    selected?.bodyId === 'moon'
      ? ephemeris.moonQuaternion
      : selected?.bodyId === 'sun'
        ? ephemeris.sunQuaternion
        : ephemeris.earthQuaternion

  if (selected?.coordinates && (focus === 'earth' || focus === 'moon')) {
    const radius = selected.bodyId === 'earth' ? 1 : MOON_RADIUS_UNITS
    const outward = latLonToCartesian(
      selected.coordinates.latitude,
      selected.coordinates.longitude,
      radius,
    )
      .applyQuaternion(bodyQuaternion)
      .normalize()

    return {
      target: bodyCenter.clone().addScaledVector(outward, radius * 0.72),
      position: bodyCenter
        .clone()
        .addScaledVector(outward, radius * 2.65)
        .add(new THREE.Vector3(0, radius * 0.3, radius * 0.5)),
      systemRadius: 8,
    }
  }

  if (focus === 'earth') {
    return {
      target: new THREE.Vector3(),
      position: new THREE.Vector3(0, 0.28, 3.15),
      systemRadius: 8,
    }
  }

  if (focus === 'moon') {
    return {
      target: ephemeris.moonPosition.clone(),
      position: ephemeris.moonPosition
        .clone()
        .add(new THREE.Vector3(0, MOON_RADIUS_UNITS * 0.2, MOON_RADIUS_UNITS * 3.2)),
      systemRadius: 8,
    }
  }

  if (focus === 'sun') {
    return {
      target: ephemeris.sunPosition.clone(),
      position: ephemeris.sunPosition
        .clone()
        .add(new THREE.Vector3(0, sunRadius * 0.2, sunRadius * 3.25)),
      systemRadius: Math.max(8, sunRadius),
    }
  }

  const box = new THREE.Box3()
  const expandBody = (center: THREE.Vector3, radius: number) => {
    box.expandByPoint(center.clone().addScalar(radius))
    box.expandByPoint(center.clone().addScalar(-radius))
  }
  expandBody(new THREE.Vector3(), 1)
  expandBody(ephemeris.moonPosition, MOON_RADIUS_UNITS)
  expandBody(ephemeris.sunPosition, sunRadius)
  const bounds = box.getBoundingSphere(new THREE.Sphere())
  const radius = Math.max(bounds.radius, 4.2)
  const viewOffset = new THREE.Vector3(0.1, 0.24, 1).normalize()

  return {
    target: bounds.center,
    position: bounds.center
      .clone()
      .addScaledVector(viewOffset, radius * (portrait ? 3.7 : 2.65)),
    systemRadius: radius,
  }
}

export function CameraRig() {
  const controls = useRef<React.ComponentRef<typeof OrbitControls>>(null)
  const animating = useRef(true)
  const initialized = useRef(false)
  const lastScaleUpdate = useRef(0)
  const { camera, size } = useThree()
  const focus = useExplorerStore((state) => state.focus)
  const distanceMode = useExplorerStore((state) => state.distanceMode)
  const selectedId = useExplorerStore((state) => state.selectedId)
  const setViewScaleKmPerPixel = useExplorerStore(
    (state) => state.setViewScaleKmPerPixel,
  )
  const setCameraRangeKm = useExplorerStore((state) => state.setCameraRangeKm)
  const portrait = size.width / size.height < 0.78
  const goal = useMemo(
    () => buildCameraGoal(focus, distanceMode, selectedId, portrait),
    [distanceMode, focus, portrait, selectedId],
  )

  useLayoutEffect(() => {
    configureCameraClipping(camera, distanceMode)
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
  }, [camera, distanceMode, goal])

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

  const sunRadius =
    distanceMode === 'physical' ? SUN_RADIUS_UNITS : EXPLORATION_SUN_RADIUS
  const bodyRadius =
    focus === 'moon' ? MOON_RADIUS_UNITS : focus === 'sun' ? sunRadius : 1
  const minDistance = focus === 'system' ? 1.15 : bodyRadius * 1.12
  const maxDistance = focus === 'system' ? goal.systemRadius * 8 : bodyRadius * 10

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.06}
      rotateSpeed={0.55}
      zoomSpeed={0.8}
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
