import * as THREE from 'three'
import type { AtlasModule, Engine, FrameContext, SceneNodeHandle } from '../../core/Engine'
import { KPC_M, MPC_M, type FrameId, type Vec3d, sphericalToCartesian, vec3d } from '../../core/world'
import type { DistanceKind } from '../../format/units'
import type { Provenance } from '../../data/scaleLadder'
import {
  comovingDistanceMpc,
  distanceModulusErrorFactor,
  hubbleLawDistanceMpc,
  redshiftFromCzKmS,
} from '../../astronomy/cosmology'

/**
 * The extragalactic module: everything outside the Milky Way.
 *
 * Four datasets, drawn in one layer (`cosmic`, one unit = 1 Mpc, de Vaucouleurs
 * supergalactic axes), and deliberately drawn so that they cannot be mistaken for each
 * other:
 *
 * | layer           | catalogue        | what the radius MEANS                        |
 * |-----------------|------------------|----------------------------------------------|
 * | Local Volume    | UNGC (869)       | TRGB / Cepheid geometry, the best there is    |
 * | Cosmic web      | Cosmicflows-4    | redshift-INDEPENDENT luminosity distance      |
 * | All-sky field   | 2MRS (44,599)    | redshift space — cz/H0, peculiar motion and all |
 * | The gap         | 2MRS selection   | nothing. No coverage. Drawn as a wedge.       |
 *
 * ## Three decisions carry this module
 *
 * **The Cosmicflows-4 groups are smears, not dots.** The mean fractional distance error
 * in that catalogue is 25%, and it is almost entirely radial: the transverse position of
 * a group on the sky is known to arcseconds while its distance is known to a quarter of
 * itself. Drawing a round dot asserts a precision the data does not have — and, worse,
 * it hides the structure, because the real cosmic web only emerges once each group is
 * drawn as the line segment it actually is. Each group is rendered from d/10^(e/5) to
 * d*10^(e/5): its own 1-sigma distance-modulus interval, mapped through the modulus.
 *
 * **The zone of avoidance is drawn.** 2MRS applies its |b| cut strictly, so inside the
 * wedge the catalogue does not hold sparse data — it holds no data (exactly zero
 * galaxies below the formal limit, which this module verifies against the binary on
 * load). An undrawn gap reads as a real void in the universe. The wedge is built from
 * the survey's own MEASURED per-longitude coverage limits in `2mrs.json`, not from a
 * guessed constant, and nothing is ever interpolated across it.
 *
 * **Nothing is placed without a distance.** 1,066 2MRS entries have no redshift and 26
 * more are blueshifted; none of them is given an invented radius. They are counted,
 * reported, and left out of the field rather than smeared onto a shell.
 *
 * Every registered node carries a `DistanceKind` and a `Provenance`, because past the
 * Local Group "distance" is not one thing and a number without its kind is a lie of
 * omission.
 */

const LAYER = 'cosmic' as const
const DATA = '/data/universe'

// ---------------------------------------------------------------------------
// Public shapes — what the UI can read off this module
// ---------------------------------------------------------------------------

/** A registered extragalactic object, with the provenance the inspector needs. */
export interface CosmosNode extends SceneNodeHandle {
  /** Which kind of distance put this object where it is. */
  distanceKind: DistanceKind
  provenance: Provenance
  /** Catalogue distance in Mpc, as published. */
  distanceMpc: number
  /** 1-sigma line-of-sight distance uncertainty in Mpc, or null when none is quoted. */
  distanceSigmaMpc: number | null
  /** Redshift, where the catalogue has one. */
  redshift: number | null
  /** Short catalogue tag: 'UNGC', 'CF4'. */
  catalogue: string
  /** Anything the user must be told about this specific object. */
  caveat?: string
}

/** One drawn dataset, for an evidence / coverage panel. */
export interface CosmosDataset {
  id: string
  label: string
  provenance: Provenance
  distanceKind: DistanceKind
  /** Objects actually drawn. */
  drawn: number
  /** Objects in the file that were deliberately NOT drawn, and why. */
  omitted: { count: number; reason: string }[]
  attribution: string
  note: string
}

// ---------------------------------------------------------------------------
// Catalogue manifests
// ---------------------------------------------------------------------------

interface BinaryField {
  name: string
  dtype: string
  byteOffset: number
  byteLength: number
  quantization?: { scale: number; offset: number } | null
}

interface BinaryManifest {
  recordCount: number
  totalBytes: number
  fields: BinaryField[]
  attribution?: string
  statistics?: Record<string, unknown>
}

interface TwoMrsManifest extends BinaryManifest {
  zoneOfAvoidance?: {
    formalSelection?: { rule?: string }
    measured?: {
      method?: string
      perLongitudeBin?: { lCenterDeg: number; measuredLimitAbsBDeg: number; formalLimitAbsBDeg: number }[]
      meanSkyFractionObscured?: number
    }
    actualGalaxyCountsInsideTheGap?: { belowFormalLimit?: number }
  }
}

interface UngcGalaxy {
  name: string
  ra: number
  dec: number
  distMpc: number
  distanceKind: string
  distanceMethod?: string
  absBMag?: number
  a26Kpc?: number
  vHelioKmS?: number
  tType?: number
  aliases?: string[]
}

