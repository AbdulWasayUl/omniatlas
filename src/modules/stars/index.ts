import * as THREE from 'three'
import type { AtlasModule, Engine, FrameContext } from '../../core/Engine'
import { PC_M, vec3d, worldToSceneBasis } from '../../core/world'
import { assetUrl } from '../../data/assetUrl'
import { forEachSlice } from '../../core/scheduling'

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
  chunks: {
    pix: number
    count: number
    /** Start of this pixel's block within `l2.bin`. Always even; see `loadDeepTier`. */
    byteOffset: number
    shells: [shell: number, start: number, count: number][]
  }[]
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
/** One row of `names.json`: see that file's own `fields` block. */
interface NamedStarRecord {
  i: number
  m: number
  proper?: string
  bayer?: string
  con?: string
  spect?: string
  hip?: number
  gl?: string
}

/**
 * Stars carrying an IAU proper name that belongs to a different star.
 *
 * Two rows of the shipped catalogue are named "Sabik B" and two are named
 * "Kaffaljidhma B". They are not one star listed twice — 10.5 and 7.9 arcseconds
 * apart, at the same distance, a magnitude and a half apart in brightness — they are
 * distinct stars that upstream's name matching attached one component name to by
 * position. Neither pair can both be right.
 *
 * The Gliese identifier settles it, because it carries the component letter the name
 * claims: Sabik's genuine secondary is Gl 656.1B and Kaffaljidhma's is Gl 106.1B, while
 * the other member of each pair has no Gliese number, no Hipparcos number, no HD, no HR
 * and no spectral type — nothing but a position and a magnitude. A star the catalogue
 * identifies in no way has no claim on a name, so it loses the borrowed one and stays
 * what it already was: one of the three hundred thousand drawn in the field, unnamed.
 *
 * This matters beyond tidiness because `oneLabelPerObject` has to collapse two markers
 * with one name in one direction, and it breaks the tie on catalogued radius, which
 * knows nothing about which star owns the name. For Kaffaljidhma it was choosing the
 * star with no identifier at all, so searching "Kaffaljidhma B" flew the camera to the
 * wrong one of the pair.
 *
 * Where no Gliese letter settles it the names are all left alone and the collision is
 * logged, because quietly picking a winner is the failure this function exists to undo.
 */
export function borrowedProperNames(stars: readonly NamedStarRecord[]): Set<number> {
  const byName = new Map<string, NamedStarRecord[]>()
  for (const star of stars) {
    if (!star.proper) continue
    const held = byName.get(star.proper)
    if (held) held.push(star)
    else byName.set(star.proper, [star])
  }

  const borrowed = new Set<number>()
  for (const [proper, members] of byName) {
    if (members.length < 2) continue
    const component = /\s([A-Z])$/.exec(proper)
    const owners = component
      ? members.filter((s) => typeof s.gl === 'string' && s.gl.toUpperCase().endsWith(component[1]))
      : []
    if (owners.length !== 1) {
      console.warn(
        `[omniatlas] stars: ${members.length} stars are named "${proper}" and no Gliese component ` +
          'letter settles which of them owns it; all are left named',
      )
      continue
    }
    for (const star of members) if (star !== owners[0]) borrowed.add(star.i)
  }
  return borrowed
}

interface NamesPayload {
  stars?: NamedStarRecord[]
}

/**
 * Effective temperature from a Morgan-Keenan spectral type.
 *
 * Anchored on the main-sequence calibration at each class letter and interpolated
 * across the subclass digit. Luminosity class is ignored: it moves T_eff by a few
 * hundred kelvin for the classes that matter here, well inside the error already
 * carried by reading a temperature off a letter.
 */
const SPECTRAL_KELVIN: Record<string, [hot: number, cool: number]> = {
  O: [42000, 30000],
  B: [30000, 10000],
  A: [10000, 7500],
  F: [7500, 6000],
  G: [6000, 5200],
  K: [5200, 3700],
  M: [3700, 2400],
  L: [2400, 1300],
  T: [1300, 700],
}

