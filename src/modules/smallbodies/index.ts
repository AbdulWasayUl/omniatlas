import * as THREE from 'three'
import type { AtlasModule, Engine, FrameContext, SceneNodeHandle } from '../../core/Engine'
import { AU_M, type Vec3d, vec3d } from '../../core/world'
import { type KeplerianElements, keplerianPosition, sampleOrbit } from '../../astronomy/orbit'
import { spanVisibility } from '../../core/render/spanFade'
import { assetUrl } from '../../data/assetUrl'

/**
 * Small bodies: the main belt, and the named asteroids and comets.
 *
 * Everything lives in the `helio` layer — one unit is one AU, the origin is the Sun,
 * the frame is the J2000 ecliptic — which is the frame SBDB serves these elements in,
 * so no rotation is needed and none is invented.
 *
 * ## The belt is propagated on the GPU
 *
 * 80,598 main-belt bodies, each carrying its own osculating elements as instance
 * attributes uploaded exactly once. Kepler's equation is solved in the vertex shader
 * against a single `uDays` uniform, so the per-frame CPU cost of the belt is literally
 * one uniform write. The previous CPU implementation managed 4,500 bodies and spent
 * milliseconds doing it.
 *
 * Instanced quads rather than `gl.POINTS`, for the same two reasons the star field uses
 * them: implementations clip a point on its centre, and `ALIASED_POINT_SIZE_RANGE` caps
 * at 64 on Apple silicon.
 *
 * ## The Kirkwood gaps are not visible in a true-position belt, and that is correct
 *
 * This was measured on the shipped data rather than assumed. Binning all 80,598 bodies
 * in 0.01 AU bins and comparing each resonance against the mean of its shoulders:
 *
 *     resonance   a (AU)   depletion in a   depletion in instantaneous r
 *     4:1          2.065        1.000                  -0.001
 *     3:1          2.502        0.927                  -0.017
 *     5:2          2.825        0.659                  -0.124
 *     2:1          3.279        0.986                   0.036
 *
 * The gaps are 66-100% deep in semi-major axis and simply absent from the distribution
 * of heliocentric distance, because a gap is 0.02-0.05 AU wide while a typical belt
 * eccentricity of 0.15 smears one body's distance over +/-0.4 AU. No rendering of real
 * positions can show them; the famous Kirkwood figure is a histogram in `a`, not a
 * picture of the sky. Faking them would mean moving 80,000 bodies to places they are
 * not, so instead `setElementSpaceBlend(1)` collapses every orbit to a circle of
 * radius `a` at the same mean anomaly — the classical mean-orbit diagram, in which the
 * gaps are unmistakable dark lanes. That view is an ILLUSTRATION and whatever control
 * drives it must label it as one. The default is 0: true derived positions, no gaps.
 *
 * ## Honesty
 *
 * The elements are MEASURED (JPL SBDB orbit solutions). The positions drawn from them
 * are DERIVED: these are osculating two-body elements, valid to within a few thousand
 * kilometres near their epoch and degrading as planetary perturbations accumulate over
 * decades. Nothing here is integrated. Objects whose elements cannot support a
 * two-body propagation — the 46 unbound comets with e >= 1, including 'Oumuamua — are
 * skipped rather than coerced into an ellipse, and the count is logged.
 */

const LAYER = 'helio' as const
const FRAME = 'ecliptic' as const
const DATA = '/data/smallbodies'

const MS_PER_DAY = 86_400_000

/**
 * How many named bodies get a registry entry.
 *
 * Every registered node draws a constant-size marker glyph, and the label engine has no
 * per-node visibility control, so registering all 1,274 propagatable bodies turns the
 * inner system into a blizzard of orange diamonds that hides the planets. The set is
 * therefore ranked by notability and capped. Raising this cap safely needs marker
 * decluttering in the label engine; see the module report.
 */
const MAX_NAMED_NODES = 160

/**
 * Catalogue aliases: these four carry hand-written editorial entries in
 * `src/data/asteroidBelt.ts` keyed by name, and the inspector looks an entity up by the
 * node id. Registering them under the SBDB id would silently throw that prose away.
 */
const CATALOG_ALIASES: Record<string, string> = {
  'sb-20000001': 'ceres',
  'sb-20000002': 'pallas',
  'sb-20000004': 'vesta',
  'sb-20000010': 'hygiea',
  'sb-20134340': 'pluto',
}

/** Orbit paths are expensive to look at, not to draw. These five earn one. */
const ORBIT_PATHS: { key: string; color: string; samples: number }[] = [
  { key: 'sb-20000001', color: '#9a9a8c', samples: 256 }, // Ceres
  { key: 'sb-20000004', color: '#a8906a', samples: 256 }, // Vesta
  { key: 'sb-20000002', color: '#8c8c9a', samples: 256 }, // Pallas
  { key: 'sb-1000036', color: '#4cd7c8', samples: 768 }, // 1P/Halley
  { key: 'sb-1000012', color: '#3fb8ab', samples: 512 }, // 67P/Churyumov-Gerasimenko
]