interface UngcFile {
  meta?: { recordCount?: number; attribution?: string }
  galaxies?: UngcGalaxy[]
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/**
 * Colour encodes DISTANCE QUALITY, not morphology.
 *
 * A galaxy whose distance was measured from its own red-giant tip and a galaxy that
 * merely inherited its group's distance are drawn as different objects, because for an
 * atlas they are different objects. Warm and bright is a real measurement; cool and
 * dim is an inference. The glyph in the label layer carries class; this carries trust.
 */
const UNGC_PALETTE = [
  new THREE.Color('#ffd9b4'), // 0 geometric: TRGB, Cepheid, maser, eclipsing binary
  new THREE.Color('#f4a9cf'), // 1 luminosity: a secondary standard candle
  new THREE.Color('#8f9bc4'), // 2 model: distance inherited from the host group
  new THREE.Color('#6f8a9b'), // 3 redshift: a Hubble-flow estimate, not a measurement
]

const CF4_COLOR = new THREE.Color('#9ed2ff')
/** Groups whose distance modulus carries no quoted uncertainty. */
const CF4_COLOR_UNQUOTED = new THREE.Color('#5d7f99')
const TWOMRS_COLOR = new THREE.Color('#7b8cb0')
const ZOA_COLOR = new THREE.Color('#ff8f6a')

/** Palette index by UNGC distance kind, plus the DistanceKind it maps to. */
const UNGC_KINDS: Record<string, { palette: number; kind: DistanceKind; provenance: Provenance }> = {
  trgb_cepheid: { palette: 0, kind: 'geometric', provenance: 'measured' },
  geometric: { palette: 0, kind: 'geometric', provenance: 'measured' },
  luminosity_distance: { palette: 1, kind: 'luminosity', provenance: 'measured' },
  inherited: { palette: 2, kind: 'model', provenance: 'derived' },
  redshift_space: { palette: 3, kind: 'redshift', provenance: 'derived' },
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

/**
 * The point field, for UNGC and 2MRS.
 *
 * Instanced quads rather than `gl.POINTS`, for the reasons spelled out in the stars
 * module: implementations clip a point on its centre, and `ALIASED_POINT_SIZE_RANGE`
 * tops out at 64 on Apple silicon.
 *
 * Apparent magnitude is recomputed from the TRUE camera-to-galaxy distance every
 * frame, exactly as for stars. Flying out to the Virgo cluster has to make Virgo's
 * members brighten and the Local Volume dwarfs disappear, or the depth is a painting.
 */
const FIELD_VERTEX = /* glsl */ `
  attribute vec3 aPos;       // layer-local, Mpc
  attribute float aAbsMag;   // absolute magnitude (B for UNGC, Ks for 2MRS)
  attribute float aKind;     // palette index

  uniform vec3 uColors[4];
  uniform float uPixelHeight;
  uniform float uMagLimit;
  uniform float uMinRadiusPx;
  uniform float uMaxRadiusPx;
  uniform float uGain;
  uniform float uOpacity;

  varying vec3 vColor;
  varying float vIntensity;
  varying vec2 vQuad;

  void main() {
    vQuad = position.xy;

    vec4 viewPosition = modelViewMatrix * vec4(aPos, 1.0);
    float distanceMpc = max(length(viewPosition.xyz), 1e-6);

    // 1 Mpc = 1e6 pc, so the distance modulus picks up a constant +25.
    float apparent = aAbsMag + 5.0 * (log(distanceMpc) / 2.302585092994046) + 25.0;
    float headroom = uMagLimit - apparent;

    if (headroom < 0.0 || uOpacity <= 0.001) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);  // collapsed: rasterises nothing
      return;
    }

    float radiusPx = clamp(uMinRadiusPx + 0.40 * headroom, uMinRadiusPx, uMaxRadiusPx);
    vIntensity = uGain * uOpacity * pow(2.512, min(headroom, 5.0)) * 0.008;
    vColor = uColors[int(aKind)];

    vec4 clip = projectionMatrix * viewPosition;
    clip.xy += position.xy * (2.0 * radiusPx / uPixelHeight) * clip.w;
    gl_Position = clip;
  }
`

const FIELD_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vIntensity;
  varying vec2 vQuad;

  void main() {
    float r2 = dot(vQuad, vQuad);
    if (r2 > 1.0) discard;
    float falloff = exp(-3.6 * r2);
    gl_FragColor = vec4(vColor * vIntensity * falloff, falloff);
  }
`

/**
 * The Cosmicflows-4 smear.
 *
 * Each instance is a screen-space capsule running from the near end to the far end of
 * the group's own 1-sigma distance interval. The quad is built in pixel space and
 * emitted with w = 1, which makes the capsule maths exact (no perspective-correct
 * interpolation to fight) and costs nothing here, because the whole layer is additive
 * with the depth test off. Instances with either endpoint behind the camera collapse.
 */
const SMEAR_VERTEX = /* glsl */ `
  attribute vec3 aNear;    // layer-local Mpc, observer-facing end of the interval
  attribute vec3 aFar;     // layer-local Mpc, far end
  attribute float aWeight; // log10(members + 1), a display weight — NOT a luminosity
  attribute float aFlag;   // 1.0 when the catalogue quotes no distance uncertainty

  uniform vec2 uViewportPx;
  uniform float uHalfWidthPx;
  uniform float uGain;
  uniform float uOpacity;
  uniform float uRefDistanceMpc;
  uniform float uCullIntensity;
  uniform vec3 uColor;
  uniform vec3 uColorUnquoted;

  varying vec2 vLocalPx;   // (along the axis from the near end, perpendicular)
  varying float vLengthPx;
  varying float vHalfWidthPx;
  varying vec3 vColor;
  varying float vIntensity;

  void main() {
    vec4 clipA = projectionMatrix * modelViewMatrix * vec4(aNear, 1.0);
    vec4 clipB = projectionMatrix * modelViewMatrix * vec4(aFar, 1.0);

    if (clipA.w <= 0.0 || clipB.w <= 0.0 || uOpacity <= 0.001) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vec2 halfViewport = 0.5 * uViewportPx;
    vec2 pixelA = (clipA.xy / clipA.w) * halfViewport;
    vec2 pixelB = (clipB.xy / clipB.w) * halfViewport;

    vec2 delta = pixelB - pixelA;
    float lengthPx = length(delta);
    vec2 axis = lengthPx > 1e-3 ? delta / lengthPx : vec2(1.0, 0.0);
    vec2 perpendicular = vec2(-axis.y, axis.x);

    float halfWidth = uHalfWidthPx;
    float t = position.y * 0.5 + 0.5;
    vec2 pixel = mix(pixelA, pixelB, t) + axis * (position.y * halfWidth) + perpendicular * (position.x * halfWidth);

    vLocalPx = vec2(t * lengthPx + position.y * halfWidth, position.x * halfWidth);
    vLengthPx = lengthPx;
    vHalfWidthPx = halfWidth;

    // Brightness is a DENSITY, not a total. A group's distance is one unit of
    // probability smeared along the line of sight, so a smear ten times longer is ten
    // times fainter per pixel. That single division is what turns a field of
    // warp-speed streaks into the cosmic web: well-measured groups stay compact and
    // bright, badly-measured ones dissolve into the haze they actually are.
    float density = (2.0 * halfWidth) / (2.0 * halfWidth + lengthPx);
    float viewDistance = length((modelViewMatrix * vec4(0.5 * (aNear + aFar), 1.0)).xyz);
    float weight = 0.22 + 0.78 * clamp(aWeight / 2.2, 0.0, 1.0);
    float falloff = uRefDistanceMpc / (uRefDistanceMpc + viewDistance);
    vIntensity = uGain * uOpacity * weight * falloff * density;
    vColor = mix(uColor, uColorUnquoted, aFlag);
    if (aFlag > 0.5) vIntensity *= 0.55;

    // Below this the smear contributes less than a 255th of a level per pixel but
    // still costs its full fill rate, and a few thousand screen-long quads is the
    // difference between 60 and 27 fps. Dropping them rather than shortening them is
    // the honest version of the same saving: a clipped smear would understate the
    // uncertainty, an absent one only understates the brightness of something already
    // invisible.
    if (vIntensity < uCullIntensity) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    gl_Position = vec4(pixel / halfViewport, 0.0, 1.0);
  }
`

const SMEAR_FRAGMENT = /* glsl */ `
  varying vec2 vLocalPx;
  varying float vLengthPx;
  varying float vHalfWidthPx;
  varying vec3 vColor;
  varying float vIntensity;

  void main() {
    // Distance to the capsule's axis, in half-widths.
    float along = vLocalPx.x;
    float overshoot = max(max(-along, along - vLengthPx), 0.0);
    float distance = sqrt(vLocalPx.y * vLocalPx.y + overshoot * overshoot) / max(vHalfWidthPx, 1e-4);
    float falloff = exp(-3.0 * distance * distance);
    if (falloff < 0.004) discard;
    // Additive blending in three.js is (SrcAlpha, One), so the alpha channel is part
    // of the multiply: intensity belongs in the colour, not in both.
    gl_FragColor = vec4(vColor * vIntensity * falloff, falloff);
  }
`

/**
 * The zone of avoidance.
 *
 * Two conical surfaces at the survey's own measured |b| limit, with a rim closing the
 * far end. Hazard striping along the line of sight, because this is not an object —
 * it is the shape of what cannot be seen.
 */
const ZOA_VERTEX = /* glsl */ `
  attribute float aFade;
  attribute float aRadial;   // 0..1 along the line of sight

  varying float vFade;
  varying float vRadial;
  varying float vRim;

  void main() {
    vFade = aFade;
    vRadial = aRadial;
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    // Rim term. These surfaces are enormous and the camera is usually inside their
    // radius, so shading them flat paints a brown wash over half the sky. Weighting
    // by how edge-on the surface is leaves the silhouette — which is the only part
    // that says anything about the shape of the gap.
    vec3 n = normalize(normalMatrix * normal);
    vec3 v = normalize(-viewPosition.xyz);
    vRim = 1.0 - abs(dot(n, v));
    gl_Position = projectionMatrix * viewPosition;
  }
`

const ZOA_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;

  varying float vFade;
  varying float vRadial;
  varying float vRim;

  void main() {
    // A slow radial banding, so the wedge reads as hatched-off territory rather than
    // as an object with a surface.
    float hatch = 0.78 + 0.22 * sin(vRadial * 46.0);
    float alpha = uOpacity * vFade * hatch * (0.10 + 0.90 * pow(vRim, 2.5));
    if (alpha < 0.0015) discard;
    // (SrcAlpha, One): the colour is already scaled by alpha at blend time.
    gl_FragColor = vec4(uColor, alpha);
  }
`

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

interface FieldMesh {
  mesh: THREE.Mesh
  material: THREE.ShaderMaterial
  count: number
}

export class CosmosModule implements AtlasModule {
  id = 'cosmos'

  /** Provenance for every dataset this module drew. Read by the evidence panel. */
  readonly datasets: CosmosDataset[] = []
  /** Registered extragalactic objects, by id. */
  readonly nodes = new Map<string, CosmosNode>()

  private engine!: Engine
  private quad: THREE.BufferGeometry | null = null
  private ungcField: FieldMesh | null = null
  private twoMrsField: FieldMesh | null = null
  private cf4Field: FieldMesh | null = null
  private zoaSurface: THREE.Mesh | null = null
  private zoaEdges: THREE.LineSegments | null = null
  private zoaMaterials: THREE.Material[] = []
  private disposed = false

  /** Reused during construction only; never allocated in a frame. */
  private readonly scratchWorld: Vec3d = vec3d()
  private readonly scratchLocal = new THREE.Vector3()

  async init(engine: Engine): Promise<void> {
    this.engine = engine

    let layer
    try {
      layer = engine.layer(LAYER)
    } catch (error) {
      console.warn('[omniatlas] cosmos: no "cosmic" layer; module idle', error)
      return
    }

    this.quad = new THREE.BufferGeometry()
    this.quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3))
    this.quad.setIndex([0, 1, 2, 0, 2, 3])

    // Everything that registers a selectable node is awaited here, because the viewer
    // snapshots the registry into the label engine exactly once after module load.
    // Only the 624 KB 2MRS point binary — which registers nothing — streams in behind.
    await this.loadUngc(layer)
    if (engine.isDisposed || this.disposed) return

    await this.loadCf4(layer)
    if (engine.isDisposed || this.disposed) return

    await this.loadZoneOfAvoidance(layer)
    if (engine.isDisposed || this.disposed) return

    void this.load2Mrs(layer).catch((error) => {
      console.warn('[omniatlas] cosmos: 2MRS field unavailable', error)
    })
  }

