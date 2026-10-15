import * as THREE from 'three'

/**
 * A rendered celestial body.
 *
 * Replaces the three near-duplicate components the old scene carried (`PlanetBody`,
 * `MoonBody`, `MoonMesh`). One data-driven renderable covers all of them, and because
 * every body shares a single unit-radius geometry scaled per instance, adding bodies
 * costs a draw call rather than a megabyte of vertices.
 */

export interface SphereBodySpec {
  id: string
  /** Radius in the host layer's render units. */
  radius: number
  /** Equirectangular colour map. */
  textureUrl?: string
  /** Fallback colour when no texture is supplied or it fails to load. */
  color?: string
  /** Emissive bodies (the Sun) skip lighting entirely. */
  emissive?: boolean
  /** Linear emissive strength; values above 1 are what the bloom threshold selects on. */
  emissiveIntensity?: number
  /** Rim-light atmosphere colour. Omit for airless bodies. */
  atmosphereColor?: string
  /** Atmosphere shell radius as a multiple of the body radius. */
  atmosphereScale?: number
  /**
   * Base colour for the parts of `textureUrl` that carry no observation.
   *
   * Several USGS mosaics cover only the hemisphere a flyby actually imaged — Voyager 2
   * saw Triton's southern half and Titania's southern half, and the rest of each map is
   * encoded as pure black. Rendered literally, those bodies are a black ball with a
   * lit crescent. Set this to the body's measured mean albedo colour and the unimaged
   * region is filled flat, with no invented terrain in it.
   */
  unimagedFill?: string
  /** Ring texture (Saturn, Uranus). */
  ringTextureUrl?: string
  ringInnerScale?: number
  ringOuterScale?: number
  /** Segment count override; defaults scale with apparent importance. */
  segments?: number
}

/**
 * Unit spheres, one per segment count, reused by every body in the atlas.
 *
 * Keyed rather than single-slot: bodies are built at 96, 64 and 48 segments, and a
 * single slot disposed itself every time the count changed, leaving every mesh built
 * before the change pointing at a disposed geometry that the renderer then had to
 * re-upload on the next frame that drew it.
 */
const sharedSpheres = new Map<number, THREE.SphereGeometry>()
function unitSphere(segments: number): THREE.SphereGeometry {
  let geometry = sharedSpheres.get(segments)
  if (!geometry) {
    geometry = new THREE.SphereGeometry(1, segments, segments / 2)
    sharedSpheres.set(segments, geometry)
  }
  return geometry
}

/**
 * Replace the no-data region of a partial map with a flat base colour.
 *
 * The test is on the decoded linear luminance, with the threshold well under the
 * darkest real terrain in any of these maps (Phobos' floor sits near 0.02 linear) and
 * above the ringing JPEG leaves along the mosaic edge. The fill carries no detail on
 * purpose: it should read as "not imaged", not as terrain.
 */
