import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { generateAsteroidField } from '../../data/asteroidBelt'
import { auToUnits, explorationDistanceForAu } from '../../data/constants'
import { useExplorerStore } from '../../store/useExplorerStore'

const J2000_MS = Date.parse('2000-01-01T12:00:00Z')
const PARTICLES = generateAsteroidField()

const DUMMY = new THREE.Object3D()

export function AsteroidBelt() {
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const focus = useExplorerStore((state) => state.focus)
  const distanceMode = useExplorerStore((state) => state.distanceMode)
  const simulationTimeMs = useExplorerStore((state) => state.simulationTimeMs)
  const visible = focus === 'system' || focus === 'sun' || focus === 'mars' || focus === 'jupiter'

  const geometry = useMemo(() => new THREE.IcosahedronGeometry(0.0011, 0), [])
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#8f8578', roughness: 1, metalness: 0.05 }),
    [],
  )

  useMemo(() => {
    const mesh = meshRef.current
    if (!mesh) return
    const daysSinceEpoch = (simulationTimeMs - J2000_MS) / 86_400_000

    for (let index = 0; index < PARTICLES.length; index += 1) {
      const particle = PARTICLES[index]
      const angle = particle.initialAngleRad + particle.meanMotionRadPerDay * daysSinceEpoch
      const distanceUnits =
        distanceMode === 'physical' ? auToUnits(particle.radiusAu) : explorationDistanceForAu(particle.radiusAu)

      const x = distanceUnits * Math.cos(angle)
      const z = -distanceUnits * Math.sin(angle)
      const y = distanceUnits * Math.sin(particle.inclinationRad) * Math.sin(angle - particle.ascendingNodeRad)

      DUMMY.position.set(x, y, z)
      DUMMY.rotation.set(particle.initialAngleRad, particle.ascendingNodeRad, particle.inclinationRad)
      DUMMY.scale.setScalar(particle.scale)
      DUMMY.updateMatrix()
      mesh.setMatrixAt(index, DUMMY.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulationTimeMs, distanceMode, visible])

  useFrame(() => {
    if (meshRef.current) meshRef.current.visible = visible
  })

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, PARTICLES.length]}
      frustumCulled={false}
    />
  )
}