  // -------------------------------------------------------------------------
  // UNGC — the Local Volume, where galaxies still have identities
  // -------------------------------------------------------------------------

  private async loadUngc(layer: ReturnType<Engine['layer']>): Promise<void> {
    const file = await fetchJson<UngcFile>(`${DATA}/ungc.json`)
    if (!file || this.engine.isDisposed || this.disposed) return
    const galaxies = Array.isArray(file.galaxies) ? file.galaxies : null
    if (!galaxies || galaxies.length === 0) {
      console.warn('[omniatlas] cosmos: ungc.json has no galaxies array')
      return
    }

    const positions: number[] = []
    const absMags: number[] = []
    const kinds: number[] = []

    let skippedMilkyWay = 0
    let skippedNoDistance = 0
    let missingMagnitude = 0
    let unknownKind = 0
    const kindCounts = new Map<DistanceKind, number>()

    for (const galaxy of galaxies) {
      if (!galaxy || typeof galaxy.name !== 'string') continue

      // The Milky Way is in this catalogue as a row. It is not an object out there —
      // it is where the camera starts, and the galaxy module owns it.
      if (galaxy.name === 'Milky Way') {
        skippedMilkyWay++
        continue
      }
      const { ra, dec, distMpc } = galaxy
      if (!Number.isFinite(ra) || !Number.isFinite(dec) || !(distMpc > 0)) {
        skippedNoDistance++
        continue
      }

      const mapping = UNGC_KINDS[galaxy.distanceKind]
      if (!mapping) unknownKind++
      const resolved = mapping ?? { palette: 2, kind: 'model' as DistanceKind, provenance: 'derived' as Provenance }
      kindCounts.set(resolved.kind, (kindCounts.get(resolved.kind) ?? 0) + 1)

      // UNGC is ICRS equatorial; the layer does the rotation into supergalactic.
      sphericalToCartesian(this.scratchWorld, ra, dec, distMpc * MPC_M)
      layer.toLocal(this.scratchLocal, this.scratchWorld, 'icrf')
      positions.push(this.scratchLocal.x, this.scratchLocal.y, this.scratchLocal.z)

      // A26 is the isophotal diameter at 26 mag/arcsec^2 — a real, published size.
      // Galaxies without one are registered point-like rather than given a guess.
      const radiusMetres = Number.isFinite(galaxy.a26Kpc) ? (galaxy.a26Kpc as number) * 0.5 * KPC_M : 0

      let absMag = galaxy.absBMag
      if (!Number.isFinite(absMag)) {
        missingMagnitude++
        // No B magnitude: drawn at a fixed faint value so the object is not invented
        // as bright. It keeps its marker and its label, so it is never lost.
        absMag = -11
      }
      absMags.push(absMag as number)
      kinds.push(resolved.palette)

      const node: CosmosNode = {
        id: `ungc:${slug(galaxy.name)}`,
        worldPosition: { x: this.scratchWorld.x, y: this.scratchWorld.y, z: this.scratchWorld.z },
        frame: 'icrf' as FrameId,
        radiusMetres,
        layer: LAYER,
        objectClass: 'galaxy',
        name: displayName(galaxy.name),
        parentId: null,
        distanceKind: resolved.kind,
        provenance: resolved.provenance,
        distanceMpc: distMpc,
        distanceSigmaMpc: null,
        redshift: Number.isFinite(galaxy.vHelioKmS) ? redshiftFromCzKmS(galaxy.vHelioKmS as number) : null,
        catalogue: 'UNGC',
        caveat:
          resolved.kind === 'model'
            ? 'Distance adopted from the host group, not measured for this galaxy.'
            : resolved.kind === 'redshift'
              ? 'Distance from recession velocity via a Hubble-flow model, not a measurement.'
              : undefined,
      }
      this.nodes.set(node.id, node)
      this.engine.register(node)
    }

    this.ungcField = this.buildPointField(layer, positions, absMags, kinds, {
      name: 'cosmos:ungc',
      colors: UNGC_PALETTE,
      magLimit: 23,
      minRadiusPx: 1.1,
      maxRadiusPx: 26,
      gain: 1,
      renderOrder: -6,
    })

    const omitted: CosmosDataset['omitted'] = []
    if (skippedMilkyWay > 0)
      omitted.push({ count: skippedMilkyWay, reason: 'the Milky Way itself — drawn by the galaxy module, not here' })
    if (skippedNoDistance > 0)
      omitted.push({ count: skippedNoDistance, reason: 'no usable position or distance in the catalogue row' })

    this.datasets.push({
      id: 'ungc',
      label: 'Local Volume galaxies (UNGC)',
      provenance: 'measured',
      distanceKind: 'geometric',
      drawn: absMags.length,
      omitted,
      attribution:
        'Updated Nearby Galaxy Catalog — Karachentsev, Makarov & Kaisina (2013), AJ 145, 101. Retrieved from VizieR (CDS).',
      note:
        `${kindCounts.get('geometric') ?? 0} TRGB/Cepheid/geometric, ${kindCounts.get('luminosity') ?? 0} secondary ` +
        `standard candle, ${kindCounts.get('model') ?? 0} inherited from the host group, ` +
        `${kindCounts.get('redshift') ?? 0} from recession velocity. Colour encodes which.`,
    })

    console.info(
      `[omniatlas] cosmos: UNGC ${absMags.length} galaxies drawn` +
        (missingMagnitude > 0 ? `, ${missingMagnitude} without a B magnitude drawn at a fixed faint value` : '') +
        (unknownKind > 0 ? `, ${unknownKind} with an unrecognised distance kind treated as a model distance` : ''),
    )
  }