function spectralTypeToKelvin(spect: string | undefined): number {
  // The Sun's temperature is the least-wrong guess for a star with no type at all.
  if (!spect) return 5772
  const match = /^([OBAFGKMLT])\s*(\d(?:\.\d)?)?/.exec(spect.trim().toUpperCase())
  if (!match) return 5772
  const [hot, cool] = SPECTRAL_KELVIN[match[1]]
  const subclass = match[2] === undefined ? 5 : Number(match[2])
  return hot + ((cool - hot) * Math.min(Math.max(subclass, 0), 9.9)) / 10
}

/** Bolometric correction, interpolated over a standard temperature table. */
const BOLOMETRIC_CORRECTION: [kelvin: number, bc: number][] = [
  [40000, -4.0],
  [30000, -3.16],
  [20000, -2.05],
  [10000, -0.3],
  [8000, -0.15],
  [7000, -0.09],
  [6000, -0.03],
  [5772, -0.08],
  [5000, -0.31],
  [4000, -1.02],
  [3500, -1.46],
  [3000, -2.73],
  [2500, -4.1],
]

function bolometricCorrection(kelvin: number): number {
  const table = BOLOMETRIC_CORRECTION
  if (kelvin >= table[0][0]) return table[0][1]
  for (let i = 1; i < table.length; i++) {
    if (kelvin >= table[i][0]) {
      const [hotK, hotBc] = table[i - 1]
      const [coolK, coolBc] = table[i]
      const t = (kelvin - coolK) / (hotK - coolK)
      return coolBc + (hotBc - coolBc) * t
    }
  }
  return table[table.length - 1][1]
}

const SOLAR_RADIUS_M = 6.957e8
const SOLAR_KELVIN = 5772
const SOLAR_BOLOMETRIC_MAG = 4.74

/**
 * Stellar radius from absolute magnitude and temperature, by Stefan-Boltzmann.
 *
 * R/Rsun = sqrt(L/Lsun) * (Tsun/T)^2, with L from the bolometric magnitude. This is a
 * DERIVED quantity, not a measured one: the temperature came from a spectral class
 * letter and the bolometric correction from a table, so the result is good to roughly
 * a factor of two for evolved stars and rather better on the main sequence. It is
 * used to frame the camera on arrival and to size the stand-in sphere, and it is
 * never presented as a measurement.
 */
function stellarRadiusMetres(absoluteMag: number, kelvin: number): number {
  const bolometric = absoluteMag + bolometricCorrection(kelvin)
  const luminosity = 10 ** ((SOLAR_BOLOMETRIC_MAG - bolometric) / 2.5)
  const radiusSolar = Math.sqrt(Math.max(luminosity, 1e-8)) * (SOLAR_KELVIN / kelvin) ** 2
  // Clamp to the range real stars occupy: a white dwarf is about 0.008 Rsun and the
  // largest known red supergiants are near 2000 Rsun. Anything outside that is the
  // estimate failing, not a discovery.
  return Math.min(Math.max(radiusSolar, 0.008), 2000) * SOLAR_RADIUS_M
}