function applyUnimagedFill(material: THREE.MeshStandardMaterial, fill: THREE.Color): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uUnimagedFill = { value: fill }
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform vec3 uUnimagedFill;\nvoid main() {')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float imagedLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
        diffuseColor.rgb = mix(uUnimagedFill, diffuseColor.rgb, smoothstep(0.0006, 0.004, imagedLuma));`,
      )
  }
  // Two materials that differ only in this uniform must not share a compiled program.
  material.customProgramCacheKey = () => `unimaged:${fill.getHexString()}`
}

const textureLoader = new THREE.TextureLoader()
const textureCache = new Map<string, THREE.Texture>()

function loadTexture(url: string, colorSpace: THREE.ColorSpace = THREE.SRGBColorSpace): THREE.Texture {
  const hit = textureCache.get(url)
  if (hit) return hit
  const texture = textureLoader.load(url)
  texture.colorSpace = colorSpace
  texture.anisotropy = 8
  textureCache.set(url, texture)
  return texture
}

/**
 * The atmosphere rim.
 *
 * A back-face sphere slightly larger than the body, additively blended, with opacity
 * driven by the view-grazing angle and the sun angle. Forty lines of shader for the
 * single biggest change in how a planet reads — without it, a textured sphere looks
 * like a billiard ball.
 */
function atmosphereMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color },
      uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
      uIntensity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormalView;
      varying vec3 vNormalWorld;
      varying vec3 vViewPosition;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = viewPosition.xyz;
        vNormalView = normalize(normalMatrix * normal);
        vNormalWorld = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uSunDirection;
      uniform float uIntensity;
      varying vec3 vNormalView;
      varying vec3 vNormalWorld;
      varying vec3 vViewPosition;
      void main() {
        vec3 viewDirection = normalize(-vViewPosition);
        // Back faces are rendered, so the normal points away from the camera.
        float grazing = 1.0 - abs(dot(normalize(vNormalView), viewDirection));
        float rim = pow(clamp(grazing, 0.0, 1.0), 3.0);
        // Only the lit limb glows; the night side keeps a thin trace so the planet
        // still reads as round against the void.
        float sunFacing = clamp(dot(normalize(vNormalWorld), normalize(uSunDirection)) + 0.3, 0.0, 1.0);
        float alpha = rim * sunFacing * uIntensity;
        gl_FragColor = vec4(uColor * alpha, alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
  })
}

export class SphereBody {
  readonly group = new THREE.Group()
  readonly mesh: THREE.Mesh
  readonly spec: SphereBodySpec

  private atmosphere: THREE.Mesh | null = null
  private rings: THREE.Mesh | null = null
  private readonly sunDirection = new THREE.Vector3(1, 0, 0)

  constructor(spec: SphereBodySpec) {
    this.spec = spec
    const segments = spec.segments ?? 64

    const material = spec.emissive
      ? new THREE.MeshBasicMaterial({
          color: spec.color ? new THREE.Color(spec.color) : new THREE.Color(1, 1, 1),
          map: spec.textureUrl ? loadTexture(spec.textureUrl) : null,
        })
      : new THREE.MeshStandardMaterial({
          color: spec.textureUrl ? 0xffffff : new THREE.Color(spec.color ?? '#9aa3ab'),
          map: spec.textureUrl ? loadTexture(spec.textureUrl) : null,
          roughness: 0.92,
          metalness: 0,
        })

    if (!spec.emissive && spec.unimagedFill) {
      applyUnimagedFill(
        material as THREE.MeshStandardMaterial,
        new THREE.Color(spec.unimagedFill).convertSRGBToLinear(),
      )
    }

    if (spec.emissive && spec.emissiveIntensity) {
      // Push the Sun above the HDR bloom threshold so its glare is produced by the
      // tone mapper rather than painted on. `toneMapped` stays true deliberately —
      // disabling it is what makes a sun look like a white sticker.
      const basic = material as THREE.MeshBasicMaterial
      basic.color.multiplyScalar(spec.emissiveIntensity)
    }

    this.mesh = new THREE.Mesh(unitSphere(segments), material)
    this.mesh.scale.setScalar(spec.radius)
    this.mesh.name = spec.id
    this.group.add(this.mesh)

    if (spec.atmosphereColor) {
      const shell = new THREE.Mesh(unitSphere(48), atmosphereMaterial(new THREE.Color(spec.atmosphereColor)))
      shell.scale.setScalar(spec.radius * (spec.atmosphereScale ?? 1.025))
      shell.renderOrder = 2
      this.atmosphere = shell
      this.group.add(shell)
    }

    if (spec.ringTextureUrl) {
      const inner = spec.radius * (spec.ringInnerScale ?? 1.24)
      const outer = spec.radius * (spec.ringOuterScale ?? 2.27)
      const geometry = new THREE.RingGeometry(inner, outer, 160, 1)
      // RingGeometry's default UVs are unusable for a radial ring texture: remap so u
      // runs from the inner edge to the outer edge.
      const position = geometry.attributes.position
      const uv = geometry.attributes.uv
      const v = new THREE.Vector3()
      for (let i = 0; i < position.count; i++) {
        v.fromBufferAttribute(position, i)
        const t = (v.length() - inner) / (outer - inner)
        uv.setXY(i, t, 0.5)
      }
      uv.needsUpdate = true

      const ringMaterial = new THREE.MeshBasicMaterial({
        map: loadTexture(spec.ringTextureUrl),
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        opacity: 0.92,
      })
      this.rings = new THREE.Mesh(geometry, ringMaterial)
      // Rings lie in the body's equatorial plane; the body group carries the tilt.
      this.rings.rotation.x = Math.PI / 2
      this.rings.renderOrder = 1
      this.group.add(this.rings)
    }
  }

  /** Point the atmosphere's lighting at the Sun. `direction` is in the layer's space. */
  setSunDirection(direction: THREE.Vector3): void {
    this.sunDirection.copy(direction)
    if (this.atmosphere) {
      const material = this.atmosphere.material as THREE.ShaderMaterial
      material.uniforms.uSunDirection.value.copy(direction)
    }
  }

  /** Rescale when the host layer's unit changes, or when the body is re-anchored. */
  setRadius(radius: number): void {
    this.mesh.scale.setScalar(radius)
    if (this.atmosphere) this.atmosphere.scale.setScalar(radius * (this.spec.atmosphereScale ?? 1.025))
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible
  }

  dispose(): void {
    this.group.removeFromParent()
    const material = this.mesh.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else material.dispose()
    this.atmosphere?.geometry.dispose()
    this.rings?.geometry.dispose()
  }
}