  // -------------------------------------------------------------------------
  // Cosmicflows-4 — the cosmic web, drawn as the uncertainty it is
  // -------------------------------------------------------------------------

  private async loadCf4(layer: ReturnType<Engine['layer']>): Promise<void> {
    const loaded = await fetchBinary(`${DATA}/cf4`)
    if (!loaded || this.engine.isDisposed || this.disposed) return
    const { manifest, buffer } = loaded

    const count = manifest.recordCount
    const distMpc = readFloat32(manifest, buffer, 'distMpc', count)
    const pgc = readUint32(manifest, buffer, 'pgc', count)
    const sgl = readUint16(manifest, buffer, 'sgl', count)
    const sgb = readInt16(manifest, buffer, 'sgb', count)
    const eDMav = readUint16(manifest, buffer, 'eDMav', count)
    const ngal = readUint16(manifest, buffer, 'ngal', count)
    const kindEnum = readUint8(manifest, buffer, 'distanceKind', count)
    if (!distMpc || !pgc || !sgl || !sgb || !eDMav || !ngal || !kindEnum) {
      console.warn('[omniatlas] cosmos: cf4.bin does not match its manifest; skipping')
      return
    }

    const sglScale = quantScale(manifest, 'sgl')
    const sgbScale = quantScale(manifest, 'sgb')
    const eScale = quantScale(manifest, 'eDMav')

    // Decode check against a known object before anything is drawn. PGC 41220 is the
    // richest nearby group in the catalogue (164 members, 16.2 Mpc); if the
    // struct-of-arrays offsets were read as interleaved records this would not match.
    const probe = indexOfValue(pgc, 41220)
    if (probe >= 0) {
      const ok = Math.abs(distMpc[probe] - 16.2) < 0.05 && ngal[probe] === 164
      if (!ok) {
        console.warn(
          `[omniatlas] cosmos: CF4 decode check FAILED (PGC 41220 -> ${distMpc[probe].toFixed(2)} Mpc, ` +
            `${ngal[probe]} members; expected 16.2 Mpc, 164). Not drawing the field.`,
        )
        return
      }
    }

    /**
     * Two records in the upstream VizieR table carry wrong supergalactic coordinates —
     * PGC 41361's SGL/SGB are its GALACTIC coordinates — and the manifest documents
     * both. They are not drawn where the file puts them. PGC 41220 is the Virgo
     * Cluster and is re-registered below at the cluster's true position, labelled as
     * an override; PGC 41361 is dropped.
     */
    const VIRGO_PGC = 41220
    const BAD_PGC = 41361
    const VIRGO_SGL = 102.9
    const VIRGO_SGB = -2.3

    // The median quoted uncertainty, computed from the file rather than assumed. It
    // stands in for the 228 groups that quote none, which are then drawn dimmer and
    // in a different colour so the substitution is visible rather than silent.
    const quoted: number[] = []
    for (let i = 0; i < count; i++) if (eDMav[i] > 0) quoted.push(eDMav[i])
    quoted.sort((a, b) => a - b)
    const medianErrorMag = (quoted.length > 0 ? quoted[quoted.length >> 1] : 0) * eScale

    const near = new Float32Array(count * 3)
    const far = new Float32Array(count * 3)
    const weight = new Float32Array(count)
    const flag = new Float32Array(count)

    let drawn = 0
    let unquoted = 0
    let dropped = 0
    let calibrated = 0

    for (let i = 0; i < count; i++) {
      const distance = distMpc[i]
      if (!(distance > 0)) {
        dropped++
        continue
      }
      if (pgc[i] === BAD_PGC || pgc[i] === VIRGO_PGC) {
        dropped++
        continue
      }

      const errorMag = eDMav[i] * eScale
      const estimated = errorMag <= 0
      if (estimated) unquoted++
      if (kindEnum[i] === 1) calibrated++

      const factor = distanceModulusErrorFactor(estimated ? medianErrorMag : errorMag)

      sphericalToCartesian(this.scratchWorld, sgl[i] * sglScale, sgb[i] * sgbScale, MPC_M)
      // The unit vector is exact; only the radius is uncertain, which is precisely
      // why the smear runs along it and not across it.
      layer.toLocal(this.scratchLocal, this.scratchWorld, 'supergalactic')
      const unitX = this.scratchLocal.x
      const unitY = this.scratchLocal.y
      const unitZ = this.scratchLocal.z

      const rNear = distance / factor
      const rFar = distance * factor
      const o = drawn * 3
      near[o] = unitX * rNear
      near[o + 1] = unitY * rNear
      near[o + 2] = unitZ * rNear
      far[o] = unitX * rFar
      far[o + 1] = unitY * rFar
      far[o + 2] = unitZ * rFar
      weight[drawn] = Math.log10(ngal[i] + 1)
      flag[drawn] = estimated ? 1 : 0
      drawn++
    }

    this.cf4Field = this.buildSmearField(layer, near, far, weight, flag, drawn)

    // The richest groups, registered so they can be found and flown to. The catalogue
    // names them only by the PGC number of their dominant galaxy, so that is what the
    // label says — inventing cluster names the file does not contain is not an option.
    const order: number[] = []
    for (let i = 0; i < count; i++) if (pgc[i] !== BAD_PGC && distMpc[i] > 0) order.push(i)
    order.sort((a, b) => ngal[b] - ngal[a])

    for (const i of order.slice(0, 14)) {
      const isVirgo = pgc[i] === VIRGO_PGC
      const lon = isVirgo ? VIRGO_SGL : sgl[i] * sglScale
      const lat = isVirgo ? VIRGO_SGB : sgb[i] * sgbScale
      const errorMag = eDMav[i] * eScale
      sphericalToCartesian(this.scratchWorld, lon, lat, distMpc[i] * MPC_M)
      const node: CosmosNode = {
        id: `cf4:pgc${pgc[i]}`,
        worldPosition: { x: this.scratchWorld.x, y: this.scratchWorld.y, z: this.scratchWorld.z },
        frame: 'supergalactic',
        radiusMetres: 0,
        layer: LAYER,
        objectClass: 'cluster',
        name: isVirgo ? 'Virgo Cluster' : `Group PGC ${pgc[i]} (${ngal[i]} galaxies)`,
        parentId: null,
        distanceKind: 'luminosity',
        provenance: isVirgo ? 'derived' : 'measured',
        distanceMpc: distMpc[i],
        distanceSigmaMpc: errorMag > 0 ? distMpc[i] * (distanceModulusErrorFactor(errorMag) - 1) : null,
        redshift: null,
        catalogue: 'CF4',
        caveat: isVirgo
          ? 'Position overridden: the source table stores wrong supergalactic coordinates for this row ' +
            '(see knownSourceDefects in cf4.json). Distance and membership are the published values.'
          : 'Redshift-independent luminosity distance, calibrated to H0 = 74.6 rather than the Planck 67.4 used elsewhere.',
      }
      this.nodes.set(node.id, node)
      this.engine.register(node)
    }

    const omitted: CosmosDataset['omitted'] = [
      { count: 2, reason: 'two records with defective supergalactic coordinates in the source table' },
    ]
    if (dropped > 2) omitted.push({ count: dropped - 2, reason: 'no positive distance in the catalogue row' })

    this.datasets.push({
      id: 'cf4',
      label: 'Cosmicflows-4 groups',
      provenance: 'measured',
      distanceKind: 'luminosity',
      drawn,
      omitted,
      attribution: 'Cosmicflows-4 — Tully, Kourkchi, Courtois et al. (2023), ApJ 944, 94. Retrieved from VizieR (CDS).',
      note:
        `Each group is drawn as its own 1-sigma distance interval along the line of sight, not as a point. ` +
        `${calibrated} groups contain a TRGB/Cepheid calibrator. ${unquoted} groups quote no uncertainty and are ` +
        `drawn dimmer, at the catalogue median of ${medianErrorMag.toFixed(2)} mag. Distances are calibrated to ` +
        `H0 = 74.6 km/s/Mpc, about 10% off the Planck 67.4 used for redshift distances elsewhere in this module.`,
    })

    console.info(
      `[omniatlas] cosmos: CF4 ${drawn} groups drawn as radial smears ` +
        `(${unquoted} with no quoted uncertainty, 2 dropped for defective coordinates)`,
    )
  }

