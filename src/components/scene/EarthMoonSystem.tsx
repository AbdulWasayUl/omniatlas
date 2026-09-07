import { Html, Line, Stars } from '@react-three/drei'
import { useMemo } from 'react'
import * as THREE from 'three'
import { calculateSceneEphemeris } from '../../astronomy/ephemeris'
import { SUN_RADIUS_UNITS } from '../../data/catalog'
import { useExplorerStore } from '../../store/useExplorerStore'
import { EarthBody } from './EarthBody'
import { MoonBody } from './MoonBody'
import { SunBody } from './SunBody'
import { EXPLORATION_SUN_RADIUS } from './SunBody'

export function EarthMoonSystem() {
  const distanceMode = useExplorerStore((state) => state.distanceMode)
  const simulationTimeMs = useExplorerStore((state) => state.simulationTimeMs)
  const ephemeris = useMemo(
    () => calculateSceneEphemeris(new Date(simulationTimeMs), distanceMode),
    [distanceMode, simulationTimeMs],
  )
  const lightPosition = useMemo(
    () => ephemeris.sunDirection.clone().multiplyScalar(100),
    [ephemeris.sunDirection],
  )
  const physical = distanceMode === 'physical'
  const focus = useExplorerStore((state) => state.focus)
  const setFocus = useExplorerStore((state) => state.setFocus)
  const sunRadius = physical ? SUN_RADIUS_UNITS : EXPLORATION_SUN_RADIUS
  const starRadius = physical ? ephemeris.sunPosition.length() * 1.8 : 140

  return (
    <>
      <color attach="background" args={['#020305']} />
      {!physical && <fog attach="fog" args={['#020305', 150, 330]} />}
      <Stars
        radius={starRadius}
        depth={physical ? starRadius * 0.35 : 55}
        count={3000}
        factor={2.4}
        saturation={0.05}
        fade
        speed={0}
      />

      <ambientLight intensity={0.13} color="#7d91aa" />
      <directionalLight position={lightPosition} intensity={3.25} color="#fff1d9" />

      <group quaternion={ephemeris.earthQuaternion}>
        <EarthBody />
      </group>

      <group position={ephemeris.moonPosition} quaternion={ephemeris.moonQuaternion}>
        <MoonBody />
      </group>

      <group position={ephemeris.sunPosition} quaternion={ephemeris.sunQuaternion}>
        <SunBody radius={sunRadius} />
      </group>

      {physical && focus === 'system' && (
        <>
          {[
            { id: 'earth' as const, label: 'Earth', position: new THREE.Vector3() },
            { id: 'moon' as const, label: 'Moon', position: ephemeris.moonPosition },
            { id: 'sun' as const, label: 'Sun', position: ephemeris.sunPosition },
          ].map((body) => (
            <group key={body.id} position={body.position}>
              <Html center zIndexRange={[6, 2]}>
                <button
                  type="button"
                  className="physical-body-label"
                  onClick={() => setFocus(body.id)}
                >
                  <i aria-hidden="true" />
                  {body.label}
                </button>
              </Html>
            </group>
          ))}
        </>
      )}

      <Line
        points={[new THREE.Vector3(), ephemeris.moonPosition]}
        color="#75838b"
        lineWidth={0.5}
        transparent
        opacity={0.18}
        depthWrite={false}
      />
      <Line
        points={[new THREE.Vector3(), ephemeris.sunPosition]}
        color="#d18a45"
        lineWidth={0.45}
        transparent
        opacity={0.1}
        depthWrite={false}
      />
    </>
  )
}