/** Always registered regardless of rank — the ones a visitor comes looking for. */
const MUST_HAVE = new Set<string>([
  // Asteroids: the big four, the spacecraft targets, the hazard and mission headliners.
  'sb-20000001', // 1 Ceres
  'sb-20000002', // 2 Pallas
  'sb-20000003', // 3 Juno
  'sb-20000004', // 4 Vesta
  'sb-20000010', // 10 Hygiea
  'sb-20000016', // 16 Psyche
  'sb-20000216', // 216 Kleopatra
  'sb-20000243', // 243 Ida
  'sb-20000253', // 253 Mathilde
  'sb-20000433', // 433 Eros
  'sb-20000951', // 951 Gaspra
  'sb-20001566', // 1566 Icarus
  'sb-20002060', // 2060 Chiron
  'sb-20002867', // 2867 Steins
  'sb-20003200', // 3200 Phaethon
  'sb-20004179', // 4179 Toutatis
  'sb-20005535', // 5535 Annefrank
  'sb-20021900', // 21900 Lutetia
  'sb-20025143', // 25143 Itokawa
  'sb-20065803', // 65803 Didymos
  'sb-20099942', // 99942 Apophis
  'sb-20101955', // 101955 Bennu
  'sb-20162173', // 162173 Ryugu
  // Comets: every one that has been visited, every one that is naked-eye famous.
  'sb-1000036', // 1P/Halley
  'sb-1000025', // 2P/Encke
  'sb-1000093', // 9P/Tempel 1
  'sb-1000005', // 19P/Borrelly
  'sb-1000032', // 21P/Giacobini-Zinner
  'sb-1000079', // 29P/Schwassmann-Wachmann 1
  'sb-1000095', // 55P/Tempel-Tuttle
  'sb-1000061', // 96P/Machholz 1
  'sb-1000012', // 67P/Churyumov-Gerasimenko
  'sb-1000394', // 73P/Schwassmann-Wachmann 3
  'sb-1000107', // 81P/Wild 2
  'sb-1000041', // 103P/Hartley 2
  'sb-1000140', // 109P/Swift-Tuttle
  'sb-1000068', // 12P/Pons-Brooks
  'sb-1000374', // 153P/Ikeya-Zhang
  'sb-1000132', // C/1995 O1 (Hale-Bopp)
  'sb-1000131', // C/1996 B2 (Hyakutake)
  'sb-1003667', // C/2020 F3 (NEOWISE)
])

/**
 * Of the cap, how many slots are held for comets.
 *
 * Without a quota, size-ranked selection fills every slot with 100 km main-belt rocks
 * and the atlas ends up with two comets in it, which is the wrong product.
 */
const COMET_SHARE = 0.34

// ---------------------------------------------------------------------------
// Dataset shapes, as the manifests describe them
// ---------------------------------------------------------------------------

interface BeltField {
  name: string
  attribute: string
  dtype: string
  byteOffset: number
  itemSize: number
  count: number
}

interface BeltManifest {
  recordCount: number
  fields: BeltField[]
  epoch?: { julianDayTdb?: number }
}

interface NamedElements {
  epochJdTdb: number
  aAu: number
  e: number
  iDeg: number
  omDeg: number
  wDeg: number
  maDeg: number
  periodYr?: number
  nDegPerDay?: number
  qAu?: number
  adAu?: number
}

interface NamedPhysical {
  H?: number
  M1?: number
  diameterKm?: number
  albedo?: number
}

interface NamedObject {
  id: string
  name?: string
  fullName?: string
  pdes?: string
  kind?: string
  family?: string
  orbitClass?: string
  orbitClassName?: string
  elements?: NamedElements
  physical?: NamedPhysical
}

interface NamedFile {
  meta?: { recordCount?: number }
  objects?: NamedObject[]
}

/** How a given node's radius was arrived at. Surfaced in the module report. */
type RadiusProvenance = 'measured' | 'derived' | 'nominal' | 'unknown'

interface NamedEntry {
  node: SceneNodeHandle
  elements: KeplerianElements
  radiusProvenance: RadiusProvenance
}

/**
 * Provenance for everything this module draws, exported so the inspector can stop
 * hard-coding "Measured" once `SceneNodeHandle` carries a provenance field.
 */