  // -------------------------------------------------------------------------
  // 2MRS — the all-sky field, in redshift space
  // -------------------------------------------------------------------------

  private async load2Mrs(layer: ReturnType<Engine['layer']>): Promise<void> {
    const loaded = await fetchBinary<TwoMrsManifest>(`${DATA}/2mrs`)
    if (!loaded || this.engine.isDisposed || this.disposed) return
    const { manifest, buffer } = loaded

    const count = manifest.recordCount
    const cz = readInt32(manifest, buffer, 'cz', count)
    const glon = readUint16(manifest, buffer, 'glon', count)
    const glat = readInt16(manifest, buffer, 'glat', count)
    const ktmag = readUint16(manifest, buffer, 'ktmag', count)
    const flags = readUint8(manifest, buffer, 'flags', count)
    if (!cz || !glon || !glat || !ktmag || !flags) {
      console.warn('[omniatlas] cosmos: 2mrs.bin does not match its manifest; skipping')
      return
    }

    const lonScale = quantScale(manifest, 'glon')
    const latScale = quantScale(manifest, 'glat')
    const magScale = quantScale(manifest, 'ktmag')

    const positions = new Float32Array(count * 3)
    const absMags = new Float32Array(count)
    const kinds = new Float32Array(count)

    let drawn = 0
    let noRedshift = 0
    let nonPositive = 0
    let insideFormalGap = 0
    let highZ = 0

    for (let i = 0; i < count; i++) {
      if ((flags[i] & 1) === 0) {
        // No redshift at all. There is no honest radius for these, so they are not
        // drawn — not projected onto a shell, not interpolated from neighbours.
        noRedshift++
        continue
      }
      const velocity = cz[i]
      if (velocity <= 0) {
        // Blueshifted or at rest: dominated by peculiar motion, so redshift space has
        // nothing to say about where they are.
        nonPositive++
        continue
      }

      const longitude = glon[i] * lonScale
      const latitude = glat[i] * latScale
      if (Math.abs(latitude) < 5) insideFormalGap++

      // Heliocentric cz to the CMB frame, so this field and Cosmicflows-4 share a
      // rest frame. DERIVED: the solar apex is a model of our own motion.
      const velocityCmb = velocity + solarApexProjection(longitude, latitude)
      if (velocityCmb <= 0) {
        nonPositive++
        continue
      }

      let distance: number
      if (velocityCmb < 30_000) {
        distance = hubbleLawDistanceMpc(velocityCmb)
      } else {
        highZ++
        // Quantised before the integral so the memo table stays small; 1e-5 in z is a
        // 0.003% distance error, three orders below the peculiar-velocity error.
        const z = Math.round(redshiftFromCzKmS(velocityCmb) * 1e5) / 1e5
        distance = comovingDistanceMpc(z)
      }
      if (!(distance > 0)) continue

      sphericalToCartesian(this.scratchWorld, longitude, latitude, distance * MPC_M)
      layer.toLocal(this.scratchLocal, this.scratchWorld, 'galactic')
      const o = drawn * 3
      positions[o] = this.scratchLocal.x
      positions[o + 1] = this.scratchLocal.y
      positions[o + 2] = this.scratchLocal.z

      // Ks is an apparent magnitude as seen from Earth; the shader needs an absolute
      // one so that brightness responds to where the CAMERA is, not where Earth is.
      const apparentKs = ktmag[i] === 65535 ? 11.75 : ktmag[i] * magScale
      absMags[drawn] = apparentKs - 5 * Math.log10(distance) - 25
      kinds[drawn] = 0
      drawn++
    }

    if (this.engine.isDisposed || this.disposed) return

    // The gap is a claim the data must back: the catalogue applies its |b| cut
    // strictly, so a single galaxy below the formal limit would mean the wedge drawn
    // over this field is in the wrong place.
    const expectedInside = manifest.zoneOfAvoidance?.actualGalaxyCountsInsideTheGap?.belowFormalLimit ?? 0
    if (insideFormalGap !== expectedInside) {
      console.warn(
        `[omniatlas] cosmos: 2MRS has ${insideFormalGap} galaxies at |b| < 5 but the manifest says ` +
          `${expectedInside}. The zone-of-avoidance wedge may not match the data.`,
      )
    }

    this.twoMrsField = this.buildPointField(
      layer,
      positions.subarray(0, drawn * 3),
      absMags.subarray(0, drawn),
      kinds.subarray(0, drawn),
      {
        name: 'cosmos:2mrs',
        colors: [TWOMRS_COLOR, TWOMRS_COLOR, TWOMRS_COLOR, TWOMRS_COLOR],
        magLimit: 16.5,
        minRadiusPx: 0.7,
        maxRadiusPx: 6,
        gain: 0.8,
        renderOrder: -8,
      },
    )

    this.datasets.push({
      id: '2mrs',
      label: '2MASS Redshift Survey (redshift space)',
      provenance: 'derived',
      distanceKind: 'redshift',
      drawn,
      omitted: [
        { count: noRedshift, reason: 'no redshift measured — no honest distance exists, so they are not placed' },
        { count: nonPositive, reason: 'blueshifted or at rest: peculiar motion, not distance' },
      ],
      attribution: '2MASS Redshift Survey — Huchra, Macri, Masters et al. (2012), ApJS 199, 26. Retrieved from VizieR (CDS).',
      note:
        'REDSHIFT SPACE. Radius is cz/H0 (Planck H0 = 67.4) below cz = 30,000 km/s and a comoving integral above, ' +
        `after correcting cz to the CMB rest frame. It contains peculiar velocity: clusters are stretched into ` +
        `Fingers of God along the line of sight, and that elongation is an artefact of the method, not a shape. ` +
        `${highZ} galaxies needed the comoving integral.`,
    })

    console.info(
      `[omniatlas] cosmos: 2MRS ${drawn} galaxies drawn in redshift space; ` +
        `${noRedshift} with no redshift and ${nonPositive} non-positive cz were NOT placed`,
    )
  }

  // -------------------------------------------------------------------------
  // The zone of avoidance
  // -------------------------------------------------------------------------

