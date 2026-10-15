import * as THREE from 'three'
import type { AtlasModule, Engine, FrameContext } from '../../core/Engine'
import { PC_M, vec3d, worldToSceneBasis } from '../../core/world'

/**
 * The stellar layer: 329,860 real stars from AT-HYG v4.0.
 *
 * Three decisions make this work in a browser.
 *
 * **Instanced quads, not `gl.POINTS`.** WebGL implementations clip points on their
 * centre, so a large point whose centre leaves the frustum vanishes abruptly at the
 * screen edge; and `ALIASED_POINT_SIZE_RANGE` caps at 64 on Apple silicon, which is
 * below what a bright star needs. One shared four-vertex quad plus per-star instance
 * attributes costs one draw call per tier and has neither problem.
 *
 * **Brightness is computed from absolute magnitude, per frame, in the shader.** This
 * is the detail that makes interstellar travel feel real. If you ship apparent
 * magnitude as seen from Earth, then flying to Alpha Centauri leaves Sirius exactly as
 * bright as it looks from here, the parallax never resolves into depth, and the whole
 * illusion collapses. Deriving apparent magnitude from the true camera-to-star distance
 * means stars brighten as you approach them and the constellations visibly come apart.
 *
 * **Radius and intensity are separate.** A bright star is drawn slightly larger *and*
 * much brighter, with the brightness written additively into the HDR buffer so the tone
 * mapper produces the glare rather than a painted-on halo.
 */

const LAYER = 'stellar' as const
const DATA = '/data/stars'

interface TierManifest {
  recordCount: number
  fields: { name: string; dtype: string; count: number; byteOffset: number }[]
}

interface StarTier {
  mesh: THREE.Mesh
  count: number
}

interface L2Index {
  recordCount: number
  chunks: { pix: number; count: number; shells: [shell: number, start: number, count: number][] }[]
}

/**
 * AT-HYG's `ci` column is the Tycho BT-VT colour for most rows, not Johnson B-V, even
 * though it is often described as the latter. The dataset manifest carries the measured
 * offset curve against HYG v4.1: about +0.00 at B-V 0.0, +0.08 at 0.75, +0.18 at 1.05,
 * +0.26 at 1.35 and +0.50 beyond 2.0. Feeding BT-VT straight into a B-V temperature fit
 * therefore renders every K and M star noticeably too red and too cool.
 *
 * This piecewise-linear inverse recovers Johnson B-V from the stored value. It is only
 * as good as the tabulated curve, which is plenty: the whole quantity is being turned
 * into the colour of a few pixels.
 */
const BT_VT_TO_BV: [stored: number, johnson: number][] = [
  [0.0, 0.0],
  [0.47, 0.45],
  [0.83, 0.75],
  [1.23, 1.05],
  [1.61, 1.35],
  [2.07, 1.75],
  [2.5, 2.0],
]

function tychoToJohnsonBv(stored: number): number {
  if (stored <= BT_VT_TO_BV[0][0]) return stored
  for (let i = 1; i < BT_VT_TO_BV.length; i++) {
    const [x1, y1] = BT_VT_TO_BV[i]
    if (stored <= x1) {
      const [x0, y0] = BT_VT_TO_BV[i - 1]
      return y0 + ((stored - x0) / (x1 - x0)) * (y1 - y0)
    }
  }
  // Beyond the tabulated range the offset saturates near +0.5.
  return stored - 0.5
}

/**
 * Ballesteros (2012): a single-parameter fit from Johnson B-V to effective temperature.
 * Accurate to a few percent across the main sequence, far beyond what a few pixels of
 * star colour can show.
 */
function colourIndexToKelvin(bv: number): number {
  const x = 0.92 * bv
  return 4600 * (1 / (x + 1.7) + 1 / (x + 0.62))
}

/**
 * Blackbody temperature to linear sRGB, normalised to equal luminance so that colour
 * carries temperature and brightness carries magnitude. Letting a hot star also be a
 * bright pixel double-counts the same fact and washes the sky blue.
 */