export const SMALL_BODY_PROVENANCE = {
  elements: 'measured',
  positions: 'derived',
  beltColour: 'illustration',
  note:
    'Orbital elements are measured JPL SBDB solutions. Drawn positions are derived by ' +
    'unperturbed two-body propagation of osculating elements from their stated epoch; ' +
    'accuracy degrades over decades. Belt point colour is an illustrative ramp in ' +
    'semi-major axis, not an observed colour. The optional mean-orbit view ' +
    '(setElementSpaceBlend) is a diagram, not a position field. The 34 comets with no ' +
    'measured nucleus report no radius at all; the camera frames them at the 1.3 km ' +
    'Jupiter-family median, which is a class figure and not a measurement of the object.',
  source: {
    label: 'NASA/JPL Small-Body Database',
    url: 'https://ssd.jpl.nasa.gov/tools/sbdb_query.html',
  },
} as const

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const BELT_VERTEX = /* glsl */ `
  // The renderer runs with logarithmicDepthBuffer on, so every depth-tested material
  // must write the same depth encoding as the lit spheres it is tested against. Omit
  // these and the belt either vanishes behind the near plane or draws over everything.
  #include <common>
  #include <logdepthbuf_pars_vertex>

  attribute float sbA;      // semi-major axis, AU
  attribute float sbE;      // eccentricity
  attribute float sbI;      // inclination, rad
  attribute float sbOmega;  // longitude of ascending node, rad
  attribute float sbPeri;   // argument of perihelion, rad
  attribute float sbM0;     // mean anomaly at the shared epoch, rad
  attribute float sbH;      // absolute magnitude

  uniform float uDays;          // days since the belt's shared epoch
  uniform float uPixelWidth;    // viewport width in device pixels
  uniform float uPixelHeight;   // viewport height in device pixels
  uniform float uSizePx;
  uniform float uGain;
  uniform float uOpacity;
  uniform float uElementBlend;  // 0 = true position, 1 = mean-circular diagram

  varying vec3 vColor;
  varying float vIntensity;
  varying vec2 vQuad;

  // Prefixed because <common> already defines PI as a macro; a 'const float PI' here
  // would be macro-expanded into a syntax error.
  const float SB_PI = 3.141592653589793;
  const float SB_TWO_PI = 6.283185307179586;
  const float SB_K_GAUSS = 0.01720209895;

  void main() {
    vQuad = position.xy;

    // --- propagate ---------------------------------------------------------
    // Mean motion from Kepler's third law about the Sun. a is in AU, so the Gaussian
    // constant gives rad/day directly with no unit conversion to get wrong.
    float n = SB_K_GAUSS / (sbA * sqrt(sbA));
    float M = sbM0 + n * uDays;
    // Wrap into [-PI, PI) before the solve: the Newton starter below is only a good
    // guess near the principal branch, and M grows without bound as time advances.
    M = mod(M + SB_PI, SB_TWO_PI) - SB_PI;

    // The Kirkwood gaps live in semi-major axis, not in heliocentric distance: the
    // 3:1 gap is 0.04 AU wide while a typical belt eccentricity smears a body's
    // distance by +/-0.4 AU, so a plot of true positions has no gaps in it at all
    // (measured: 93-100% depletion in a, 0-4% in instantaneous r). Driving this
    // uniform to 1 collapses every orbit to a circle of radius a at the same mean
    // anomaly, which is the classical mean-orbit diagram and the only honest way to
    // make the resonances visible. It is an ILLUSTRATION and must be labelled as one;
    // at 0, which is the default, every body is at its derived true position.
    float eEff = mix(sbE, 0.0, uElementBlend);

    // Newton-Raphson on E - e sin E = M. The starter is the standard second-order
    // expansion; with it, four iterations reach double-precision residual at e = 0.6
    // (the belt maximum), so five is a safety margin, not a guess.
    float E = M + eEff * sin(M) * (1.0 + eEff * cos(M));
    for (int k = 0; k < 5; k++) {
      E -= (E - eEff * sin(E) - M) / (1.0 - eEff * cos(E));
    }

    float cosE = cos(E);
    float sinE = sin(E);
    // Perifocal plane, AU. x toward perihelion.
    float xp = sbA * (cosE - eEff);
    float yp = sbA * sqrt(max(1.0 - eEff * eEff, 0.0)) * sinE;

    // omega about Z, then i about X, then Omega about Z — the standard order.
    float cw = cos(sbPeri), sw = sin(sbPeri);
    vec2 r1 = vec2(xp * cw - yp * sw, xp * sw + yp * cw);
    float ci = cos(sbI), si = sin(sbI);
    vec3 r2 = vec3(r1.x, r1.y * ci, r1.y * si);
    float cn = cos(sbOmega), sn = sin(sbOmega);
    vec3 ecl = vec3(r2.x * cn - r2.y * sn, r2.x * sn + r2.y * cn, r2.z);

    // Ecliptic frame is Z-up; the renderer is Y-up. Same swap as worldToSceneBasis.
    vec3 local = vec3(ecl.x, ecl.z, -ecl.y);

    // --- colour ------------------------------------------------------------
    // A subtle warm-to-cool ramp across the belt. It is not an observed colour; it
    // exists so the radial structure — the gaps, the Hilda and Cybele groups beyond
    // the 2:1 — reads as structure rather than as uniform grey noise.
    float t = clamp((sbA - 2.05) / 1.15, 0.0, 1.0);
    vec3 inner = vec3(0.82, 0.62, 0.40);
    vec3 mid = vec3(0.64, 0.65, 0.66);
    vec3 outer = vec3(0.44, 0.57, 0.74);
    vColor = t < 0.5 ? mix(inner, mid, t * 2.0) : mix(mid, outer, (t - 0.5) * 2.0);

    // Brighter bodies are drawn slightly larger and brighter. H runs 3.25 to 15.2.
    float bright = clamp((15.2 - sbH) / 11.95, 0.0, 1.0);
    float radiusPx = uSizePx * (0.85 + 0.9 * bright * bright);
    vIntensity = uGain * uOpacity * (0.35 + 0.75 * bright);

    vec4 viewPosition = modelViewMatrix * vec4(local, 1.0);
    vec4 clip = projectionMatrix * viewPosition;
    // Constant pixel size: offset in clip space, scaled by w.
    // NDC x spans the viewport WIDTH and NDC y its HEIGHT, so one shared offset would
    // make every quad W/H times wider than tall and the circular discard would cut an
    // ellipse. Scale each axis by its own pixel count.
    clip.xy += position.xy * (2.0 * radiusPx / vec2(uPixelWidth, uPixelHeight)) * clip.w;
    gl_Position = clip;

    #include <logdepthbuf_vertex>
  }
`