  /**
   * The single most important honesty feature here.
   *
   * The limits come from the survey's own measured per-longitude coverage in
   * `2mrs.json` — a step function over 36 longitude bins, used as a step function.
   * Smoothing it would be inventing coverage at the bin edges.
   */
  private async loadZoneOfAvoidance(layer: ReturnType<Engine['layer']>): Promise<void> {
    const manifest = await fetchJson<TwoMrsManifest>(`${DATA}/2mrs.json`)
    if (!manifest || this.engine.isDisposed || this.disposed) return

    const bins = manifest.zoneOfAvoidance?.measured?.perLongitudeBin
    if (!Array.isArray(bins) || bins.length === 0) {
      console.warn('[omniatlas] cosmos: 2mrs.json carries no measured zone-of-avoidance limits; wedge not drawn')
      return
    }
    const sorted = [...bins].filter((b) => Number.isFinite(b.lCenterDeg)).sort((a, b) => a.lCenterDeg - b.lCenterDeg)
    if (sorted.length === 0) return
    const binWidth = 360 / sorted.length

    // How far out to draw. The survey's own reach: the largest recession velocity in
    // the catalogue, through the same Hubble law the field itself uses.
    const stats = manifest.statistics as { czKmS?: { max?: number } } | undefined
    const reachMpc = hubbleLawDistanceMpc(stats?.czKmS?.max ?? 30_000)

    const RADIAL_STEPS = 10
    const LON_STEPS = 4

    const vertices: number[] = []
    const fades: number[] = []
    const radials: number[] = []
    const indices: number[] = []
    const edges: number[] = []

    /** A boundary segment, drawn at the radius where the wedge is at full opacity. */
    const pushEdge = (lonA: number, latA: number, lonB: number, latB: number): void => {
      for (const [lon, lat] of [
        [lonA, latA],
        [lonB, latB],
      ]) {
        sphericalToCartesian(this.scratchWorld, lon, lat, 0.45 * reachMpc * MPC_M)
        layer.toLocal(this.scratchLocal, this.scratchWorld, 'galactic')
        edges.push(this.scratchLocal.x, this.scratchLocal.y, this.scratchLocal.z)
      }
    }

    const pushVertex = (lonDeg: number, latDeg: number, radiusFraction: number): number => {
      sphericalToCartesian(this.scratchWorld, lonDeg, latDeg, radiusFraction * reachMpc * MPC_M)
      layer.toLocal(this.scratchLocal, this.scratchWorld, 'galactic')
      const index = vertices.length / 3
      vertices.push(this.scratchLocal.x, this.scratchLocal.y, this.scratchLocal.z)
      fades.push(radialFade(radiusFraction))
      radials.push(radiusFraction)
      return index
    }

    for (const bin of sorted) {
      const limit = Math.abs(bin.measuredLimitAbsBDeg ?? bin.formalLimitAbsBDeg ?? 5)
      const lon0 = bin.lCenterDeg - binWidth / 2
      // The two surfaces that bound the gap, at +limit and -limit. Between them the
      // survey saw nothing at all, and nothing at all is drawn.
      for (const sign of [1, -1]) {
        const lat = sign * limit
        const grid: number[][] = []
        for (let li = 0; li <= LON_STEPS; li++) {
          const lon = lon0 + (binWidth * li) / LON_STEPS
          const column: number[] = []
          for (let ri = 0; ri <= RADIAL_STEPS; ri++) column.push(pushVertex(lon, lat, ri / RADIAL_STEPS))
          grid.push(column)
        }
        for (let li = 0; li < LON_STEPS; li++) {
          for (let ri = 0; ri < RADIAL_STEPS; ri++) {
            const a = grid[li][ri]
            const b = grid[li + 1][ri]
            const c = grid[li + 1][ri + 1]
            const d = grid[li][ri + 1]
            indices.push(a, b, c, a, c, d)
          }
        }
        // A boundary line along the far edge of each surface, so the limit reads as a
        // hard edge rather than as a soft gradient — because it is one.
        for (let li = 0; li < LON_STEPS; li++) {
          const lonA = lon0 + (binWidth * li) / LON_STEPS
          const lonB = lon0 + (binWidth * (li + 1)) / LON_STEPS
          pushEdge(lonA, lat, lonB, lat)
        }
      }

      // The rim that closes the far mouth of the wedge.
      const rim: number[][] = []
      for (let li = 0; li <= LON_STEPS; li++) {
        const lon = lon0 + (binWidth * li) / LON_STEPS
        const column: number[] = []
        for (let bi = 0; bi <= 4; bi++) {
          const lat = -limit + (2 * limit * bi) / 4
          sphericalToCartesian(this.scratchWorld, lon, lat, reachMpc * MPC_M)
          layer.toLocal(this.scratchLocal, this.scratchWorld, 'galactic')
          column.push(vertices.length / 3)
          vertices.push(this.scratchLocal.x, this.scratchLocal.y, this.scratchLocal.z)
          fades.push(radialFade(1))
          radials.push(1)
        }
        rim.push(column)
      }
      for (let li = 0; li < LON_STEPS; li++) {
        for (let bi = 0; bi < 4; bi++) {
          const a = rim[li][bi]
          const b = rim[li + 1][bi]
          const c = rim[li + 1][bi + 1]
          const d = rim[li][bi + 1]
          indices.push(a, b, c, a, c, d)
        }
      }
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    geometry.setAttribute('aFade', new THREE.Float32BufferAttribute(fades, 1))
    geometry.setAttribute('aRadial', new THREE.Float32BufferAttribute(radials, 1))
    geometry.setIndex(indices)
    // Needed by the rim term; the surfaces are built as strips so three can derive
    // them, and hand-deriving cone normals here would be a second source of truth.
    geometry.computeVertexNormals()

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: ZOA_COLOR },
        uOpacity: { value: 0 },
      },
      vertexShader: ZOA_VERTEX,
      fragmentShader: ZOA_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    })
    this.zoaMaterials.push(material)

    const surface = new THREE.Mesh(geometry, material)
    surface.frustumCulled = false
    surface.renderOrder = -7
    surface.name = 'cosmos:zone-of-avoidance'
    layer.scene.add(surface)
    this.zoaSurface = surface

    const edgeGeometry = new THREE.BufferGeometry()
    edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3))
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: ZOA_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
    })
    this.zoaMaterials.push(edgeMaterial)
    const lines = new THREE.LineSegments(edgeGeometry, edgeMaterial)
    lines.frustumCulled = false
    lines.renderOrder = -6
    lines.name = 'cosmos:zone-of-avoidance-edges'
    layer.scene.add(lines)
    this.zoaEdges = lines

    // Labels. The wedge is a region, not a point, so it gets an anchor on each side of
    // the sky; whichever way the camera faces, the gap is named rather than implied.
    for (const [index, lon] of [0, 180].entries()) {
      sphericalToCartesian(this.scratchWorld, lon, 0, 0.42 * reachMpc * MPC_M)
      const node: CosmosNode = {
        id: `cosmos:zone-of-avoidance:${index}`,
        worldPosition: { x: this.scratchWorld.x, y: this.scratchWorld.y, z: this.scratchWorld.z },
        frame: 'galactic',
        radiusMetres: 0,
        layer: LAYER,
        // No object class exists for "a hole in the data" yet; see the module report.
        objectClass: 'nebula',
        name: 'Zone of Avoidance — no survey coverage',
        parentId: null,
        distanceKind: 'redshift',
        provenance: 'measured',
        distanceMpc: 0.42 * reachMpc,
        distanceSigmaMpc: null,
        redshift: null,
        catalogue: '2MRS selection function',
        caveat:
          'Not an object. The Milky Way blocks the extragalactic sky here, so no survey has looked through it. ' +
          'The wedge marks where the catalogues are empty by construction, and nothing is interpolated across it.',
      }
      this.nodes.set(node.id, node)
      this.engine.register(node)
    }

    const obscured = manifest.zoneOfAvoidance?.measured?.meanSkyFractionObscured
    this.datasets.push({
      id: 'zone-of-avoidance',
      label: 'Zone of avoidance (survey gap)',
      provenance: 'measured',
      distanceKind: 'redshift',
      drawn: sorted.length,
      omitted: [],
      attribution: '2MRS survey definition — Huchra et al. (2012), ApJS 199, 26, Sect. 2.',
      note:
        `${obscured !== undefined ? `${(obscured * 100).toFixed(1)}% of the sky` : 'A band along the galactic plane'} ` +
        `is obscured by our own galaxy. Limits are the survey's measured per-longitude coverage over ` +
        `${sorted.length} bins (|b| up to ${Math.max(...sorted.map((b) => b.measuredLimitAbsBDeg))} deg), ` +
        `used as the step function they are. Drawn to the survey's own reach of ${reachMpc.toFixed(0)} Mpc.`,
    })

    console.info(
      `[omniatlas] cosmos: zone of avoidance drawn from ${sorted.length} measured longitude bins out to ` +
        `${reachMpc.toFixed(0)} Mpc`,
    )
  }

  // -------------------------------------------------------------------------
  // Geometry builders
  // -------------------------------------------------------------------------

  private buildPointField(
    layer: ReturnType<Engine['layer']>,
    positions: ArrayLike<number>,
    absMags: ArrayLike<number>,
    kinds: ArrayLike<number>,
    options: {
      name: string
      colors: THREE.Color[]
      magLimit: number
      minRadiusPx: number
      maxRadiusPx: number
      gain: number
      renderOrder: number
    },
  ): FieldMesh | null {
    const count = absMags.length
    if (count === 0 || !this.quad) return null

    const geometry = new THREE.InstancedBufferGeometry()
    geometry.index = this.quad.index
    geometry.setAttribute('position', this.quad.getAttribute('position'))
    geometry.setAttribute('aPos', new THREE.InstancedBufferAttribute(toFloat32(positions), 3))
    geometry.setAttribute('aAbsMag', new THREE.InstancedBufferAttribute(toFloat32(absMags), 1))
    geometry.setAttribute('aKind', new THREE.InstancedBufferAttribute(toFloat32(kinds), 1))
    geometry.instanceCount = count

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColors: { value: options.colors.slice(0, 4) },
        uPixelHeight: { value: 1080 },
        uMagLimit: { value: options.magLimit },
        uMinRadiusPx: { value: options.minRadiusPx },
        uMaxRadiusPx: { value: options.maxRadiusPx },
        uGain: { value: options.gain },
        uOpacity: { value: 1 },
      },
      vertexShader: FIELD_VERTEX,
      fragmentShader: FIELD_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = options.renderOrder
    mesh.name = options.name
    layer.scene.add(mesh)
    return { mesh, material, count }
  }

  private buildSmearField(
    layer: ReturnType<Engine['layer']>,
    near: Float32Array,
    far: Float32Array,
    weight: Float32Array,
    flag: Float32Array,
    count: number,
  ): FieldMesh | null {
    if (count === 0 || !this.quad) return null

    const geometry = new THREE.InstancedBufferGeometry()
    geometry.index = this.quad.index
    geometry.setAttribute('position', this.quad.getAttribute('position'))
    geometry.setAttribute('aNear', new THREE.InstancedBufferAttribute(near.subarray(0, count * 3), 3))
    geometry.setAttribute('aFar', new THREE.InstancedBufferAttribute(far.subarray(0, count * 3), 3))
    geometry.setAttribute('aWeight', new THREE.InstancedBufferAttribute(weight.subarray(0, count), 1))
    geometry.setAttribute('aFlag', new THREE.InstancedBufferAttribute(flag.subarray(0, count), 1))
    geometry.instanceCount = count

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uViewportPx: { value: new THREE.Vector2(1920, 1080) },
        uHalfWidthPx: { value: 1.6 },
        uGain: { value: 2.2 },
        uOpacity: { value: 1 },
        uRefDistanceMpc: { value: 180 },
        uCullIntensity: { value: 0.006 },
        uColor: { value: CF4_COLOR },
        uColorUnquoted: { value: CF4_COLOR_UNQUOTED },
      },
      vertexShader: SMEAR_VERTEX,
      fragmentShader: SMEAR_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      // The quad is rebuilt in pixel space around an arbitrary screen-space axis, so
      // its winding flips with the direction of the smear. Culling by face here would
      // drop half the catalogue depending on where the camera is standing.
      side: THREE.DoubleSide,
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = -7
    mesh.name = 'cosmos:cf4'
    layer.scene.add(mesh)
    return { mesh, material, count }
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  preRender(ctx: FrameContext): void {
    const layer = this.engine.layers.get(LAYER)
    if (!layer || !layer.active) return

    const dpr = Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio, 2)
    const pixelHeight = ctx.height * dpr
    // The limiting magnitude follows the field of view the way a telescope's does.
    const fovBoost = 5 * Math.log10(50 / Math.max(ctx.fovDegrees, 1))
    const distanceMpc = layer.cameraDistanceMetres / MPC_M

    /**
     * Flying away from a survey dims it as 1/d^2, which for stars is the point and for
     * a galaxy catalogue is useless: pulling back to see the whole cosmic web would
     * turn it off. The limit is raised by HALF a distance modulus, so brightness falls
     * as 1/d rather than 1/d^2 — the depth cue survives, the structure does not go out.
     * A display choice, and the only one in this module that touches brightness.
     */
    const reach = (referenceMpc: number) =>
      Math.min(6, Math.max(0, 2.5 * Math.log10(Math.max(1, distanceMpc / referenceMpc))))

    if (this.ungcField) {
      const u = this.ungcField.material.uniforms
      u.uPixelHeight.value = pixelHeight
      u.uMagLimit.value = 23 + fovBoost + reach(1)
      u.uOpacity.value = 1
    }

    // Cosmicflows-4 is meaningless inside the Local Volume and 2MRS is meaningless
    // inside Cosmicflows-4's reach, so each fades in where it starts to mean something.
    if (this.cf4Field) {
      // 0.45 rather than 1.0. Every smear points at the observer, so at full strength
      // 38,000 of them read as a starburst centred on the camera rather than as
      // structure in the universe. Dimmer, the group cores carry the image and the
      // elongation stays legible as what it is: the uncertainty on each distance.
      const opacity = 0.45 * smoothstep(1.5, 15, distanceMpc)
      const u = this.cf4Field.material.uniforms
      ;(u.uViewportPx.value as THREE.Vector2).set(ctx.width * dpr, ctx.height * dpr)
      u.uOpacity.value = opacity
      this.cf4Field.mesh.visible = opacity > 0.002
    }

    if (this.twoMrsField) {
      const opacity = 0.9 * smoothstep(8, 60, distanceMpc)
      const u = this.twoMrsField.material.uniforms
      u.uPixelHeight.value = pixelHeight
      u.uMagLimit.value = 16.5 + fovBoost + reach(10)
      u.uOpacity.value = opacity
      this.twoMrsField.mesh.visible = opacity > 0.002
    }

    // The gap appears with the data it is a gap in — never later, or there would be a
    // moment where the hole looks like a void.
    // Deliberately faint. The zone of avoidance has to be legible as "no survey
    // coverage here" without becoming the loudest thing on screen -- at 0.3 it read
    // as a solid orange wedge dominating the cosmic web it is supposed to annotate.
    // It is a caveat on the data, not an object in the universe.
    const gapOpacity = 0.075 * smoothstep(1.5, 15, distanceMpc)
    if (this.zoaSurface) {
      const material = this.zoaSurface.material as THREE.ShaderMaterial
      material.uniforms.uOpacity.value = gapOpacity
      this.zoaSurface.visible = gapOpacity > 0.001
    }
    if (this.zoaEdges) {
      const material = this.zoaEdges.material as THREE.LineBasicMaterial
      material.opacity = gapOpacity * 0.6
      this.zoaEdges.visible = gapOpacity > 0.001
    }
  }

  dispose(): void {
    this.disposed = true
    for (const field of [this.ungcField, this.cf4Field, this.twoMrsField]) {
      if (!field) continue
      field.mesh.geometry.dispose()
      field.material.dispose()
      field.mesh.removeFromParent()
    }
    this.ungcField = null
    this.cf4Field = null
    this.twoMrsField = null

    for (const object of [this.zoaSurface, this.zoaEdges]) {
      if (!object) continue
      object.geometry.dispose()
      object.removeFromParent()
    }
    this.zoaSurface = null
    this.zoaEdges = null
    for (const material of this.zoaMaterials) material.dispose()
    this.zoaMaterials.length = 0

    for (const id of this.nodes.keys()) this.engine?.unregister(id)
    this.nodes.clear()
    this.datasets.length = 0

    this.quad?.dispose()
    this.quad = null
  }
}