function linearRgbToHex(rgb: [number, number, number]): string {
  const channel = (v: number) => {
    // Back to sRGB for a CSS colour string.
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
    return Math.round(Math.min(Math.max(c, 0), 1) * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return channel(rgb[0]) + channel(rgb[1]) + channel(rgb[2])
}

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

/**
 * Flux scale for the star fields.
 *
 * 1.25, not 1. Every quad used to be as many pixels wide as it was tall in NDC,
 * which on a 16:9 window made it 1.72 times wider than tall; sizing x from the
 * viewport width took that factor straight out of the field's integrated flux.
 * Measured at the 100 ly rung: frame mean 14.7 before the width fix, 10.5 after.
 * This gives most of it back. It is deliberately not the full 1.72 — the lost light
 * was in the wings of quads that should never have been that wide, and the cores are
 * already at the top of the tone curve.
 */
const STAR_GAIN = 1.25

const STAR_VERTEX = /* glsl */ `
  attribute vec3 starPosition;   // parsecs, layer-local
  attribute vec3 starColor;      // linear sRGB, luminance-normalised
  attribute float absMag;        // absolute magnitude

  uniform float uPixelWidth;     // viewport width in device pixels
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
    // NDC x spans the viewport WIDTH and NDC y its HEIGHT, so one shared offset would
    // make every quad W/H times wider than tall and the circular discard would cut an
    // ellipse. Scale each axis by its own pixel count.
    vec2 pixelScale = 2.0 * radiusPx / vec2(uPixelWidth, uPixelHeight);
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
  /**
   * The same stars before the Y-up basis swap, in ICRS parsecs.
   *
   * The registry stores a world position in a named reference frame, not a position
   * in some layer's scene basis, so registering a star needs the catalogue vector
   * rather than the one the vertex shader consumes.
   */
  private globalIcrfPc: Float32Array | null = null
  private readonly namedStarIds: string[] = []

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
      await this.loadNamedStars()
      await this.loadConstellations()
      // L2 last, and only once the sky is already usable: it is 2.9 MB across 192
      // files and nobody should wait on it to see a star.
      await this.loadDeepTier()
    })
  }

  private async loadTier(name: 'l0' | 'l1'): Promise<StarTier | null> {
    const [manifest, buffer] = await Promise.all([
      fetch(assetUrl(`${DATA}/${name}.json`)).then((r) => (r.ok ? (r.json() as Promise<TierManifest>) : null)),
      fetch(assetUrl(`${DATA}/${name}.bin`)).then((r) => (r.ok ? r.arrayBuffer() : null)),
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
    const icrf = new Float32Array(count * 3)
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

      icrf[i * 3] = x[i]
      icrf[i * 3 + 1] = y[i]
      icrf[i * 3 + 2] = z[i]

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
      this.globalIcrfPc = icrf
    } else if (this.globalPositions && this.globalIcrfPc) {
      const merged = new Float32Array(this.globalPositions.length + positions.length)
      merged.set(this.globalPositions, 0)
      merged.set(positions, this.globalPositions.length)
      this.globalPositions = merged
      const mergedIcrf = new Float32Array(this.globalIcrfPc.length + icrf.length)
      mergedIcrf.set(this.globalIcrfPc, 0)
      mergedIcrf.set(icrf, this.globalIcrfPc.length)
      this.globalIcrfPc = mergedIcrf
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
        uPixelWidth: { value: 1920 },
        uPixelHeight: { value: 1080 },
        uTanHalfFov: { value: 0.46 },
        uMagLimit: { value: 6.5 },
        uMinRadiusPx: { value: 0.7 },
        uMaxRadiusPx: { value: 18 },
        uGain: { value: STAR_GAIN },
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
   *
   * And they arrive in ONE file. They used to be 192 separate requests, fetched eight at
   * a time, which was 74 per cent of every request the atlas made on a cold boot for ten
   * per cent of its bytes. The chunking bought nothing at runtime, because this function
   * has always loaded every chunk unconditionally and concatenated them: there is no
   * frustum test and no distance gate to preserve. `l2.bin` is those same chunk blocks
   * laid end to end, and `chunks[].byteOffset` says where each one starts.
   *
   * Should per-tile streaming ever be wanted, it should be driven by the camera and cut
   * by distance shell rather than reinstated wholesale; at 2.4 MB for the entire tier it
   * is not obvious that it would pay for its own complexity.
   */
  private async loadDeepTier(): Promise<void> {
    const [index, whole] = await Promise.all([
      fetch(assetUrl(`${DATA}/l2/index.json`))
        .then((r) => (r.ok ? (r.json() as Promise<L2Index>) : null))
        .catch(() => null),
      fetch(assetUrl(`${DATA}/l2.bin`))
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null),
    ])
    if (!index || !whole || this.engine.isDisposed) return

    const total = index.recordCount
    const positions = new Float32Array(total * 3)
    const colors = new Float32Array(total * 3)
    const absMag = new Float32Array(total)
    const colourCache = new Map<number, [number, number, number]>()
    const scratch = vec3d()
    let written = 0

    // Sliced, not because the work is large but because it was INDIVISIBLE: one 54 ms
    // task on this desktop, and a phone CPU is four to six times slower, which puts the
    // same loop near 300 ms of blocked input and paint. Sixteen HEALPix chunks is about
    // 23,000 records a slice, comfortably under the 50 ms long-task threshold even there.
    let sliceCpuMs = 0
    let worstSliceMs = 0
    const completed = await forEachSlice(
      index.chunks,
      16,
      (chunk) => {
      const sliceStart = performance.now()
      const n = chunk.count
      // Each block's int16 fields are read in place, which is why the packer starts every
      // block on a 2-byte boundary: records are 9 bytes, so 95 of the 192 chunks are an
      // odd number of bytes long and a tightly packed file would hand `Int16Array` an odd
      // byteOffset for half of them, which throws. Total padding is 95 bytes.
      const base = chunk.byteOffset
      if (base % 2 !== 0 || base + 9 * n > whole.byteLength) {
        console.warn(`[omniatlas] stars: L2 chunk ${chunk.pix} has a bad offset; skipped`)
        return
      }
      const x = new Int16Array(whole, base, n)
      const y = new Int16Array(whole, base + 2 * n, n)
      const z = new Int16Array(whole, base + 4 * n, n)
      const magu = new Uint8Array(whole, base + 6 * n, n)
      const ciu = new Uint8Array(whole, base + 7 * n, n)

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
      const spent = performance.now() - sliceStart
      sliceCpuMs += spent
      if (spent > worstSliceMs) worstSliceMs = spent
      },
      () => this.engine.isDisposed,
    )

    // A decode that yields can outlive what started it: StrictMode remounts every effect
    // in development, and a visitor can leave mid-boot. `forEachSlice` reports whether it
    // ran to the end, and a partial buffer must not be handed to the GPU.
    if (!completed || written === 0) return

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
    console.info(
      `[omniatlas] stars: deep tier resident, ${written.toLocaleString('en-GB')} additional stars ` +
        `(decoded in ${Math.ceil(index.chunks.length / 16)} slices, ${sliceCpuMs.toFixed(0)} ms of CPU, ` +
        `worst slice ${worstSliceMs.toFixed(1)} ms)`,
    )
  }

  /**
   * Constellation figures, as index pairs into the global star index space.
   *
   * They are drawn with full opacity near the Sun and fade out by about 50 parsecs,
   * so leaving the solar neighbourhood visibly pulls them apart. That dissolution is
   * the point: constellations are an Earth-bound projection, and an atlas that kept
   * them rigid while the camera moved would be teaching something false.
   */
  /**
   * Register the stars with IAU proper names, so they can be searched and flown to.
   *
   * Before this, not one of the 329,860 stars in the atlas was reachable. The field
   * drew them beautifully and the registry did not know they existed, so Sirius,
   * Betelgeuse and Proxima Centauri were absent from search, from the inspector and
   * from the cosmic address — in an atlas whose entire middle scale is stars.
   *
   * The 604 proper-named stars are the right set. Bayer and Flamsteed designations
   * would add 2,700 more rows that nobody types into a search box, and every one of
   * them would compete for a label with the object the viewer is actually looking at.
   */
  private async loadNamedStars(): Promise<void> {
    const icrfPc = this.globalIcrfPc
    if (!icrfPc) return
    const payload = await fetch(assetUrl(`${DATA}/names.json`))
      .then((r) => (r.ok ? (r.json() as Promise<NamesPayload>) : null))
      .catch(() => null)
    if (!payload?.stars?.length || this.engine.isDisposed) return

    const borrowed = borrowedProperNames(payload.stars)
    let registered = 0
    let outOfRange = 0
    for (const star of payload.stars) {
      if (!star.proper || borrowed.has(star.i)) continue
      const base = star.i * 3
      if (base + 2 >= icrfPc.length) {
        // A name indexing into L2, which this module does not keep positions for.
        outOfRange++
        continue
      }
      const px = icrfPc[base]
      const py = icrfPc[base + 1]
      const pz = icrfPc[base + 2]
      const distancePc = Math.hypot(px, py, pz)
      // The sentinel rows were zeroed during decode and carry no position.
      if (!(distancePc > 0)) continue

      const absoluteMag = star.m - 5 * (Math.log10(distancePc) - 1)
      const kelvin = spectralTypeToKelvin(star.spect)
      const rgb = kelvinToLinearRgb(kelvin)

      this.engine.register({
        id: `star:${star.i}`,
        worldPosition: { x: px * PC_M, y: py * PC_M, z: pz * PC_M },
        frame: 'icrf',
        radiusMetres: stellarRadiusMetres(absoluteMag, kelvin),
        layer: LAYER,
        objectClass: 'star',
        name: star.proper,
        parentId: 'milky-way',
        proxyColor: `#${linearRgbToHex(rgb)}`,
      })
      this.namedStarIds.push(`star:${star.i}`)
      registered++
    }
    console.info(
      `[omniatlas] stars: ${registered} proper-named stars registered` +
        (outOfRange ? `, ${outOfRange} skipped (name indexes a tier with no kept positions)` : '') +
        (borrowed.size ? `, ${borrowed.size} skipped (proper name belongs to another star)` : ''),
    )
  }

  private async loadConstellations(): Promise<void> {
    if (!this.globalPositions) return
    const buffer = await fetch(assetUrl(`${DATA}/constellations.bin`))
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
    // Before the star fields (-10), not after them. These lines are NormalBlending,
    // so drawn second they alpha-blended over every star they crossed and cut a dark
    // blue notch through it — at 8 pc a (172,169,167) star pixel came out
    // (77,102,122). Drawing the figure first lets the additive star sprites lay over
    // it instead. Switching the lines to AdditiveBlending would also remove the notch
    // and was measured: it raises the overlay's own contribution to the frame 2.4x,
    // which is the opposite of what this overlay needs.
    this.constellations.renderOrder = -11
    this.engine.layer(LAYER).scene.add(this.constellations)
  }

  preRender(ctx: FrameContext): void {
    const layer = this.engine.layer(LAYER)
    const dpr = Math.min(window.devicePixelRatio, 2)
    const pixelWidth = ctx.width * dpr
    const pixelHeight = ctx.height * dpr

    // The limiting magnitude follows the field of view the way a telescope's does:
    // narrowing the view concentrates light and reveals fainter stars. It doubles as
    // the single most effective performance dial, since it culls in the vertex shader.
    const fovRef = 50
    const magLimit = 6.2 + 5 * Math.log10(fovRef / Math.max(ctx.fovDegrees, 1)) + 2.4

    // The engine's verdict on this layer's role in this frame, not the raw span band:
    // drawn as the backdrop behind a subject in another layer, the star field has to
    // read as sky. `spanOpacity` stays raw, as the measurement it is.
    const layerFade = layer.renderOpacity

    for (const material of this.materials) {
      material.uniforms.uPixelWidth.value = pixelWidth
      material.uniforms.uPixelHeight.value = pixelHeight
      material.uniforms.uMagLimit.value = magLimit
      material.uniforms.uTanHalfFov.value = Math.tan((ctx.fovDegrees * Math.PI) / 360)
      material.uniforms.uGain.value = STAR_GAIN * layerFade
    }

    if (this.constellations) {
      // Distance of the camera from the Sun, in parsecs.
      //
      // A constellation figure is a projection of one vantage point, and it stops
      // meaning anything as soon as the camera has moved far enough for the stars in
      // it to have separated on the sky. Measured over all 1,683 figure vertices
      // (median radius 60.8 pc), an 8 pc camera offset moves the median vertex 5.2
      // degrees and the figures still read; at 30 pc it is 18.4 degrees median and
      // 60 at p90, which is the spiderweb of chords converging on where the Sun used
      // to be. The old (1, 50) schedule was still drawing that web at 0.14 alpha, and
      // against a near-black sky after AgX that is not faint. (5, 20) keeps the
      // overlay across the whole solar neighbourhood, where it is correct and useful,
      // and lets go where the geometry does.
      const distancePc = layer.cameraDistanceMetres / PC_M
      const opacity = 0.42 * (1 - smoothstep(5, 20, distancePc)) * layer.renderOpacity
      const material = this.constellations.material as THREE.LineBasicMaterial
      material.opacity = opacity
      this.constellations.visible = opacity > 0.01
    }
  }

  dispose(): void {
    for (const id of this.namedStarIds) this.engine.unregister(id)
    this.namedStarIds.length = 0
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