const BELT_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  varying vec3 vColor;
  varying float vIntensity;
  varying vec2 vQuad;

  void main() {
    float r2 = dot(vQuad, vQuad);
    if (r2 > 1.0) discard;

    #include <logdepthbuf_fragment>

    // Soft falloff, as the star shader uses: a hard disc at this size reads as a grid
    // of paint flecks, and additive soft cores are what let density become brightness.
    // Alpha carries only the falloff, as the star shader does: three's additive
    // blending is (SrcAlpha, One), so putting intensity in alpha too would square it.
    float falloff = exp(-3.4 * r2);
    gl_FragColor = vec4(vColor * vIntensity * falloff, falloff);
  }
`

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class SmallBodiesModule implements AtlasModule {
  id = 'smallbodies'

  private engine!: Engine
  private quad: THREE.BufferGeometry | null = null
  private beltMesh: THREE.Mesh | null = null
  private beltMaterial: THREE.ShaderMaterial | null = null
  private beltEpochMs = Date.UTC(2026, 5, 9)

  private readonly named: NamedEntry[] = []
  private readonly orbitLines: THREE.LineSegments[] = []
  /** Each orbit line with the diameter of the orbit it draws, for the span fade. */
  private readonly orbitSizes: { line: THREE.LineSegments; sizeMetres: number; baseOpacity: number }[] = []
  private readonly localPosition = new THREE.Vector3()
  private readonly scratchWorld = vec3d()

  /** Counts kept for the honesty report and the console summary. */
  readonly stats = {
    beltInstances: 0,
    namedTotal: 0,
    namedUnbound: 0,
    namedUnusableElements: 0,
    namedDuplicateOfExisting: 0,
    namedRegistered: 0,
    namedWithheldByCap: 0,
    radiusMeasured: 0,
    radiusDerived: 0,
    radiusNominal: 0,
    radiusUnknown: 0,
    orbitPaths: 0,
  }

  async init(engine: Engine): Promise<void> {
    this.engine = engine

    this.quad = new THREE.BufferGeometry()
    this.quad.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    )
    this.quad.setIndex([0, 1, 2, 0, 2, 3])

    // Both datasets are independent; a failure in either must not cost the other.
    await Promise.all([this.loadBelt(), this.loadNamed()])
    if (engine.isDisposed) return

    console.info('[omniatlas] smallbodies', this.stats)
  }

  // -------------------------------------------------------------------------
  // The belt
  // -------------------------------------------------------------------------

  private async loadBelt(): Promise<void> {
    const [manifest, buffer] = await Promise.all([
      fetchJson<BeltManifest>(`${DATA}/belt.manifest.json`),
      fetchBuffer(`${DATA}/belt.bin`),
    ])
    if (this.engine.isDisposed) return
    if (!manifest || !buffer) {
      console.warn('[omniatlas] small-body belt data unavailable; belt not drawn')
      return
    }

    const count = manifest.recordCount
    const fields = manifest.fields
    if (!Number.isFinite(count) || count <= 0 || !Array.isArray(fields)) {
      console.warn('[omniatlas] belt manifest malformed; belt not drawn')
      return
    }

    // Struct-of-arrays: all of `a`, then all of `e`, and so on. Reading this as
    // interleaved records would produce a plausible-looking but entirely wrong cloud,
    // which is exactly what it did once on the constellation file. Every block is
    // bounds-checked against the actual buffer before it becomes a typed-array view.
    const view = (name: string): Float32Array | null => {
      const field = fields.find((f) => f.name === name)
      if (!field || field.dtype !== 'float32' || field.itemSize !== 1) return null
      if (field.count !== count) return null
      if (field.byteOffset % 4 !== 0) return null
      if (field.byteOffset + count * 4 > buffer.byteLength) return null
      return new Float32Array(buffer, field.byteOffset, count)
    }

    const blocks: Record<string, Float32Array> = {}
    for (const name of ['a', 'e', 'i', 'om', 'w', 'ma', 'H']) {
      const block = view(name)
      if (!block) {
        console.warn(`[omniatlas] belt field "${name}" missing or malformed; belt not drawn`)
        return
      }
      blocks[name] = block
    }

    // Decode check against a known object. The file is sorted by H ascending, so
    // record 0 is 4 Vesta: a = 2.361366 AU, e = 0.090204, H = 3.25.
    if (Math.abs(blocks.a[0] - 2.361366) > 1e-4 || Math.abs(blocks.H[0] - 3.25) > 1e-3) {
      console.warn(
        `[omniatlas] belt decode check failed: record 0 is a=${blocks.a[0]} H=${blocks.H[0]}, expected Vesta (2.361366, 3.25). Drawing anyway, but the layout may have changed.`,
      )
    }

    const jd = manifest.epoch?.julianDayTdb
    if (typeof jd === 'number' && Number.isFinite(jd)) this.beltEpochMs = julianDayToMs(jd)

    const geometry = new THREE.InstancedBufferGeometry()
    geometry.index = this.quad!.index
    geometry.setAttribute('position', this.quad!.getAttribute('position'))
    geometry.setAttribute('sbA', new THREE.InstancedBufferAttribute(blocks.a, 1))
    geometry.setAttribute('sbE', new THREE.InstancedBufferAttribute(blocks.e, 1))
    geometry.setAttribute('sbI', new THREE.InstancedBufferAttribute(blocks.i, 1))
    geometry.setAttribute('sbOmega', new THREE.InstancedBufferAttribute(blocks.om, 1))
    geometry.setAttribute('sbPeri', new THREE.InstancedBufferAttribute(blocks.w, 1))
    geometry.setAttribute('sbM0', new THREE.InstancedBufferAttribute(blocks.ma, 1))
    geometry.setAttribute('sbH', new THREE.InstancedBufferAttribute(blocks.H, 1))
    geometry.instanceCount = count

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uDays: { value: 0 },
        uPixelWidth: { value: 1920 },
        uPixelHeight: { value: 1080 },
        uSizePx: { value: 1.25 },
        // Calibrated against an offline raster of the same shader maths at the same
        // instance count; it is the dial to turn if the belt reads too hot or too
        // faint once the post stack's tone mapping is final.
        // Dimmer than it looks like it should be. 80,598 additive splats overlap
        // heavily near the ecliptic, and at the system view the belt was summing into
        // a solid white wall across the inner planets rather than reading as a faint
        // ring of dust.
        //
        // The belt was the one sprite field left uncompensated when the quads stopped
        // being stretched by the viewport aspect, on the grounds that it is
        // "opacity-driven" — which is wrong: BELT_VERTEX computes vIntensity from
        // uGain, uOpacity and brightness with no dependence on quad size, so
        // narrowing the quad removed light here exactly as it did everywhere else.
        // It removed less, because these quads sit near the 1-pixel minimum: measured
        // from Ceres at 3.5 AU, frame mean 5.816 narrow against 6.128 stretched, and
        // lit-pixel fraction 0.105 against 0.114. 0.1 -> 0.113 covers that 8%.
        uGain: { value: 0.113 },
        uOpacity: { value: 1 },
        uElementBlend: { value: 0 },
      },
      vertexShader: BELT_VERTEX,
      fragmentShader: BELT_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Depth-tested so the belt passes behind the Sun and the planets rather than
      // over them, but it writes no depth of its own: 80,000 additive sprites fighting
      // each other in the depth buffer would stipple.
      depthTest: true,
    })

    const mesh = new THREE.Mesh(geometry, material)
    // The propagation happens in the vertex shader, so three.js has no idea where this
    // object is. Its bounding sphere is meaningless and culling it would be wrong.
    mesh.frustumCulled = false
    mesh.renderOrder = -5
    mesh.name = 'smallbodies:belt'

    this.beltMesh = mesh
    this.beltMaterial = material
    this.stats.beltInstances = count
    this.engine.layer(LAYER).scene.add(mesh)
  }

  // -------------------------------------------------------------------------
  // Named asteroids and comets
  // -------------------------------------------------------------------------

  private async loadNamed(): Promise<void> {
    const file = await fetchJson<NamedFile>(`${DATA}/named.json`)
    if (this.engine.isDisposed) return
    if (!file || !Array.isArray(file.objects)) {
      console.warn('[omniatlas] named small bodies unavailable; none registered')
      return
    }

    const layer = this.engine.layer(LAYER)
    const candidates: { object: NamedObject; nodeId: string; score: number; isComet: boolean }[] = []
    this.stats.namedTotal = file.objects.length

    for (const object of file.objects) {
      const elements = object.elements
      if (!elements || typeof object.id !== 'string') {
        this.stats.namedUnusableElements++
        continue
      }
      // Unbound and parabolic orbits (e >= 1) have no semi-major axis and no period.
      // `keplerianPosition` is an elliptical propagator; feeding it these would put
      // them on invented ellipses. Skipped, counted, reported.
      if (!(elements.e >= 0) || elements.e >= 1) {
        this.stats.namedUnbound++
        continue
      }
      const periodDays = periodDaysOf(elements)
      if (!(elements.aAu > 0) || !(periodDays > 0) || !Number.isFinite(elements.epochJdTdb)) {
        this.stats.namedUnusableElements++
        continue
      }

      const nodeId = CATALOG_ALIASES[object.id] ?? object.id
      // The solar module registers the Sun, the planets, Pluto and the major moons.
      // Registering a second node for the same body would give it two markers.
      if (this.engine.registry.has(nodeId)) {
        this.stats.namedDuplicateOfExisting++
        continue
      }

      candidates.push({ object, nodeId, score: notabilityScore(object), isComet: isComet(object) })
    }

    // Ranked within class, not across it: a comet and an asteroid are not comparable
    // on size, and the one metric they share (absolute magnitude) means different
    // things for a bare rock and for a coma.
    const comets = candidates.filter((c) => c.isComet).sort((a, b) => b.score - a.score)
    const asteroids = candidates.filter((c) => !c.isComet).sort((a, b) => b.score - a.score)
    const cometSlots = Math.round(MAX_NAMED_NODES * COMET_SHARE)
    const chosenComets = comets.slice(0, cometSlots)
    const chosenAsteroids = asteroids.slice(0, MAX_NAMED_NODES - chosenComets.length)
    const chosen = [...chosenAsteroids, ...chosenComets]
    this.stats.namedWithheldByCap = candidates.length - chosen.length

    for (const { object, nodeId } of chosen) {
      const elements = object.elements!
      const kepler: KeplerianElements = {
        semiMajorAxisKm: (elements.aAu * AU_M) / 1000,
        eccentricity: elements.e,
        inclinationDeg: elements.iDeg,
        nodeDeg: elements.omDeg,
        periapsisDeg: elements.wDeg,
        meanAnomalyDegAtEpoch: elements.maDeg,
        epoch: new Date(julianDayToMs(elements.epochJdTdb)),
        periodDays: periodDaysOf(elements),
      }

      const { radiusMetres, framingRadiusMetres, provenance } = radiusOf(object)
      if (provenance === 'measured') this.stats.radiusMeasured++
      else if (provenance === 'derived') this.stats.radiusDerived++
      else if (provenance === 'nominal') this.stats.radiusNominal++
      else this.stats.radiusUnknown++

      const node: SceneNodeHandle = {
        id: nodeId,
        worldPosition: vec3d(),
        frame: FRAME,
        radiusMetres,
        framingRadiusMetres,
        layer: LAYER,
        objectClass: isComet(object) ? 'comet' : 'asteroid',
        name: displayName(object),
        // Everything here orbits the Sun directly; none of them is a satellite.
        parentId: 'sun',
      }
      this.engine.register(node)
      this.named.push({ node, elements: kepler, radiusProvenance: provenance })
    }
    this.stats.namedRegistered = this.named.length

    // Place them once before the first frame so nothing is drawn at the origin.
    this.propagate(Date.now())

    // Orbit paths, for the handful whose shape is worth seeing. Looked up from the
    // full candidate set so a body that lost its registry slot to the cap still gets
    // its path — though in practice all five are in MUST_HAVE.
    const bySbdbId = new Map(candidates.map((c) => [c.object.id, c.object]))
    for (const spec of ORBIT_PATHS) {
      const object = bySbdbId.get(spec.key)
      if (!object?.elements) continue
      const entry = this.named.find((e) => e.node.id === (CATALOG_ALIASES[spec.key] ?? spec.key))
      const kepler =
        entry?.elements ??
        ({
          semiMajorAxisKm: (object.elements.aAu * AU_M) / 1000,
          eccentricity: object.elements.e,
          inclinationDeg: object.elements.iDeg,
          nodeDeg: object.elements.omDeg,
          periapsisDeg: object.elements.wDeg,
          meanAnomalyDegAtEpoch: object.elements.maDeg,
          epoch: new Date(julianDayToMs(object.elements.epochJdTdb)),
          periodDays: periodDaysOf(object.elements),
        } satisfies KeplerianElements)
      this.addOrbitPath(layer, kepler, spec.color, spec.samples, object.id)
    }
    this.stats.orbitPaths = this.orbitLines.length
  }

  /**
   * One orbit as a closed polyline, local to the Sun-centred layer origin.
   *
   * `sampleOrbit` samples uniformly in eccentric anomaly, which is what keeps a comet
   * looking like a comet: a uniform-in-time sample of 1P/Halley spends essentially
   * every vertex out near 35 AU and renders the perihelion passage as a straight line
   * through the inner system.
   */
  private addOrbitPath(
    layer: ReturnType<Engine['layer']>,
    elements: KeplerianElements,
    color: string,
    samples: number,
    debugId: string,
  ): void {
    const points = sampleOrbit(elements, samples)
    if (points.length < 2) return

    const positions = new Float32Array((points.length - 1) * 6)
    let o = 0
    let finite = true
    const toLocal = (point: Vec3d): [number, number, number] => {
      // sampleOrbit returns kilometres; the layer wants metres.
      this.scratchWorld.x = point.x * 1000
      this.scratchWorld.y = point.y * 1000
      this.scratchWorld.z = point.z * 1000
      layer.toLocal(this.localPosition, this.scratchWorld, FRAME)
      return [this.localPosition.x, this.localPosition.y, this.localPosition.z]
    }
    for (let i = 0; i < points.length - 1; i++) {
      const a = toLocal(points[i])
      const b = toLocal(points[i + 1])
      if (!Number.isFinite(a[0]) || !Number.isFinite(b[0])) {
        finite = false
        break
      }
      positions[o++] = a[0]
      positions[o++] = a[1]
      positions[o++] = a[2]
      positions[o++] = b[0]
      positions[o++] = b[1]
      positions[o++] = b[2]
    }
    if (!finite) {
      console.warn(`[omniatlas] orbit path for ${debugId} produced non-finite vertices; skipped`)
      return
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const material = new THREE.LineBasicMaterial({
      color: new THREE.Color(color),
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    })
    const line = new THREE.LineSegments(geometry, material)
    line.name = `orbit:${debugId}`
    line.frustumCulled = false
    layer.scene.add(line)
    this.orbitLines.push(line)
    this.orbitSizes.push({
      line,
      sizeMetres: elements.semiMajorAxisKm * 1000 * 2,
      baseOpacity: material.opacity,
    })
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  private propagate(epochMs: number): void {
    const date = new Date(epochMs)
    for (const entry of this.named) {
      // keplerianPosition returns kilometres in the frame the elements are given in,
      // which for SBDB is the J2000 ecliptic — the layer's own frame, so no rotation.
      const km = keplerianPosition(entry.elements, date)
      entry.node.worldPosition.x = km.x * 1000
      entry.node.worldPosition.y = km.y * 1000
      entry.node.worldPosition.z = km.z * 1000
    }
  }

  update(ctx: FrameContext): void {
    if (this.named.length > 0) this.propagate(ctx.epochMs)
  }

  preRender(ctx: FrameContext): void {
    // A comet's path across the inner system is worth seeing from the inner system
    // and is a coloured streak from 2,000 km above a moon. See spanFade.ts.
    for (const orbit of this.orbitSizes) {
      const visibility = spanVisibility(ctx.viewSpanMetres, orbit.sizeMetres)
      orbit.line.visible = visibility > 0.004
      ;(orbit.line.material as THREE.LineBasicMaterial).opacity = orbit.baseOpacity * visibility
    }

    const material = this.beltMaterial
    if (!material) return
    const dpr = Math.min(window.devicePixelRatio, 2)
    material.uniforms.uPixelWidth.value = ctx.width * dpr
    material.uniforms.uPixelHeight.value = ctx.height * dpr
    // Float64 subtraction on the CPU, downcast once. The belt epoch is 2026-06-09, so
    // this stays small for any plausible simulated instant; the float32 rounding of a
    // 10,000-day span costs about 3e-4 radians of mean anomaly.
    material.uniforms.uDays.value = (ctx.epochMs - this.beltEpochMs) / MS_PER_DAY

    // Fade the belt out as the camera closes on a body: inside a planetary system the
    // belt is a distant background and should not sit as a bright wall across the sky.
    // `renderOpacity`, not `spanOpacity`: the raw band measure keeps its meaning as a
    // measurement and the engine has already folded the layer's role into this one.
    const layer = this.engine.layer(LAYER)
    const au = layer.cameraDistanceMetres / AU_M
    material.uniforms.uOpacity.value = (0.25 + 0.75 * smoothstep(0.02, 0.6, au)) * layer.renderOpacity
  }

  /**
   * Morph the belt between true derived positions (0) and the mean-orbit diagram (1).
   *
   * At 1 every body sits on a circle of radius `a` at its own mean anomaly, and the
   * Kirkwood gaps appear as dark lanes because the resonances really are 93-100%
   * depleted in semi-major axis. This is a DIAGRAM, not a set of positions, and any
   * control that drives it must say so on screen.
   */
  setElementSpaceBlend(t: number): void {
    if (!this.beltMaterial) return
    this.beltMaterial.uniforms.uElementBlend.value = Math.min(Math.max(t, 0), 1)
  }

  dispose(): void {
    if (this.beltMesh) {
      this.beltMesh.geometry.dispose()
      this.beltMesh.removeFromParent()
      this.beltMesh = null
    }
    this.beltMaterial?.dispose()
    this.beltMaterial = null
    for (const line of this.orbitLines) {
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
      line.removeFromParent()
    }
    this.orbitLines.length = 0
    this.orbitSizes.length = 0
    for (const entry of this.named) this.engine.unregister(entry.node.id)
    this.named.length = 0
    this.quad?.dispose()
    this.quad = null
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(assetUrl(url))
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

async function fetchBuffer(url: string): Promise<ArrayBuffer | null> {
  try {
    const response = await fetch(assetUrl(url))
    if (!response.ok) return null
    return await response.arrayBuffer()
  } catch {
    return null
  }
}

/**
 * Julian Day to Unix milliseconds. TDB is treated as UTC here: the offset is about
 * 70 seconds, which moves a main-belt asteroid by roughly 1,200 km — four orders of
 * magnitude below one pixel at any view that shows the belt.
 */
function julianDayToMs(jd: number): number {
  return (jd - 2_440_587.5) * MS_PER_DAY
}

/** Prefer the published mean motion; fall back to the published period. */
function periodDaysOf(elements: NamedElements): number {
  if (typeof elements.nDegPerDay === 'number' && elements.nDegPerDay > 0) {
    return 360 / elements.nDegPerDay
  }
  if (typeof elements.periodYr === 'number' && elements.periodYr > 0) {
    return elements.periodYr * 365.25
  }
  return 0
}

/**
 * The size a comet with no measured nucleus is FRAMED at — never its radius.
 *
 * The median effective radius of a Jupiter-family nucleus is about 1.3 km (Lamy et al.
 * 2004; Fernandez et al. 2013), and the 34 comets here with no measured diameter are
 * overwhelmingly that population. It is a class median, not a measurement of the
 * object, which is why `radiusOf` reports it as `nominal` and returns it in
 * `framingRadiusMetres`: the camera needs a scale to stop at, and the inspector must
 * go on printing the catalogue's silence rather than this number.
 */
const NOMINAL_COMET_NUCLEUS_RADIUS_M = 1300

/**
 * Mean radius in metres.
 *
 * A measured diameter is used when SBDB has one. Otherwise the standard photometric
 * relation D = 1329 / sqrt(p) * 10^(-H/5) gives a diameter from absolute magnitude and
 * albedo — DERIVED, and doubly so when the albedo itself has to be assumed. Comets
 * carry total magnitude M1 rather than H, which describes the coma and says nothing
 * about the nucleus, so there is nothing to derive a nucleus size from.
 *
 * Those comets get radius 0, which is the honest number, and a `framingRadiusMetres`
 * of the class median, which is not a number about this object and is therefore in
 * the field that says so. The camera still stops at a sensible scale (AtlasViewer
 * prefers `radiusMetres` and falls back to the framing size), and the inspector goes
 * on printing '—' for a nucleus nobody has resolved.
 */
function radiusOf(object: NamedObject): {
  radiusMetres: number
  framingRadiusMetres?: number
  provenance: RadiusProvenance
} {
  const physical = object.physical
  if (physical?.diameterKm && physical.diameterKm > 0) {
    return { radiusMetres: (physical.diameterKm * 1000) / 2, provenance: 'measured' }
  }
  if (typeof physical?.H === 'number' && Number.isFinite(physical.H)) {
    const albedo = physical.albedo && physical.albedo > 0 ? physical.albedo : 0.15
    const diameterKm = (1329 / Math.sqrt(albedo)) * 10 ** (-physical.H / 5)
    if (diameterKm > 0 && Number.isFinite(diameterKm)) {
      return { radiusMetres: (diameterKm * 1000) / 2, provenance: 'derived' }
    }
  }
  if (isComet(object)) {
    return { radiusMetres: 0, framingRadiusMetres: NOMINAL_COMET_NUCLEUS_RADIUS_M, provenance: 'nominal' }
  }
  return { radiusMetres: 0, provenance: 'unknown' }
}

/**
 * Notability, used only to decide which bodies get a registry slot under the cap.
 *
 * Size first, because a 500 km asteroid matters more than a 5 km one; brightness as the
 * proxy when size is unmeasured; a floor for numbered periodic comets, which are
 * culturally notable regardless of how small their nucleus is.
 */
function notabilityScore(object: NamedObject): number {
  if (MUST_HAVE.has(object.id)) return 1e6
  const physical = object.physical

  if (isComet(object)) {
    // Numbered periodic comets outrank one-apparition ones; within each group, total
    // magnitude at the last apparition is the only brightness figure SBDB carries.
    const numbered = /^\d+P/.test(object.pdes ?? '')
    const brightness = typeof physical?.M1 === 'number' ? Math.max(0, 30 - physical.M1) : 0
    return (numbered ? 60 : 0) + brightness
  }

  if (physical?.diameterKm && physical.diameterKm > 0) return physical.diameterKm
  if (typeof physical?.H === 'number') {
    // Rough size proxy at an assumed 0.15 albedo, same relation as `radiusOf`.
    return 3430 * 10 ** (-physical.H / 5)
  }
  return 0
}

function isComet(object: NamedObject): boolean {
  return object.family === 'comet' || (object.kind ?? '').startsWith('c')
}

function displayName(object: NamedObject): string {
  if (isComet(object)) {
    // "67P/Churyumov-Gerasimenko" is the name people know; the bare name is not.
    return object.fullName ?? object.name ?? object.id
  }
  if (object.name) return object.pdes ? `${object.pdes} ${object.name}` : object.name
  return object.fullName ?? object.id
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

export default function createSmallBodiesModule(): AtlasModule {
  return new SmallBodiesModule()
}