function kelvinToLinearRgb(kelvin: number): [number, number, number] {
  const t = Math.min(Math.max(kelvin, 1000), 40_000) / 100
  let r: number
  let g: number
  let b: number

  if (t <= 66) {
    r = 255
    g = 99.4708025861 * Math.log(t) - 161.1195681661
  } else {
    r = 329.698727446 * (t - 60) ** -0.1332047592
    g = 288.1221695283 * (t - 60) ** -0.0755148492
  }
  if (t >= 66) b = 255
  else if (t <= 19) b = 0
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307

  const clamp = (v: number) => Math.min(Math.max(v, 0), 255) / 255
  r = clamp(r)
  g = clamp(g)
  b = clamp(b)

  // Normalise to constant luminance (Rec. 709 coefficients).
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
  if (luma > 0) {
    r /= luma
    g /= luma
    b /= luma
  }
  const peak = Math.max(r, g, b, 1)
  return [r / peak, g / peak, b / peak]
}

const STAR_VERTEX = /* glsl */ `
  attribute vec3 starPosition;   // parsecs, layer-local
  attribute vec3 starColor;      // linear sRGB, luminance-normalised
  attribute float absMag;        // absolute magnitude

  uniform float uPixelHeight;    // viewport height in device pixels
  uniform float uTanHalfFov;
  uniform float uMagLimit;       // faintest apparent magnitude drawn
  uniform float uMinRadiusPx;
  uniform float uMaxRadiusPx;
  uniform float uGain;

  varying vec3 vColor;
  varying float vIntensity;
  varying vec2 vQuad;

  void main() {
    vQuad = position.xy;

    vec4 viewPosition = modelViewMatrix * vec4(starPosition, 1.0);
    float distancePc = max(length(viewPosition.xyz), 1e-4);

    // Apparent magnitude from the TRUE distance to the camera, recomputed every frame.
    float apparent = absMag + 5.0 * (log(distancePc) / 2.302585092994046) - 5.0;

    float headroom = uMagLimit - apparent;
    if (headroom < 0.0) {
      // Fainter than the limit: collapse the quad so it rasterises nothing.
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    // Radius grows slowly with brightness; intensity carries the rest. Six magnitudes
    // is a 250x flux ratio, which no sane pixel radius can represent.
    float radiusPx = clamp(uMinRadiusPx + 0.62 * headroom, uMinRadiusPx, uMaxRadiusPx);
    vIntensity = uGain * pow(2.512, min(headroom, 9.0)) * 0.032;
    vColor = starColor;

    // Offset in clip space so the quad keeps a constant pixel size at any depth.
    vec4 clip = projectionMatrix * viewPosition;
    float pixelScale = 2.0 * radiusPx / uPixelHeight;
    clip.xy += position.xy * pixelScale * clip.w;
    gl_Position = clip;
  }
`

const STAR_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vIntensity;
  varying vec2 vQuad;

  void main() {
    // A soft Gaussian-ish core. A hard disc reads as a dot of paint; the falloff is
    // what makes a field of these read as stars.
    float r2 = dot(vQuad, vQuad);
    if (r2 > 1.0) discard;
    float falloff = exp(-4.2 * r2);
    gl_FragColor = vec4(vColor * vIntensity * falloff, falloff);
  }