export default function createCosmosModule(): AtlasModule {
  return new CosmosModule()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The Sun's motion relative to the CMB, projected onto a line of sight.
 *
 * 369.8 km/s toward galactic (l, b) = (264.021, 48.253), per the 2MRS manifest. Adding
 * this to a heliocentric cz puts 2MRS and Cosmicflows-4 in the same rest frame; without
 * it the two fields are offset by up to 370 km/s, which is 5.5 Mpc of apparent radius.
 */
const APEX_SPEED_KM_S = 369.8
const APEX_L_DEG = 264.021
const APEX_B_DEG = 48.253
const apexUnit = sphericalToCartesian(vec3d(), APEX_L_DEG, APEX_B_DEG, 1)
const apexScratch = vec3d()

function solarApexProjection(lonDeg: number, latDeg: number): number {
  sphericalToCartesian(apexScratch, lonDeg, latDeg, 1)
  return APEX_SPEED_KM_S * (apexScratch.x * apexUnit.x + apexScratch.y * apexUnit.y + apexScratch.z * apexUnit.z)
}

/**
 * The radial opacity profile of the wedge. Zero at the observer (where the wedge has no
 * width and would just be a bright dot in the middle of the view), full across the body
 * of the survey, fading out at the reach. A display choice, and only a display choice:
 * the gap itself does not end anywhere.
 */
function radialFade(fraction: number): number {
  return smoothstep(0.02, 0.12, fraction) * (1 - smoothstep(0.45, 1, fraction))
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

function toFloat32(values: ArrayLike<number>): Float32Array {
  if (values instanceof Float32Array) return values
  const out = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) out[i] = values[i]
  return out
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Catalogue spellings into something a label can show. Formatting only. */
function displayName(name: string): string {
  const messier = /^MESSIER0*(\d+)$/.exec(name)
  if (messier) return `M${messier[1]}`
  const designation = /^(NGC|IC|UGC|UGCA|PGC|DDO|ESO)0*(\d+.*)$/.exec(name)
  if (designation) return `${designation[1]} ${designation[2]}`
  return name
}

function indexOfValue(array: Uint32Array, value: number): number {
  for (let i = 0; i < array.length; i++) if (array[i] === value) return i
  return -1
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) {
      console.warn(`[omniatlas] cosmos: ${url} returned ${response.status}`)
      return null
    }
    return (await response.json()) as T
  } catch (error) {
    console.warn(`[omniatlas] cosmos: ${url} unavailable`, error)
    return null
  }
}

