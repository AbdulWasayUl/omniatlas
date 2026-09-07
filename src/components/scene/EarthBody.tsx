import { useTexture } from '@react-three/drei'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { SURFACE_FEATURES } from '../../data/catalog'
import { useExplorerStore } from '../../store/useExplorerStore'
import { EarthDetailLayer } from './EarthDetailLayer'
import { FeatureMarkers } from './FeatureMarkers'

const atmosphereVertexShader = `
  varying vec3 vNormal;
  varying vec3 vViewDirection;

  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewDirection = normalize(-viewPosition.xyz);
    gl_Position = projectionMatrix * viewPosition;
  }
`

const atmosphereFragmentShader = `
  varying vec3 vNormal;
  varying vec3 vViewDirection;

  void main() {
    float fresnel = pow(1.0 - max(dot(vNormal, vViewDirection), 0.0), 3.2);
    vec3 dayBlue = vec3(0.18, 0.52, 1.0);
    gl_FragColor = vec4(dayBlue, fresnel * 0.48);
  }
`

export function EarthBody() {
  const [loadedSurface, loadedClouds] = useTexture([
    '/textures/earth/blue-marble-december.jpg',
    '/textures/earth/clouds.jpg',
  ])
  const surface = useMemo(() => {
    const texture = loadedSurface.clone()
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 8
    texture.needsUpdate = true
    return texture
  }, [loadedSurface])
  const clouds = useMemo(() => {
    const texture = loadedClouds.clone()
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 8
    texture.needsUpdate = true
    return texture
  }, [loadedClouds])
  const select = useExplorerStore((state) => state.select)
  const setFocus = useExplorerStore((state) => state.setFocus)
  const earthFeatures = SURFACE_FEATURES.filter((feature) => feature.bodyId === 'earth')

  useEffect(() => {
    return () => {
      surface.dispose()
      clouds.dispose()
    }
  }, [surface, clouds])

  return (
    <group>
      <mesh
        onClick={(event) => {
          event.stopPropagation()
          select('earth')
        }}
        onDoubleClick={(event) => {
          event.stopPropagation()
          setFocus('earth')
          select('earth')
        }}
        onPointerEnter={() => {
          document.body.style.cursor = 'pointer'
        }}
        onPointerLeave={() => {
          document.body.style.cursor = 'default'
        }}
      >
        <sphereGeometry args={[1, 128, 96]} />
        <meshStandardMaterial
          map={surface}
          roughness={0.78}
          metalness={0}
          envMapIntensity={0.15}
        />
      </mesh>

      <mesh scale={1.008} renderOrder={2}>
        <sphereGeometry args={[1, 96, 64]} />
        <meshStandardMaterial
          color="#ffffff"
          alphaMap={clouds}
          transparent
          opacity={0.48}
          roughness={1}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      <mesh scale={1.038} renderOrder={3}>
        <sphereGeometry args={[1, 96, 64]} />
        <shaderMaterial
          vertexShader={atmosphereVertexShader}
          fragmentShader={atmosphereFragmentShader}
          transparent
          blending={THREE.AdditiveBlending}
          side={THREE.BackSide}
          depthWrite={false}
        />
      </mesh>

      <FeatureMarkers bodyId="earth" radius={1} features={earthFeatures} />
      <EarthDetailLayer />
    </group>
  )
}
