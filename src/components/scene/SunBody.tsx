import { useTexture } from '@react-three/drei'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useExplorerStore } from '../../store/useExplorerStore'

const glowVertexShader = `
  varying vec3 vNormal;
  varying vec3 vViewDirection;
  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewDirection = normalize(-viewPosition.xyz);
    gl_Position = projectionMatrix * viewPosition;
  }
`

const glowFragmentShader = `
  varying vec3 vNormal;
  varying vec3 vViewDirection;
  void main() {
    float rim = pow(1.0 - max(dot(vNormal, vViewDirection), 0.0), 2.1);
    gl_FragColor = vec4(1.0, 0.35, 0.06, rim * 0.34);
  }
`

interface SunBodyProps {
  radius: number
}

export function SunBody({ radius }: SunBodyProps) {
  const select = useExplorerStore((state) => state.select)
  const focusOn = useExplorerStore((state) => state.focusOn)
  const glowScale = 1 + Math.min(0.18, 0.13 / radius)

  const loaded = useTexture('/textures/planets/sun.jpg')
  const surface = useMemo(() => {
    const texture = loaded.clone()
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 8
    texture.needsUpdate = true
    return texture
  }, [loaded])
  useEffect(() => () => surface.dispose(), [surface])

  return (
    <group>
      <mesh
        onClick={(event) => {
          event.stopPropagation()
          select('sun')
          focusOn('sun')
        }}
        onPointerEnter={() => {
          document.body.style.cursor = 'pointer'
        }}
        onPointerLeave={() => {
          document.body.style.cursor = 'default'
        }}
      >
        <sphereGeometry args={[radius, 96, 64]} />
        <meshBasicMaterial map={surface} toneMapped={false} />
      </mesh>
      <mesh scale={glowScale} renderOrder={4}>
        <sphereGeometry args={[radius, 64, 48]} />
        <shaderMaterial
          vertexShader={glowVertexShader}
          fragmentShader={glowFragmentShader}
          transparent
          blending={THREE.AdditiveBlending}
          side={THREE.BackSide}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  )
}