/**
 * Fetch a `<name>.json` manifest and its `<name>.bin`, and sanity-check the pair.
 *
 * The binaries are STRUCT-OF-ARRAYS: all of field A, then all of field B. Every offset
 * below is read from the manifest rather than computed from a record stride, because
 * reading one of these as interleaved records produces geometry that looks plausible
 * and is entirely wrong.
 */
async function fetchBinary<T extends BinaryManifest = BinaryManifest>(
  base: string,
): Promise<{ manifest: T; buffer: ArrayBuffer } | null> {
  try {
    const [manifest, buffer] = await Promise.all([
      fetchJson<T>(`${base}.json`),
      fetch(`${base}.bin`).then((r) => (r.ok ? r.arrayBuffer() : null)),
    ])
    if (!manifest || !buffer) return null
    if (!Array.isArray(manifest.fields) || !(manifest.recordCount > 0)) {
      console.warn(`[omniatlas] cosmos: ${base}.json is not a field manifest`)
      return null
    }
    if (manifest.totalBytes && buffer.byteLength !== manifest.totalBytes) {
      console.warn(
        `[omniatlas] cosmos: ${base}.bin is ${buffer.byteLength} bytes, manifest says ${manifest.totalBytes}`,
      )
      return null
    }
    return { manifest, buffer }
  } catch (error) {
    console.warn(`[omniatlas] cosmos: ${base} unavailable`, error)
    return null
  }
}

function field(manifest: BinaryManifest, name: string): BinaryField | null {
  return manifest.fields.find((f) => f.name === name) ?? null
}

function quantScale(manifest: BinaryManifest, name: string): number {
  return field(manifest, name)?.quantization?.scale ?? 1
}

/** Typed-array views, each checked against the manifest's own dtype and length. */
function view<T>(
  manifest: BinaryManifest,
  buffer: ArrayBuffer,
  name: string,
  count: number,
  dtype: string,
  bytes: number,
  make: (buffer: ArrayBuffer, offset: number, length: number) => T,
): T | null {
  const spec = field(manifest, name)
  if (!spec) {
    console.warn(`[omniatlas] cosmos: field "${name}" missing from manifest`)
    return null
  }
  if (spec.dtype !== dtype) {
    console.warn(`[omniatlas] cosmos: field "${name}" is ${spec.dtype}, expected ${dtype}`)
    return null
  }
  if (spec.byteOffset + count * bytes > buffer.byteLength || spec.byteOffset % bytes !== 0) {
    console.warn(`[omniatlas] cosmos: field "${name}" does not fit the buffer at offset ${spec.byteOffset}`)
    return null
  }
  return make(buffer, spec.byteOffset, count)
}

const readFloat32 = (m: BinaryManifest, b: ArrayBuffer, n: string, c: number) =>
  view(m, b, n, c, 'float32', 4, (buf, o, l) => new Float32Array(buf, o, l))
const readUint32 = (m: BinaryManifest, b: ArrayBuffer, n: string, c: number) =>
  view(m, b, n, c, 'uint32', 4, (buf, o, l) => new Uint32Array(buf, o, l))
const readInt32 = (m: BinaryManifest, b: ArrayBuffer, n: string, c: number) =>
  view(m, b, n, c, 'int32', 4, (buf, o, l) => new Int32Array(buf, o, l))
const readUint16 = (m: BinaryManifest, b: ArrayBuffer, n: string, c: number) =>
  view(m, b, n, c, 'uint16', 2, (buf, o, l) => new Uint16Array(buf, o, l))
const readInt16 = (m: BinaryManifest, b: ArrayBuffer, n: string, c: number) =>
  view(m, b, n, c, 'int16', 2, (buf, o, l) => new Int16Array(buf, o, l))
const readUint8 = (m: BinaryManifest, b: ArrayBuffer, n: string, c: number) =>
  view(m, b, n, c, 'uint8', 1, (buf, o, l) => new Uint8Array(buf, o, l))
