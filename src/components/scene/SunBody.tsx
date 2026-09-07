import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import * as THREE from 'three'
import { useExplorerStore } from '../../store/useExplorerStore'

const sunVertexShader = `
  varying vec3 vPosition;
  varying vec3 vNormal;

  void main() {
    vPosition = normalize(position);
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const sunFragmentShader = `
  uniform float uTime;
  varying vec3 vPosition;
  varying vec3 vNormal;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
          mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
          mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z
    );
  }

  float fbm(vec3 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int octave = 0; octave < 5; octave++) {
      value += amplitude * noise(p);
      p = p * 2.03 + 0.17;
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    vec3 moving = vPosition * 7.5 + vec3(uTime * 0.018, -uTime * 0.011, 0.0);
    float granulation = fbm(moving);
    float cells = smoothstep(0.32, 0.78, granulation);
    float limb = 0.55 + 0.45 * max(vNormal.z, 0.0);
    vec3 deepOrange = vec3(1.0, 0.19, 0.025);
    vec3 hotYellow = vec3(1.0, 0.78, 0.24);
    vec3 color = mix(deepOrange, hotYellow, cells) * (0.86 + limb * 0.24);
    gl_FragColor = vec4(color, 1.0);
  }
`

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

export const EXPLORATION_SUN_RADIUS = 0.72

interface SunBodyProps {
  radius: number
}

export function SunBody({ radius }: SunBodyProps) {
  const material = useRef<THREE.ShaderMaterial>(null)
  const select = useExplorerStore((state) => state.select)
  const setFocus = useExplorerStore((state) => state.setFocus)
  const glowScale = 1 + Math.min(0.18, 0.13 / radius)

  useFrame((state) => {
    if (material.current) material.current.uniforms.uTime.value = state.clock.elapsedTime
  })

  return (
    <group>
      <mesh
        onClick={(event) => {
          event.stopPropagation()
          select('sun')
        }}
        onDoubleClick={(event) => {
          event.stopPropagation()
          setFocus('sun')
          select('sun')
        }}
        onPointerEnter={() => {
          document.body.style.cursor = 'pointer'
        }}
        onPointerLeave={() => {
          document.body.style.cursor = 'default'
        }}
      >
        <sphereGeometry args={[radius, 96, 64]} />
        <shaderMaterial
          ref={material}
          vertexShader={sunVertexShader}
          fragmentShader={sunFragmentShader}
          uniforms={{ uTime: { value: 0 } }}
          toneMapped={false}
        />
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