`

export class StarsModule implements AtlasModule {
  id = 'stars'

  private engine!: Engine
  private readonly tiers: StarTier[] = []
  private readonly materials: THREE.ShaderMaterial[] = []
  private constellations: THREE.LineSegments | null = null
  private quad!: THREE.BufferGeometry
  /** Global index space: L0 then L1, matching the build script's manifest. */
  private globalPositions: Float32Array | null = null

  async init(engine: Engine): Promise<void> {
    this.engine = engine
    const layer = engine.layer(LAYER)

    this.quad = new THREE.BufferGeometry()
    this.quad.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    )
    this.quad.setIndex([0, 1, 2, 0, 2, 3])

    // L0 is the naked-eye sky at 128 KB and loads before anything else, so the first
    // frame already has a real sky rather than a black void or a random point cloud.
    const l0 = await this.loadTier('l0')
    if (l0) layer.scene.add(l0.mesh)

    // The deeper tier streams in behind it; the join is invisible because both use the
    // same magnitude-driven shader.
    void this.loadTier('l1').then(async (tier) => {
      if (!tier || engine.isDisposed) return
      layer.scene.add(tier.mesh)
      await this.loadConstellations()
      // L2 last, and only once the sky is already usable: it is 2.9 MB across 192
      // files and nobody should wait on it to see a star.
      await this.loadDeepTier()
    })
  }

  private async loadTier(name: 'l0' | 'l1'): Promise<StarTier | null> {
    const [manifest, buffer] = await Promise.all([
      fetch(`${DATA}/${name}.json`).then((r) => (r.ok ? (r.json() as Promise<TierManifest>) : null)),
      fetch(`${DATA}/${name}.bin`).then((r) => (r.ok ? r.arrayBuffer() : null)),
    ])
    if (!manifest || !buffer) {
      console.warn(`[omniatlas] star tier ${name} unavailable`)
      return null
    }

    const count = manifest.recordCount
    const field = (n: string) => manifest.fields.find((f) => f.name === n)!
    const x = new Float32Array(buffer, field('x').byteOffset, count)
    const y = new Float32Array(buffer, field('y').byteOffset, count)
    const z = new Float32Array(buffer, field('z').byteOffset, count)
    const magu = new Uint8Array(buffer, field('magu').byteOffset, count)
    const ciu = new Uint8Array(buffer, field('ciu').byteOffset, count)

    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const absMag = new Float32Array(count)
    const scratch = vec3d()
    let sentinels = 0

    // A small colour cache: there are only 256 possible quantised colour indices, so
    // the blackbody conversion runs 256 times rather than 330,000 times.
    const colourCache = new Map<number, [number, number, number]>()

    for (let i = 0; i < count; i++) {
      // AT-HYG uses a parallax of exactly 0.01 mas — a distance of exactly 100 kpc — as
      // its "no usable parallax" sentinel. Those rows are not measurements, and drawing
      // them would scatter 89 phantom stars through the galactic halo. Park them behind
      // the camera's reach instead of inventing a position for them.
      const distanceRaw = Math.hypot(x[i], y[i], z[i])
      if (Math.abs(distanceRaw - 100_000) < 1) {
        sentinels++
        absMag[i] = 99 // fainter than any magnitude limit, so the shader discards it
        continue
      }

      // Catalogue positions are ICRS parsecs, Z-up; the layer renders Y-up.
      scratch.x = x[i]
      scratch.y = y[i]
      scratch.z = z[i]
      worldToSceneBasis(scratch, scratch)
      positions[i * 3] = scratch.x
      positions[i * 3 + 1] = scratch.y
      positions[i * 3 + 2] = scratch.z

      const distancePc = Math.max(Math.hypot(x[i], y[i], z[i]), 1e-3)
      const apparent = magu[i] / 16 - 2
      absMag[i] = apparent - 5 * (Math.log10(distancePc) - 1)

      let rgb = colourCache.get(ciu[i])
      if (!rgb) {
        rgb = kelvinToLinearRgb(colourIndexToKelvin(tychoToJohnsonBv(ciu[i] / 40 - 0.5)))
        colourCache.set(ciu[i], rgb)
      }
      colors[i * 3] = rgb[0]
      colors[i * 3 + 1] = rgb[1]
      colors[i * 3 + 2] = rgb[2]
    }

    if (sentinels > 0) {
      console.info(`[omniatlas] ${name}: skipped ${sentinels} stars with AT-HYG's no-parallax sentinel distance`)
    }

    if (name === 'l0') {
      this.globalPositions = positions
    } else if (this.globalPositions) {
      const merged = new Float32Array(this.globalPositions.length + positions.length)
      merged.set(this.globalPositions, 0)
      merged.set(positions, this.globalPositions.length)
      this.globalPositions = merged
    }

    const geometry = new THREE.InstancedBufferGeometry()
    geometry.index = this.quad.index
    geometry.setAttribute('position', this.quad.getAttribute('position'))
    geometry.setAttribute('starPosition', new THREE.InstancedBufferAttribute(positions, 3))
    geometry.setAttribute('starColor', new THREE.InstancedBufferAttribute(colors, 3))
    geometry.setAttribute('absMag', new THREE.InstancedBufferAttribute(absMag, 1))
    geometry.instanceCount = count

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelHeight: { value: 1080 },
        uTanHalfFov: { value: 0.46 },
        uMagLimit: { value: 6.5 },
        uMinRadiusPx: { value: 0.7 },
        uMaxRadiusPx: { value: 18 },
        uGain: { value: 1 },
      },
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    })
    this.materials.push(material)

    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = -10
    mesh.name = `stars:${name}`

    const tier: StarTier = { mesh, count }
    this.tiers.push(tier)
    return tier
  }

  /**
   * The deep tier: 282,103 more stars in 192 HEALPix chunks.
   *
   * Two things make this different from L0 and L1. Positions are int16 quantised per
   * OCTAVE DISTANCE SHELL within each chunk — shell k holds stars between 2^(k-1) and
   * 2^k parsecs and scales by 2^k / 32767 — so a single chunk needs several different
   * dequantisation factors applied to different runs of its records. And the chunks
   * carry no global index, being disjoint from the tiers the constellation figures
   * reference, so nothing here can disturb those.
   *
   * All 192 are merged into one instanced mesh rather than 192 of them: the whole set
   * is under 3 MB, and one draw call for a third of a million stars is the entire
   * point of the instanced-quad approach.
   */
  private async loadDeepTier(): Promise<void> {
    const index = await fetch(`${DATA}/l2/index.json`)
      .then((r) => (r.ok ? (r.json() as Promise<L2Index>) : null))
      .catch(() => null)
    if (!index || this.engine.isDisposed) return

    const total = index.recordCount
    const positions = new Float32Array(total * 3)
    const colors = new Float32Array(total * 3)
    const absMag = new Float32Array(total)
    const colourCache = new Map<number, [number, number, number]>()
    const scratch = vec3d()
    let written = 0

    // A small concurrency window: enough to keep the connection busy, not so much
    // that 192 parallel fetches stall the first frames of everything else.
    const QUEUE = 8
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < index.chunks.length) {
        const chunk = index.chunks[cursor++]
        if (this.engine.isDisposed) return
        const buffer = await fetch(`${DATA}/l2/${chunk.pix}.bin`)
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .catch(() => null)
        if (!buffer || this.engine.isDisposed) continue

        const n = chunk.count
        const x = new Int16Array(buffer, 0, n)
        const y = new Int16Array(buffer, 2 * n, n)
        const z = new Int16Array(buffer, 4 * n, n)
        const magu = new Uint8Array(buffer, 6 * n, n)
        const ciu = new Uint8Array(buffer, 7 * n, n)

        for (const [shell, start, count] of chunk.shells) {
          // scale_k = 2^shell / 32767, per the chunk index's own quantization rule.
          const scale = 2 ** shell / 32767
          for (let i = start; i < start + count; i++) {
            scratch.x = x[i] * scale
            scratch.y = y[i] * scale
            scratch.z = z[i] * scale
            const distancePc = Math.max(Math.hypot(scratch.x, scratch.y, scratch.z), 1e-3)

            worldToSceneBasis(scratch, scratch)
            const o = written * 3
            positions[o] = scratch.x
            positions[o + 1] = scratch.y
            positions[o + 2] = scratch.z

            const apparent = magu[i] / 16 - 2
            absMag[written] = apparent - 5 * (Math.log10(distancePc) - 1)

            let rgb = colourCache.get(ciu[i])
            if (!rgb) {
              rgb = kelvinToLinearRgb(colourIndexToKelvin(tychoToJohnsonBv(ciu[i] / 40 - 0.5)))
              colourCache.set(ciu[i], rgb)
            }
            colors[o] = rgb[0]
            colors[o + 1] = rgb[1]
            colors[o + 2] = rgb[2]
            written++
          }
        }
      }
    }

    await Promise.all(Array.from({ length: QUEUE }, worker))
    if (this.engine.isDisposed || written === 0) return

    const geometry = new THREE.InstancedBufferGeometry()
    geometry.index = this.quad.index
    geometry.setAttribute('position', this.quad.getAttribute('position'))
    geometry.setAttribute('starPosition', new THREE.InstancedBufferAttribute(positions.subarray(0, written * 3), 3))
    geometry.setAttribute('starColor', new THREE.InstancedBufferAttribute(colors.subarray(0, written * 3), 3))
    geometry.setAttribute('absMag', new THREE.InstancedBufferAttribute(absMag.subarray(0, written), 1))
    geometry.instanceCount = written

    const material = this.materials[0].clone()
    material.uniforms = THREE.UniformsUtils.clone(this.materials[0].uniforms)
    this.materials.push(material)

    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = -10
    mesh.name = 'stars:l2'
    this.tiers.push({ mesh, count: written })
    this.engine.layer(LAYER).scene.add(mesh)
    console.info(`[omniatlas] stars: deep tier resident, ${written.toLocaleString('en-GB')} additional stars`)
  }

  /**
   * Constellation figures, as index pairs into the global star index space.
   *
   * They are drawn with full opacity near the Sun and fade out by about 50 parsecs,
   * so leaving the solar neighbourhood visibly pulls them apart. That dissolution is
   * the point: constellations are an Earth-bound projection, and an atlas that kept
   * them rigid while the camera moved would be teaching something false.
   */
  private async loadConstellations(): Promise<void> {
    if (!this.globalPositions) return
    const buffer = await fetch(`${DATA}/constellations.bin`)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null)
    if (!buffer || this.engine.isDisposed) return

    // Struct-of-arrays, per the dataset manifest: all of `a`, then all of `b`.
    // Reading this as interleaved pairs produces a plausible-looking but entirely
    // wrong web of lines between unrelated stars, which is exactly what it did first.
    const count = buffer.byteLength / 8
    const aIndices = new Uint32Array(buffer, 0, count)
    const bIndices = new Uint32Array(buffer, count * 4, count)
    const maxIndex = this.globalPositions.length / 3
    const vertices: number[] = []
    let skipped = 0
    for (let i = 0; i < count; i++) {
      const a = aIndices[i]
      const b = bIndices[i]
      if (a >= maxIndex || b >= maxIndex) {
        skipped++
        continue
      }
      vertices.push(
        this.globalPositions[a * 3],
        this.globalPositions[a * 3 + 1],
        this.globalPositions[a * 3 + 2],
        this.globalPositions[b * 3],
        this.globalPositions[b * 3 + 1],
        this.globalPositions[b * 3 + 2],
      )
    }
    if (skipped > 0) {
      console.info(`[omniatlas] ${skipped} constellation segments reference stars outside the loaded tiers`)
    }
    if (vertices.length === 0) return

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    const material = new THREE.LineBasicMaterial({
      color: 0x3f5a73,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      depthTest: false,
    })
    this.constellations = new THREE.LineSegments(geometry, material)
    this.constellations.frustumCulled = false
    this.constellations.renderOrder = -9
    this.engine.layer(LAYER).scene.add(this.constellations)
  }

  preRender(ctx: FrameContext): void {
    const layer = this.engine.layer(LAYER)
    const dpr = Math.min(window.devicePixelRatio, 2)
    const pixelHeight = ctx.height * dpr

    // The limiting magnitude follows the field of view the way a telescope's does:
    // narrowing the view concentrates light and reveals fainter stars. It doubles as
    // the single most effective performance dial, since it culls in the vertex shader.
    const fovRef = 50
    const magLimit = 6.2 + 5 * Math.log10(fovRef / Math.max(ctx.fovDegrees, 1)) + 2.4

    for (const material of this.materials) {
      material.uniforms.uPixelHeight.value = pixelHeight
      material.uniforms.uMagLimit.value = magLimit
      material.uniforms.uTanHalfFov.value = Math.tan((ctx.fovDegrees * Math.PI) / 360)
    }

    if (this.constellations) {
      // Distance of the camera from the Sun, in parsecs.
      const distancePc = layer.cameraDistanceMetres / PC_M
      const opacity = 0.42 * (1 - smoothstep(1, 50, distancePc))
      const material = this.constellations.material as THREE.LineBasicMaterial
      material.opacity = opacity
      this.constellations.visible = opacity > 0.01
    }
  }

  dispose(): void {
    for (const tier of this.tiers) {
      tier.mesh.geometry.dispose()
      tier.mesh.removeFromParent()
    }
    this.tiers.length = 0
    for (const material of this.materials) material.dispose()
    this.materials.length = 0
    if (this.constellations) {
      this.constellations.geometry.dispose()
      ;(this.constellations.material as THREE.Material).dispose()
      this.constellations.removeFromParent()
    }
    this.quad?.dispose()
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

export default function createStarsModule(): AtlasModule {
  return new StarsModule()
}
