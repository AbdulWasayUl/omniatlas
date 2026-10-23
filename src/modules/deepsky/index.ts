import { displayName } from '../../core/names'
import * as THREE from 'three'
import { assetUrl } from '../../data/assetUrl'
import type { AtlasModule, Engine, FrameContext, SceneNodeHandle } from '../../core/Engine'
import { OBJECT_CLASSES } from '../../data/objectClasses'
import { literatureDistancePc } from '../../data/deepSkyDistances'
import {
  PC_M,
  type FrameId,
  type Vec3d,
  convertFrame,
  sphericalToCartesian,
  vec3d,
  worldToSceneBasis,
} from '../../core/world'

/**
 * The deep sky: 13,371 NGC/IC objects, 157 Harris globular clusters and 379 traced
 * nebula outlines, in the stellar layer.
 *
 * ## The honesty problem this module exists to solve
 *
 * A deep-sky catalogue is not a 3D point cloud. OpenNGC gives a direction for every
 * object and a distance for only some of them: 10,510 of the 13,371 drawn objects have
 * one (569 from parallax, 9,941 from redshift), and 2,861 do not. Two of the most
 * famous objects in the sky — M31 and M42 — are among the ones that do not, because
 * OpenNGC's parallax for a galaxy is a contaminated foreground value and M31's redshift
 * is negative.
 *
 * Inventing a distance for those would be the easy path and it would be a lie that is
 * impossible to see: a sphere of plausible dots looks exactly like a measurement. So
 * this module splits them:
 *
 * - An object **with** a distance is placed at that distance and drawn as a soft disc
 *   whose angular size is recomputed from the true camera distance every frame.
 * - An object **without** one is projected onto a shell of fixed radius (100 kpc) and
 *   drawn as a **hollow ring**, never a filled disc. The glyph is the disclosure: you
 *   can see which half of the sky is measured in depth without opening a panel. Those
 *   nodes carry `provenance: 'illustration'` and `directionOnly: true` in the registry,
 *   and the shell fades out as the camera leaves the solar neighbourhood, because a
 *   direction measured from the Sun stops meaning anything once you are not near it.
 *
 * ## Why the vertex buffers are unit vectors
 *
 * The stellar layer's unit is one parsec, and these objects run from 48 pc to 849 Mpc —
 * 8.5e8 layer units. A position that large in a vertex buffer would violate the
 * engine's locality rule and lose all precision. Instead every instance carries a
 * **unit direction** (|v| <= 1) plus a scalar distance, and the shader forms the
 * product. The buffer therefore stays in [-1, 1] no matter how far away the object is,
 * and the one large number lives in a float32 scalar where its error is relative
 * (~1e-7 of the distance) rather than absolute.
 *
 * ## Why these draw past the far plane
 *
 * The stellar layer's far plane is 1e4 pc. Everything here is additive, depth-tested
 * off sky content, so rather than stretch the depth range the shaders write
 * `clip.z = 0` — the projected x/y are the true perspective projection, only the depth
 * is neutralised. Objects behind the camera are collapsed explicitly first.
 */

const DATA = '/data/deepsky'

/**
 * The deep sky is drawn twice, into two layers, and crossfaded between them.
 *
 * The `stellar` layer is the sky: its band starts at zero, so it is the only layer
 * alive inside the solar system. But it stops contributing 3 kpc from the Sun, and the
 * Harris globulars reach 123 kpc — the whole point of them is to be seen from outside.
 * The `galactic` layer covers 50 pc to 1 Mpc and would be the natural home, except it
 * is switched off while the camera is near the Sun.
 *
 * So each point field exists in both, in each layer's own frame and unit, with one
 * fading up as the other fades down across the overlap the engine deliberately leaves
 * between the bands. The cost is one extra draw call per field; the alternative is a
 * sky that vanishes at 3 kpc or a globular halo that never appears at all.
 */
const LAYER_SPECS = [
  { layer: 'stellar' as const, frame: 'icrf' as const, unitPc: 1, near: true },
  { layer: 'galactic' as const, frame: 'galactic' as const, unitPc: 1000, near: false },
]

/** The layer that owns the registry nodes and the outline shapes. */
const LAYER = 'stellar' as const
const FAR_LAYER = 'galactic' as const

/** Camera distances (pc from the Sun) over which the stellar copy hands over. */
const HANDOVER_PC: [number, number] = [80, 700]

/**
 * Registry positions are written in the ecliptic frame even though the catalogue is
 * ICRF. The rotation is exact and lossless, and it is what the camera controller
 * understands: `AtlasViewer.focus` hands `node.worldPosition` straight to a controller
 * whose frame is fixed to `ecliptic`, so an ICRF node would fly to a point 23.4 degrees
 * away from the object. See `requested_core_changes` in this module's report.
 */
const REGISTRY_FRAME = 'ecliptic' as const

/**
 * Radius of the direction-only shell, in parsecs. 100 kpc is outside the Milky Way's
 * disc and well inside the extragalactic field, so the shell reads as a surface rather
 * than as a population. The exact value is arbitrary **and that is the point** — it is
 * a projection, not a position, and it is reported as such in the manifest.
 */
/**
 * Peculiar velocity floor for the Hubble law, as a redshift.
 *
 * Galaxies move through space as well as with its expansion, at several hundred km/s.
 * Below roughly z = 0.002 (about 600 km/s) that motion is comparable to or larger than
 * the recession velocity, so `z * c / H0` stops measuring distance at all.
 *
 * The Small Magellanic Cloud is the object that exposed this: OpenNGC lists it as
 * NGC 292, its catalogued radial velocity is dominated by its orbit around the Milky
 * Way, and the Hubble law duly placed it 2.15 Mpc away — 35 times its true 62 kpc.
 * Rather than special-case one galaxy, any Hubble distance below this floor is treated
 * as no distance at all, and the object is drawn direction-only on the shell with the
 * hollow glyph that says so. An honest "we do not know how far" beats a confident
 * number that is wrong by a factor of 35.
 */
const HUBBLE_REDSHIFT_FLOOR = 0.002

const DISTANCE_KIND_HUBBLE = 2

function hasTrustworthyDistance(kind: number, distancePc: number, redshift: number): boolean {
  if (kind === 0) return false
  if (!Number.isFinite(distancePc) || distancePc <= 0) return false
  if (kind === DISTANCE_KIND_HUBBLE && Number.isFinite(redshift) && Math.abs(redshift) < HUBBLE_REDSHIFT_FLOOR) {
    return false
  }
  return true
}

const SHELL_PC = 1e5

/**
 * Camera distances (pc from the Sun) over which the direction-only shell fades out.
 *
 * The shell is the same kind of claim as the contours below: a bearing taken from
 * here. It used to outlive them by more than a decade in distance, so there was a
 * long stretch where the traced outlines had gone and the glyphs they annotate were
 * still at full strength. It still lets go later than they do — a bearing stays
 * roughly right much further than a traced shape does — but on the same scale.
 */
const SHELL_FADE_PC: [number, number] = [120, 1200]
/**
 * The same, for the traced outlines.
 *
 * These are contours of what a telescope ON EARTH records, pinned to the shell, so
 * they are a statement about one vantage point rather than about the object. They used
 * to hold full strength out to 150 pc — 489 light years, most of the way to Orion —
 * and only finish at 1.5 kpc, which drew an Earth-vantage tracing over a view Earth has
 * never had. They now let go on the same scale as the constellation figures, which are
 * the same kind of claim, and well before the shell they sit on.
 *
 * The window is set by the aspect change, not by a round number: the nearest contour,
 * the Pleiades nebulosity, is 136 pc away, so an 8 pc camera offset is 3 degrees of
 * changed viewing angle and a 45 pc one is 19 degrees, which no traced outline
 * survives. An earlier [3, 80] let go too early at the near end and too late at the
 * far one.
 */
const OUTLINE_FADE_PC: [number, number] = [8, 45]

/** Assumed magnitude for the 1,827 drawn objects the catalogue gives no V or B for. */
const ASSUMED_MAGNITUDE = 14.2

// ---------------------------------------------------------------------------
// Catalogue taxonomy
// ---------------------------------------------------------------------------

type DeepSkyCategory =
  | 'galaxy'
  | 'nebula'
  | 'planetary'
  | 'openCluster'
  | 'globularCluster'
  | 'starLike'
  | 'other'

/** OpenNGC's `type` enum, mapped onto the categories this module colours by. */
const TYPE_CATEGORY: Record<string, DeepSkyCategory> = {
  G: 'galaxy',
  GPair: 'galaxy',
  GTrpl: 'galaxy',
  GGroup: 'galaxy',
  Neb: 'nebula',
  EmN: 'nebula',
  RfN: 'nebula',
  HII: 'nebula',
  DrkN: 'nebula',
  SNR: 'nebula',
  PN: 'planetary',
  OCl: 'openCluster',
  // A cluster inside nebulosity: M42, M8, M16, M20. What a visitor sees, and what
  // every one of them is named for, is the nebula.
  'Cl+N': 'nebula',
  '*Ass': 'openCluster',
  GCl: 'globularCluster',
  '*': 'starLike',
  '**': 'starLike',
  Nova: 'starLike',
  Other: 'other',
}

/**
 * OpenNGC classifications that are not objects you can go to.
 *
 * `Dup` is a second listing of something already in the catalogue and `NonEx` is an
 * entry the catalogue itself retracts; 661 rows carry one or the other. They are
 * already dropped from the drawn field, but the named list registered them anyway, and
 * the M102 row — a `Dup` of M101 with no coordinates, no size and no distance of its
 * own — therefore put a second 'Messier 101' on the shell, four megaparsecs from the
 * real one.
 *
 * `*` and `**` are single and double STARS that happen to carry an NGC or IC number.
 * Alnilam and gamma Cygni are stars, already registered by the star module under
 * their own names, so the deep-sky copy is a duplicate — but only when the star
 * module can be expected to have them. Messier 40 is the double star Winnecke 4, and
 * nothing else in the atlas knows it by that name: folding it in with the duplicates
 * made one of the hundred and ten Messier objects unsearchable. A Messier number is
 * the test, because it is exactly the identity the star catalogue does not carry.
 */
const NON_OBJECT_TYPES = new Set(['Dup', 'NonEx'])
const STELLAR_TYPES = new Set(['*', '**'])

/**
 * Published major axes, in arcminutes, for the famous rows OpenNGC leaves sizeless.
 *
 * The registry is the search index, so a row with no size is not merely unframeable,
 * it is unfindable — and dropping every sizeless row took the Coalsack, Messier 73
 * and Messier 40 out of the palette. These three extents are not in dispute in the
 * literature, and the alternative to writing them down is pretending the objects do
 * not exist. Keyed by OpenNGC designation; same spirit as `literatureDistancePc`.
 */
const LITERATURE_MAJOR_AXIS_ARCMIN: Record<string, number> = {
  // The Coalsack is quoted as roughly 7 x 5 degrees of dark nebula (Nyman et al. 1989).
  C099: 420,
  // Messier 73, the four-star asterism in Aquarius: about 2.8' across (OpenNGC's own
  // entry for the asterism's members).
  NGC6994: 2.8,
  // Messier 40 is the double star Winnecke 4; its extent is the pair's SEPARATION,
  // 51.7" (WDS J12222+5805AB). See `SEPARATION_NOT_EXTENT_TYPES`: this number frames
  // the camera on the pair and is never reported as a size.
  M040: 0.86,
}

/**
 * Published distances for the famous rows OpenNGC leaves distanceless and
 * `deepSkyDistances` does not cover.
 *
 * Without one a row is projected onto the 100 kpc direction-only shell, which is an
 * honest statement of a bearing but makes the object unvisitable: you arrive 25 kpc
 * out in intergalactic space looking at nothing, because the thing you flew to is a
 * direction rather than a place. The Coalsack is the case that forced this — it is a
 * naked-eye object with a well-determined distance that simply is not in either
 * table.
 *
 * Same standing as `deepSkyDistances`: a consensus literature figure, not a reduction
 * done here, so rows placed from it are badged `literature` and `derived` exactly as
 * that table's are. It belongs in `src/data/deepSkyDistances.ts` next to the rest;
 * it is here only because this module does not own that file.
 */
const LITERATURE_DISTANCE_PC: Record<string, number> = {
  // The Coalsack, 180 pc (Franco 1989; Seidensticker & Schmidt-Kaler 1989 give 174
  // pc, Gaia-era extinction work the same to within the rounding).
  C099: 180,
}

/**
 * OpenNGC types whose catalogued major axis is a separation between bodies rather
 * than the extent of one.
 *
 * A visual double's "size" is how far apart the two stars are. Carried into
 * `radiusMetres` it says the atlas has measured a single object that big, and the
 * proxy then draws one: Messier 40, two 9th-magnitude stars 51.7" apart, arrived as a
 * single smooth sphere 8,000 AU across filling the frame. The separation is still the
 * right thing to FRAME on, so it goes to `framingRadiusMetres` and the row keeps its
 * registry slot — the point of listing M40's axis at all was that it is one of the
 * hundred and ten Messier objects and has to be findable.
 */
const SEPARATION_NOT_EXTENT_TYPES = new Set(['**'])

/** The registry class (and therefore glyph and label colour) for each category. */
const CATEGORY_OBJECT_CLASS: Record<DeepSkyCategory, string> = {
  galaxy: 'galaxy',
  nebula: 'nebula',
  planetary: 'nebula',
  openCluster: 'cluster',
  globularCluster: 'cluster',
  starLike: 'star',
  other: 'nebula',
}

function paletteColor(id: keyof typeof OBJECT_CLASSES): THREE.Color {
  return new THREE.Color(OBJECT_CLASSES[id].color)
}

/**
 * Five catalogue categories, four palette entries. Planetary nebulae and globular
 * clusters are mixed out of the palette rather than invented: a planetary is a nebula
 * pulled toward the cluster blue, a globular is the cluster blue pulled toward the
 * star gold. Both stay at roughly the palette's lightness, and neither collides with
 * the hue of the class it is mixed from.
 */
function categoryColor(category: DeepSkyCategory): THREE.Color {
  switch (category) {
    case 'galaxy':
      return paletteColor('galaxy')
    case 'nebula':
      return paletteColor('nebula')
    case 'planetary':
      return paletteColor('nebula').lerp(paletteColor('cluster'), 0.55)
    case 'openCluster':
      return paletteColor('cluster')
    case 'globularCluster':
      return paletteColor('cluster').lerp(paletteColor('star'), 0.5)
    case 'starLike':
      return paletteColor('star')
    default:
      // Unclassified NGC entries: the cluster hue, desaturated, so they read as
      // "catalogued but unexplained" rather than as a sixth kind of object.
      return paletteColor('cluster').lerp(new THREE.Color(0.22, 0.24, 0.27), 0.62)
  }
}

// ---------------------------------------------------------------------------
// Binary manifests
// ---------------------------------------------------------------------------

interface BinaryField {
  name: string
  dtype: string
  byteOffset: number
  count: number
  enum?: string[]
}

interface BinaryManifest {
  recordCount?: number
  fields: BinaryField[]
}

type AnyTypedArray =
  | Float32Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Uint8Array

/**
 * A zero-copy view of one struct-of-arrays field. Struct-of-arrays, not interleaved:
 * every field is a single contiguous run of `count` values at its own byte offset.
 * Reading these as interleaved records produces geometry that looks plausible and is
 * entirely wrong, which is why the decode is verified against M31 and M42 below.
 */
function fieldView(buffer: ArrayBuffer, manifest: BinaryManifest, name: string): AnyTypedArray {
  const field = manifest.fields.find((f) => f.name === name)
  if (!field) throw new Error(`field "${name}" missing from manifest`)
  const { byteOffset, count, dtype } = field
  switch (dtype) {
    case 'float32':
      return new Float32Array(buffer, byteOffset, count)
    case 'int32':
      return new Int32Array(buffer, byteOffset, count)
    case 'uint32':
      return new Uint32Array(buffer, byteOffset, count)
    case 'int16':
      return new Int16Array(buffer, byteOffset, count)
    case 'uint16':
      return new Uint16Array(buffer, byteOffset, count)
    case 'uint8':
      return new Uint8Array(buffer, byteOffset, count)
    default:
      throw new Error(`unsupported dtype "${dtype}" for field "${name}"`)
  }
}

/**
 * Named rows whose label has to carry its designation to stay a different label.
 *
 * `oneLabelPerObject` collapses rows that share a name AND a direction, which is what
 * keeps the nearby dwarfs from being written twice where two catalogues both list them.
 * Inside OpenNGC that same rule over-reached: the Antennae are two galaxies, NGC 4038
 * and NGC 4039, both named "Antennae Galaxies" and ninety arcseconds apart, so one of
 * them lost its label and — markers being the only pick targets — could not be clicked
 * at all. The Eyes, NGC 4435 and NGC 4438, lost one the same way.
 *
 * It cannot be fixed by refusing to collapse rows of one catalogue, because OpenNGC
 * also lists the Eagle Nebula twice on purpose, as IC 4703 and NGC 6611, and THAT pair
 * should keep one label between them. What separates the two cases is in the rows: the
 * Eagle's agree on every measurement they carry (1767 pc, V 6.0, B 6.58) because they
 * cross-identify one object, while the Antennae's disagree on distance, magnitude and
 * PGC number because they describe two.
 *
 * So: rows that disagree are different objects and get distinguishable names. A row
 * carrying no distance at all cannot disagree with anything — that is the M101 / M102
 * pair, a nineteenth-century re-observation the table resolves to one galaxy — so the
 * comparison is over the rows that actually state a distance. Four groups collide in
 * the shipped table and the test splits them 3 to 1.
 */
function collidingNames(objects: readonly NamedObject[]): Set<string> {
  const groups = new Map<string, NamedObject[]>()
  for (const object of objects) {
    const label = object.names?.length
      ? object.names[0]
      : object.messier
        ? `Messier ${object.messier}`
        : object.designation
    const ra = (object.raDeg * Math.PI) / 180
    const dec = (object.decDeg * Math.PI) / 180
    // The same ~0.6 degree quantisation oneLabelPerObject uses, so this answers the
    // question that function will actually ask rather than a neighbouring one.
    const key = [
      label.trim().toLowerCase(),
      Math.round((Math.cos(dec) * Math.cos(ra)) / 0.01),
      Math.round((Math.cos(dec) * Math.sin(ra)) / 0.01),
      Math.round(Math.sin(dec) / 0.01),
    ].join('|')
    const held = groups.get(key)
    if (held) held.push(object)
    else groups.set(key, [object])
  }

  const ambiguous = new Set<string>()
  for (const members of groups.values()) {
    if (members.length < 2) continue
    const stated = members.filter((m) => typeof m.distancePc === 'number' && m.distancePc > 0)
    const agrees =
      stated.length < 2 ||
      (new Set(stated.map((m) => m.distancePc)).size === 1 &&
        new Set(stated.map((m) => m.vmag ?? null)).size === 1)
    if (!agrees) for (const member of members) ambiguous.add(member.designation)
  }
  return ambiguous
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(assetUrl(url))
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

async function fetchBinary(url: string): Promise<ArrayBuffer | null> {
  try {
    const response = await fetch(assetUrl(url))
    if (!response.ok) return null
    return await response.arrayBuffer()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The manifest this module emits
// ---------------------------------------------------------------------------

export interface DeepSkyManifest {
  /** Per-dataset load outcome, so a missing file is visible rather than silent. */
  datasets: Record<string, 'loaded' | 'missing' | 'malformed' | 'pending'>
  ngc: {
    recordsInFile: number
    drawn: number
    skippedDuplicateOrNonexistent: number
    /** Objects placed at a measured distance. */
    measured: number
    measuredFromParallax: number
    measuredFromRedshift: number
    /** Objects with no distance, projected onto the shell. */
    directionOnly: number
    directionOnlyShellRadiusPc: number
    /** Objects with neither a V nor a B magnitude, drawn at ASSUMED_MAGNITUDE. */
    assumedMagnitude: number
    byCategory: Record<string, { drawn: number; measured: number; directionOnly: number }>
  }
  named: {
    registered: number
    measured: number
    directionOnly: number
    literature: number
    /** Rows dropped by `NON_OBJECT_TYPES`. */
    skippedNonObject: number
    /** Rows OpenNGC records no angular size for, so nothing could be framed or drawn. */
    skippedSizeless: number
  }
  globulars: {
    registered: number
    nearestKpc: number
    farthestKpc: number
    /** NGC/IC registry entries replaced by the Harris measurement. */
    replacedNgcEntries: number
    /** NGC/IC point sprites suppressed because Harris draws the same cluster. */
    suppressedNgcSprites: number
  }
  outlines: { outlines: number; rings: number; points: number; matchedToCatalogue: number; filledRings: number }
  provenance: {
    measured: string[]
    derived: string[]
    illustration: string[]
  }
  attribution: string[]
}

/** A registry node that knows how much of itself is a measurement. */
export interface DeepSkyNode extends SceneNodeHandle {
  provenance: 'measured' | 'derived' | 'illustration'
  /** True when only the direction is known and the position is a shell projection. */
  directionOnly: boolean
  /**
   * How wide to open the camera on arrival, in metres — NOT a size of the object.
   *
   * For a placed object it is the same number as `radiusMetres`. For a direction-only
   * one it is the catalogued angular size carried out to the 100 kpc shell the glyph
   * is drawn on, which is a statement about the picture and not about the object, and
   * is why it does not go in `radiusMetres`: the inspector prints that one as a
   * measurement. Nothing reads this yet; `focus()` is the intended consumer.
   */
  framingRadiusMetres: number
  distanceSource: 'parallax' | 'redshift' | 'literature' | 'harris-2010' | 'none'
  designation: string
  catalogue: string
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const PROJECT_CHUNK = /* glsl */ `
  const float LOG10 = 0.4342944819032518;
  const float DEG2RAD = 0.017453292519943295;
`

const POINT_VERTEX = /* glsl */ `
  ${PROJECT_CHUNK}

  attribute vec3 dsDir;        // unit direction in the layer's scene basis
  attribute float dsDist;      // parsecs; <= 0 means "direction only"
  attribute float dsRadius;    // physical radius, parsecs (0 = unknown)
  attribute float dsMag;       // absolute magnitude (measured) or apparent (direction-only)
  attribute vec3 dsColor;
  attribute float dsOutline;   // angular radius of this object's traced outline, degrees

  uniform float uPixelWidth;
  uniform float uPixelHeight;
  uniform float uTanHalfFov;
  uniform float uMagLimit;
  uniform float uGain;
  uniform float uShell;        // direction-only shell radius, in THIS layer's units
  uniform float uShellFade;
  uniform float uMinPx;
  uniform float uMaxPx;
  uniform float uOutlineTakeoverPx;
  uniform float uProxyTakeoverPx;
  uniform float uSolFade;      // how much of the traced-outline overlay is still drawn
  uniform float uUnitPc;       // parsecs per layer unit
  uniform float uLayerFade;    // crossfade between the stellar and galactic copies

  varying vec3 vColor;
  varying float vIntensity;
  varying float vRing;
  varying vec2 vQuad;

  void main() {
    vQuad = position.xy;
    float directionOnly = step(dsDist, 0.0);
    vRing = directionOnly;

    float distance = mix(dsDist, uShell, directionOnly);
    vec4 viewPosition = modelViewMatrix * vec4(dsDir * distance, 1.0);

    // View space looks down -z. Anything at or behind the eye is collapsed rather than
    // projected, because the clip.z override below would otherwise let it through.
    if (viewPosition.z > -1e-6) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float d = max(length(viewPosition.xyz), 1e-6);
    float dPc = max(d * uUnitPc, 1e-3);

    // A measured object carries an absolute magnitude, so its brightness follows the
    // true camera distance and it grows as you approach. A direction-only object has
    // no such thing: its magnitude is what Earth sees, and it stays what Earth sees.
    float apparent = mix(dsMag + 5.0 * (log(dPc) * LOG10) - 5.0, dsMag, directionOnly);
    float headroom = uMagLimit - apparent;

    float alpha = uLayerFade * mix(1.0, uShellFade, directionOnly);
    if (headroom < -1.5 || alpha < 0.004) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    // Angular extent from the object's own size at the true distance. Radius and
    // distance are both in layer units here, so the ratio is unit-free.
    float extentPx = (dsRadius / d) / uTanHalfFov * uPixelHeight * 0.5;
    float magPx = uMinPx + 0.34 * max(headroom, 0.0);
    float radiusPx = clamp(max(magPx, extentPx), uMinPx, uMaxPx);

    // Where a traced contour exists and is large on screen, the sprite steps aside and
    // lets the real shape carry the object. It only steps aside while there is in fact
    // something there to step aside for: the takeover depends on field of view alone,
    // so once the outlines had been faded out on camera distance it went on dimming
    // the nine largest glyphs in the set — Orion, Cygnus, the LMC, the Veil — by up to
    // 92% in favour of a contour that was no longer being drawn.
    float outlinePx = (dsOutline * DEG2RAD) / uTanHalfFov * uPixelHeight * 0.5;
    alpha *= 1.0 - 0.92 * uSolFade * smoothstep(uOutlineTakeoverPx, uOutlineTakeoverPx * 2.4, outlinePx);

    // ...and the same for the close-range stand-in, which is the other thing that can
    // be drawing this object. Every deep-sky node is meshless, so anchoring on one has
    // the proxy module build an illustration of it; the sprite went on being drawn over
    // that illustration, clamped at uMaxPx and parked in the middle of it as a
    // 190-pixel blob that never went away however close the camera got.
    //
    // Keyed on the object's own screen extent rather than on the camera distance or on
    // any flag from another module, which is what makes it honest: dsRadius is 0 for
    // a direction-only object, so one of those subtends nothing, fades for nothing, and
    // keeps the ring glyph that is the only mark it has.
    alpha *= 1.0 - smoothstep(uProxyTakeoverPx, uProxyTakeoverPx * 3.0, extentPx);

    // Flux, spread over the sprite: an extended object is not a bright point, it is a
    // faint smear with the same total light.
    float flux = pow(2.512, clamp(headroom, -1.5, 7.0));
    float spread = max(1.0, radiusPx / uMinPx);
    vIntensity = uGain * flux * alpha / pow(spread, 1.35);
    vColor = dsColor;

    vec4 clip = projectionMatrix * viewPosition;
    // NDC x spans the viewport WIDTH and NDC y its HEIGHT, so one shared offset would
    // make every quad W/H times wider than tall and the circular discard would cut an
    // ellipse. Scale each axis by its own pixel count.
    clip.xy += position.xy * (2.0 * radiusPx / vec2(uPixelWidth, uPixelHeight)) * clip.w;
    clip.z = 0.0; // sky content: never depth-clipped, never depth-tested
    gl_Position = clip;
  }
`

const POINT_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vIntensity;
  varying float vRing;
  varying vec2 vQuad;

  void main() {
    float r2 = dot(vQuad, vQuad);
    if (r2 > 1.0) discard;
    float r = sqrt(r2);
    // Measured: a soft disc. Direction-only: a hollow ring, so the absence of a
    // distance is legible at a glance instead of buried in a metadata panel.
    float disc = exp(-4.2 * r2);
    float ring = exp(-pow((r - 0.70) / 0.19, 2.0)) * 0.85;
    float shape = mix(disc, ring, vRing);
    gl_FragColor = vec4(vColor * vIntensity * shape, shape);
  }
`

const GLOBULAR_VERTEX = /* glsl */ `
  ${PROJECT_CHUNK}

  attribute vec3 gcDir;
  attribute float gcDist;      // Harris 2010 heliocentric distance, in layer units
  attribute float gcRadius;    // half-light radius, in layer units
  attribute float gcAbsMag;    // integrated absolute V magnitude
  attribute vec3 gcColor;

  uniform float uPixelWidth;
  uniform float uPixelHeight;
  uniform float uTanHalfFov;
  uniform float uMagLimit;
  uniform float uGain;
  uniform float uMinPx;
  uniform float uMaxPx;
  uniform float uUnitPc;
  uniform float uLayerFade;
  uniform float uProxyTakeoverPx;

  varying vec3 vColor;
  varying float vIntensity;
  varying vec2 vQuad;

  void main() {
    vQuad = position.xy;
    vec4 viewPosition = modelViewMatrix * vec4(gcDir * gcDist, 1.0);
    if (viewPosition.z > -1e-6) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    float d = max(length(viewPosition.xyz), 1e-6);
    float dPc = max(d * uUnitPc, 1e-3);
    float apparent = gcAbsMag + 5.0 * (log(dPc) * LOG10) - 5.0;
    float headroom = uMagLimit - apparent;
    if (headroom < -2.0 || uLayerFade < 0.004) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float extentPx = (gcRadius / d) / uTanHalfFov * uPixelHeight * 0.5;
    float radiusPx = clamp(max(uMinPx + 0.5 * max(headroom, 0.0), extentPx * 2.2), uMinPx, uMaxPx);
    float flux = pow(2.512, clamp(headroom, -2.0, 8.0));
    float spread = max(1.0, radiusPx / uMinPx);
    // Hands the cluster over to its close-range stand-in, as the NGC sprite does. These
    // carry a half-light radius from Harris rather than a catalogued major axis, so the
    // handover starts at a smaller extent: radiusPx already draws them at 2.2 times it.
    float takeover = 1.0 - smoothstep(uProxyTakeoverPx, uProxyTakeoverPx * 3.0, extentPx);
    vIntensity = uGain * uLayerFade * flux * takeover / pow(spread, 1.45);
    vColor = gcColor;

    vec4 clip = projectionMatrix * viewPosition;
    clip.xy += position.xy * (2.0 * radiusPx / vec2(uPixelWidth, uPixelHeight)) * clip.w;
    clip.z = 0.0;
    gl_Position = clip;
  }
`

const GLOBULAR_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vIntensity;
  varying vec2 vQuad;

  void main() {
    float r2 = dot(vQuad, vQuad);
    if (r2 > 1.0) discard;
    // Two lobes: a resolved-looking halo with a concentrated core. A globular is the
    // one deep-sky object that genuinely looks like this in a small telescope.
    float shape = 0.55 * exp(-2.3 * r2) + 0.75 * exp(-11.0 * r2);
    gl_FragColor = vec4(vColor * vIntensity * shape, shape);
  }
`

const OUTLINE_VERTEX = /* glsl */ `
  ${PROJECT_CHUNK}

  attribute vec3 oDir;
  attribute vec3 oColor;
  attribute float oAngularRadius;  // degrees, of the whole outline
  attribute float oLevel;          // 1 faintest .. 3 brightest isophote

  uniform float uShellPc;
  uniform float uPixelHeight;
  uniform float uTanHalfFov;
  uniform float uFadeInPx;
  uniform float uSolFade;
  uniform float uAlpha;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(oDir * uShellPc, 1.0);
    vColor = oColor;

    if (viewPosition.z > -1e-6) {
      vAlpha = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    // Fade in with on-screen size: below a couple of dozen pixels a traced isophote is
    // noise, and the point sprite says the same thing more clearly.
    float pxRadius = (oAngularRadius * DEG2RAD) / uTanHalfFov * uPixelHeight * 0.5;
    float size = smoothstep(uFadeInPx, uFadeInPx * 2.6, pxRadius);
    // Inner isophotes are brighter, which is what the levels mean.
    float level = 0.55 + 0.26 * (oLevel - 1.0);
    vAlpha = size * uSolFade * uAlpha * level;

    vec4 clip = projectionMatrix * viewPosition;
    clip.z = 0.0;
    gl_Position = clip;
  }
`

const OUTLINE_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    if (vAlpha <= 0.002) discard;
    gl_FragColor = vec4(vColor * vAlpha, vAlpha);
  }
`

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

interface NamedObject {
  i: number
  designation: string
  names: string[]
  messier: number | null
  type: string
  constellation: string | null
  raDeg: number
  decDeg: number
  vmag: number | null
  bmag: number | null
  majAxArcmin: number | null
  minAxArcmin: number | null
  distancePc: number | null
  distanceKind: string
}

interface GlobularColumns {
  id: string[]
  name: (string | null)[]
  raDeg: number[]
  decDeg: number[]
  rSunKpc: number[]
  rGcKpc: (number | null)[]
  absMagV: (number | null)[]
  vMagIntegrated: (number | null)[]
  halfLightRadiusArcmin: (number | null)[]
  feH: (number | null)[]
}

export class DeepSkyModule implements AtlasModule {
  id = 'deepsky'

  /** Emitted so the UI (and this module's report) can state what is measured. */
  readonly manifest: DeepSkyManifest = {
    datasets: {
      'ngc.bin': 'pending',
      'ngc-names.json': 'pending',
      'globulars.json': 'pending',
      'outlines.bin': 'pending',
      'ngc-ids.json': 'pending',
    },
    ngc: {
      recordsInFile: 0,
      drawn: 0,
      skippedDuplicateOrNonexistent: 0,
      measured: 0,
      measuredFromParallax: 0,
      measuredFromRedshift: 0,
      directionOnly: 0,
      directionOnlyShellRadiusPc: SHELL_PC,
      assumedMagnitude: 0,
      byCategory: {},
    },
    named: {
      registered: 0,
      measured: 0,
      directionOnly: 0,
      literature: 0,
      skippedNonObject: 0,
      skippedSizeless: 0,
    },
    globulars: {
      registered: 0,
      nearestKpc: 0,
      farthestKpc: 0,
      replacedNgcEntries: 0,
      suppressedNgcSprites: 0,
    },
    outlines: { outlines: 0, rings: 0, points: 0, matchedToCatalogue: 0, filledRings: 0 },
    provenance: {
      measured: [
        'NGC/IC directions (OpenNGC, ICRS J2000)',
        'NGC/IC distances where distanceKind != none (parallax or z*c/H0)',
        'NGC/IC magnitudes and angular sizes',
        'Harris 2010 globular cluster distances, positions and integrated magnitudes',
        'Stellarium/Aladin isophote contours (shape and sky position)',
      ],
      derived: [
        'Physical radii: angular major axis x measured distance',
        'Absolute magnitudes: catalogue V (or B) magnitude reduced by the measured distance',
        'Sprite brightness recomputed from the true camera distance each frame',
      ],
      illustration: [
        `Direction-only objects projected onto a ${SHELL_PC / 1000} kpc shell: a projection, not a position`,
        'Outline contours drawn on that same shell, and faded out away from the Sun',
        `Assumed magnitude ${ASSUMED_MAGNITUDE} for objects with no catalogued V or B magnitude`,
      ],
    },
    attribution: [
      'OpenNGC — Mattia Verga, v20260501, CC BY-SA 4.0',
      'Globular clusters — Harris, W.E. 1996, AJ, 112, 1487 (2010 edition)',
      'Outlines traced in Aladin Sky Atlas (CDS, Strasbourg Observatory) over DSS2 Color',
    ],
  }

  private engine!: Engine
  private quad: THREE.BufferGeometry | null = null
  private outlineFill: THREE.Mesh | null = null
  private outlineLines: THREE.LineSegments | null = null
  private readonly objects: THREE.Object3D[] = []
  /** The same meshes split by layer, so each is hidden by the layer it actually draws in. */
  private readonly nearObjects: THREE.Object3D[] = []
  private readonly farObjects: THREE.Object3D[] = []
  private readonly materials: THREE.ShaderMaterial[] = []
  /** Materials in the near (stellar) copy and the far (galactic) copy, for the crossfade. */
  private readonly nearMaterials: THREE.ShaderMaterial[] = []
  private readonly farMaterials: THREE.ShaderMaterial[] = []
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly nodeIds: string[] = []

  /** Index of the catalogue row -> instance slot, for the outline/sprite handoff. */
  private rowToInstance = new Map<number, number>()
  private readonly outlineAttributes: THREE.InstancedBufferAttribute[] = []
  /** OpenNGC designation -> catalogue row. */
  private designationToRow = new Map<string, number>()
  /** Shared by both layer copies, so suppressing an instance suppresses it in both. */
  private pointMagAttribute: THREE.InstancedBufferAttribute | null = null
  private pointColorAttribute: THREE.InstancedBufferAttribute | null = null

  async init(engine: Engine): Promise<void> {
    this.engine = engine

    this.quad = new THREE.BufferGeometry()
    this.quad.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    )
    this.quad.setIndex([0, 1, 2, 0, 2, 3])

    // Each dataset is independent: a missing file costs its own content and nothing else.
    await this.loadCatalogue().catch((error) => {
      this.manifest.datasets['ngc.bin'] = 'malformed'
      console.warn('[omniatlas] deep-sky catalogue failed to load', error)
    })
    if (engine.isDisposed) return

    await this.loadNamed().catch((error) => {
      this.manifest.datasets['ngc-names.json'] = 'malformed'
      console.warn('[omniatlas] deep-sky named objects failed to load', error)
    })
    if (engine.isDisposed) return

    await this.loadGlobulars().catch((error) => {
      this.manifest.datasets['globulars.json'] = 'malformed'
      console.warn('[omniatlas] globular clusters failed to load', error)
    })
    if (engine.isDisposed) return

    // The outlines register nothing, so they can finish after the first frame.
    void this.loadOutlines().catch((error) => {
      this.manifest.datasets['outlines.bin'] = 'malformed'
      console.warn('[omniatlas] nebula outlines failed to load', error)
    })

    const m = this.manifest
    console.info(
      `[omniatlas] deep sky: ${m.ngc.drawn} NGC/IC objects ` +
        `(${m.ngc.measured} at a measured distance, ${m.ngc.directionOnly} direction-only on a ` +
        `${SHELL_PC / 1000} kpc shell), ${m.named.registered} named, ` +
        `${m.globulars.registered} Harris globulars`,
      m,
    )
  }

  // -------------------------------------------------------------------------
  // 1. The NGC/IC point field
  // -------------------------------------------------------------------------

  private async loadCatalogue(): Promise<void> {
    const [manifest, buffer, ids] = await Promise.all([
      fetchJson<BinaryManifest>(`${DATA}/ngc.json`),
      fetchBinary(`${DATA}/ngc.bin`),
      fetchJson<{ designations?: string[] }>(`${DATA}/ngc-ids.json`),
    ])
    if (this.engine.isDisposed) return
    if (!manifest || !buffer) {
      this.manifest.datasets['ngc.bin'] = 'missing'
      console.warn('[omniatlas] deep-sky catalogue unavailable; the NGC field will not be drawn')
      return
    }

    const count = manifest.recordCount ?? 0
    const typeField = manifest.fields.find((f) => f.name === 'type')
    const typeNames = typeField?.enum ?? []
    if (count <= 0 || typeNames.length === 0) {
      this.manifest.datasets['ngc.bin'] = 'malformed'
      console.warn('[omniatlas] deep-sky catalogue manifest is malformed; skipping')
      return
    }

    const designations = ids?.designations ?? []
    this.manifest.datasets['ngc-ids.json'] = designations.length ? 'loaded' : 'missing'
    for (let i = 0; i < designations.length; i++) this.designationToRow.set(designations[i], i)

    const raMicro = fieldView(buffer, manifest, 'raMicroDeg') as Uint32Array
    const decMicro = fieldView(buffer, manifest, 'decMicroDeg') as Int32Array
    const distancePc = fieldView(buffer, manifest, 'distancePc') as Float32Array
    const vmag = fieldView(buffer, manifest, 'vmag') as Int16Array
    const bmag = fieldView(buffer, manifest, 'bmag') as Int16Array
    const majAx = fieldView(buffer, manifest, 'majAx') as Uint16Array
    const types = fieldView(buffer, manifest, 'type') as Uint8Array
    const distanceKind = fieldView(buffer, manifest, 'distanceKind') as Uint8Array
    const redshiftValues = fieldView(buffer, manifest, 'redshift') as Float32Array
    // Copied, not aliased: a view would pin the whole 438 KB binary for the life of the
    // module to keep 70 KB of it. `loadNamed` runs after this, sequentially, inside the
    // same init — which is the only reason it can read these at all.
    this.rowDistanceKind = distanceKind.slice()
    this.rowRedshift = redshiftValues.slice()

    const dirs = new Float32Array(count * 3)
    const dists = new Float32Array(count)
    const radii = new Float32Array(count)
    const mags = new Float32Array(count)
    const colors = new Float32Array(count * 3)
    const outlineAngles = new Float32Array(count)

    const stats = this.manifest.ngc
    stats.recordsInFile = count
    const scratch = vec3d()
    const colorCache = new Map<DeepSkyCategory, THREE.Color>()

    let slot = 0
    for (let i = 0; i < count; i++) {
      const typeName = typeNames[types[i]] ?? 'Other'
      // Duplicate listings and entries the catalogue marks nonexistent are counted and
      // dropped: drawing them would double some objects and invent others.
      if (typeName === 'Dup' || typeName === 'NonEx') {
        stats.skippedDuplicateOrNonexistent++
        continue
      }
      const category = TYPE_CATEGORY[typeName] ?? 'other'

      const raDeg = raMicro[i] * 1e-6
      const decDeg = decMicro[i] * 1e-6
      // Stored as an ICRF direction; `rotateDirections` rotates it into each layer's
      // frame and scene basis when the buffers are built.
      sphericalToCartesian(scratch, raDeg, decDeg, 1)
      dirs[slot * 3] = scratch.x
      dirs[slot * 3 + 1] = scratch.y
      dirs[slot * 3 + 2] = scratch.z

      const measured = hasTrustworthyDistance(distanceKind[i], distancePc[i], redshiftValues[i])
      const dPc = measured ? distancePc[i] : 0
      dists[slot] = dPc

      let magnitude: number
      if (vmag[i] !== -32768) magnitude = vmag[i] * 0.01
      else if (bmag[i] !== -32768) magnitude = bmag[i] * 0.01
      else {
        magnitude = ASSUMED_MAGNITUDE
        stats.assumedMagnitude++
      }
      // Measured objects carry an absolute magnitude so the shader can recompute how
      // bright they look from wherever the camera actually is.
      mags[slot] = measured ? magnitude - 5 * (Math.log10(dPc) - 1) : magnitude

      // Half the major axis, at the distance we have. For a direction-only object that
      // "distance" is the shell, so the glyph keeps the angular size Earth measures —
      // the size is real, the depth is not.
      const majArcmin = majAx[i] === 65535 ? 0 : majAx[i] * 0.01
      const angularRadiusRad = (majArcmin / 2) * (Math.PI / 180 / 60)
      radii[slot] = angularRadiusRad * (measured ? dPc : SHELL_PC)

      let color = colorCache.get(category)
      if (!color) {
        color = categoryColor(category)
        colorCache.set(category, color)
      }
      colors[slot * 3] = color.r
      colors[slot * 3 + 1] = color.g
      colors[slot * 3 + 2] = color.b

      const bucket = (stats.byCategory[category] ??= { drawn: 0, measured: 0, directionOnly: 0 })
      bucket.drawn++
      if (measured) {
        bucket.measured++
        stats.measured++
        if (distanceKind[i] === 1) stats.measuredFromParallax++
        else stats.measuredFromRedshift++
      } else {
        bucket.directionOnly++
        stats.directionOnly++
      }

      this.rowToInstance.set(i, slot)
      slot++
    }
    stats.drawn = slot

    const colorAttribute = new THREE.InstancedBufferAttribute(colors.subarray(0, slot * 3), 3)
    const magAttribute = new THREE.InstancedBufferAttribute(mags.subarray(0, slot), 1)
    this.pointMagAttribute = magAttribute
    this.pointColorAttribute = colorAttribute

    for (const spec of LAYER_SPECS) {
      const k = 1 / spec.unitPc
      const geometry = new THREE.InstancedBufferGeometry()
      geometry.index = this.quad!.index
      geometry.setAttribute('position', this.quad!.getAttribute('position'))
      geometry.setAttribute('dsDir', new THREE.InstancedBufferAttribute(rotateDirections(dirs, slot, spec.frame), 3))
      geometry.setAttribute('dsDist', new THREE.InstancedBufferAttribute(scaled(dists, slot, k), 1))
      geometry.setAttribute('dsRadius', new THREE.InstancedBufferAttribute(scaled(radii, slot, k), 1))
      // Colour and magnitude are frame- and unit-free, so both copies share one buffer.
      geometry.setAttribute('dsMag', magAttribute)
      geometry.setAttribute('dsColor', colorAttribute)
      const outlineAttribute = new THREE.InstancedBufferAttribute(outlineAngles.slice(0, slot), 1)
      geometry.setAttribute('dsOutline', outlineAttribute)
      this.outlineAttributes.push(outlineAttribute)
      geometry.instanceCount = slot
      this.geometries.push(geometry)

      const material = new THREE.ShaderMaterial({
        uniforms: {
          uPixelWidth: { value: 1920 },
          uPixelHeight: { value: 1080 },
          uTanHalfFov: { value: 0.466 },
          uMagLimit: { value: 12.8 },
          // Up 1.25 with the sprite-width fix; see the note on the star field's uGain.
          uGain: { value: 0.069 },
          uShell: { value: SHELL_PC * k },
          uShellFade: { value: 1 },
          uMinPx: { value: 1.1 },
          uMaxPx: { value: 190 },
          uOutlineTakeoverPx: { value: 26 },
          // Half-gone at an object two hundred pixels across, gone at six hundred: by
          // then it is the subject of the frame, not a mark on a chart.
          uProxyTakeoverPx: { value: 100 },
          uSolFade: { value: 1 },
          uUnitPc: { value: spec.unitPc },
          uLayerFade: { value: spec.near ? 1 : 0 },
        },
        vertexShader: POINT_VERTEX,
        fragmentShader: POINT_FRAGMENT,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      })
      this.materials.push(material)
      ;(spec.near ? this.nearMaterials : this.farMaterials).push(material)

      const mesh = new THREE.Mesh(geometry, material)
      mesh.frustumCulled = false
      mesh.renderOrder = -8
      mesh.name = `deepsky:ngc:${spec.layer}`
      this.objects.push(mesh)
      ;(spec.near ? this.nearObjects : this.farObjects).push(mesh)
      this.engine.layer(spec.layer).scene.add(mesh)
    }
    this.manifest.datasets['ngc.bin'] = 'loaded'
  }

  // -------------------------------------------------------------------------
  // 2. The named objects, in the registry
  // -------------------------------------------------------------------------

  /**
   * `distanceKind` and `redshift` per catalogue row, kept from `ngc.bin`.
   *
   * `ngc-names.json` carries neither: it has no redshift at all, and spells
   * `distanceKind` as a string where the gate wants the binary's uint8. The named
   * loader therefore could not apply `hasTrustworthyDistance` even though the field
   * loader does, which is how 26 named objects came to be registered at Hubble-flow
   * distances that the very same module refuses to draw.
   */
  private rowDistanceKind: Uint8Array | null = null
  private rowRedshift: Float32Array | null = null

  private async loadNamed(): Promise<void> {
    const payload = await fetchJson<{ objects?: NamedObject[] }>(`${DATA}/ngc-names.json`)
    if (this.engine.isDisposed) return
    if (!payload?.objects?.length) {
      this.manifest.datasets['ngc-names.json'] = 'missing'
      console.warn('[omniatlas] deep-sky names unavailable; nothing will be searchable')
      return
    }

    const stats = this.manifest.named
    const ambiguous = collidingNames(payload.objects)

    for (const object of payload.objects) {
      if (!Number.isFinite(object.raDeg) || !Number.isFinite(object.decDeg)) continue
      if (NON_OBJECT_TYPES.has(object.type) || (STELLAR_TYPES.has(object.type) && object.messier == null)) {
        stats.skippedNonObject++
        continue
      }
      const category = TYPE_CATEGORY[object.type] ?? 'other'
      // The SAME gate the field uses, which this loader skipped.
      //
      // It checked only `distancePc > 0`, so a Hubble-flow distance derived from a
      // redshift below the peculiar-velocity floor was accepted here and rejected three
      // hundred lines up. The Large Magellanic Cloud was registered at 12.6 Mly — 77x
      // its true distance — stamped `provenance: 'measured'`, and because
      // `oneLabelPerObject` hands the marker to whichever row claims the larger radius,
      // and that radius is derived from the bogus distance, this row WON the label from
      // the correct 163 kly one. Double-clicking "Large Magellanic Cloud" flew the
      // camera clean out of the galaxy.
      //
      // Rejected rows fall through to the literature table and then to the direction-only
      // shell, exactly as an uncatalogued object does: a distance the module will not
      // draw is not a distance it should fly to either.
      const rowIndex = typeof object.i === 'number' ? object.i : -1
      const kinds = this.rowDistanceKind
      const redshifts = this.rowRedshift
      const catalogued =
        typeof object.distancePc === 'number' &&
        object.distancePc > 0 &&
        (kinds === null || redshifts === null || rowIndex < 0 || rowIndex >= kinds.length
          ? true
          : hasTrustworthyDistance(kinds[rowIndex], object.distancePc, redshifts[rowIndex]))
      // Fall back to a published distance before falling back to the shell. Without
      // this the Orion Nebula is 100 kpc away and 8,000 light years across.
      const literaturePc = catalogued
        ? null
        : (literatureDistancePc(object.designation, object.messier) ??
          LITERATURE_DISTANCE_PC[object.designation] ??
          null)
      const placed = catalogued || literaturePc !== null
      const distPc = catalogued ? (object.distancePc as number) : (literaturePc ?? SHELL_PC)

      const majAxArcmin = object.majAxArcmin || LITERATURE_MAJOR_AXIS_ARCMIN[object.designation]
      if (!majAxArcmin) {
        // No angular size in the row and none in the literature table either: nothing
        // to frame and nothing to draw, so it is not offered as a destination.
        stats.skippedSizeless++
        continue
      }
      // Counted after the size filter, not before, so the manifest's buckets describe
      // the rows that were actually registered.
      if (literaturePc !== null) stats.literature++

      // A radius is a physical size, and SHELL_PC is not a distance. Deriving one from
      // the other turns a placeholder into a measurement, so an object with no distance
      // gets no size either and is drawn as the bearing it actually is. This was briefly
      // reversed, and the Horsehead went into the registry at 87 pc across — 170 times
      // its real extent — under a field the inspector prints as "Mean radius, Measured".
      //
      // `framingRadiusMetres` carries the number a camera needs instead. It is the same
      // arithmetic, but it is in a field nothing presents as a property of the object.
      const angularSizeRadius = this.radiusFromAngularSize(majAxArcmin, distPc)
      // ...and a separation is not an extent either; see SEPARATION_NOT_EXTENT_TYPES.
      const separationOnly = SEPARATION_NOT_EXTENT_TYPES.has(object.type)
      const node = this.makeNode({
        id: `ngc:${object.designation}`,
        name: ambiguous.has(object.designation)
          ? `${this.displayName(object)} (${displayName(object.designation)})`
          : this.displayName(object),
        designation: object.designation,
        // The Messier number is the identity the Local Group and Local Volume tables
        // use for these same galaxies, and it is the only place the two can meet.
        designations: object.messier ? [object.designation, `M${object.messier}`] : undefined,
        catalogue: 'OpenNGC',
        objectClass: CATEGORY_OBJECT_CLASS[category],
        raDeg: object.raDeg,
        decDeg: object.decDeg,
        distancePc: distPc,
        radiusMetres: placed && !separationOnly ? angularSizeRadius : 0,
        framingRadiusMetres: angularSizeRadius,
        measured: placed,
        distanceSource: catalogued
          ? object.distanceKind === 'parallax'
            ? 'parallax'
            : 'redshift'
          : literaturePc !== null
            ? 'literature'
            : 'none',
        parentId: null,
      })
      this.engine.register(node)
      this.nodeIds.push(node.id)
      stats.registered++
      if (placed) stats.measured++
      else stats.directionOnly++
    }
    this.manifest.datasets['ngc-names.json'] = 'loaded'
  }

  private displayName(object: NamedObject): string {
    if (object.names?.length) return object.names[0]
    if (object.messier) return `Messier ${object.messier}`
    return object.designation
  }

  /** Half the major axis, carried out to a physical radius at the given distance. */
  private radiusFromAngularSize(majAxArcmin: number | null | undefined, distancePc: number): number {
    if (!majAxArcmin || majAxArcmin <= 0) return 0
    const angularRadiusRad = (majAxArcmin / 2) * (Math.PI / 180 / 60)
    return angularRadiusRad * distancePc * PC_M
  }

  private makeNode(spec: {
    id: string
    name: string
    designation: string
    /** Other catalogue designations for the same object; see `SceneNodeHandle`. */
    designations?: readonly string[]
    catalogue: string
    objectClass: string
    raDeg: number
    decDeg: number
    distancePc: number
    radiusMetres: number
    /** Defaults to `radiusMetres`; set it where the two legitimately differ. */
    framingRadiusMetres?: number
    measured: boolean
    distanceSource: DeepSkyNode['distanceSource']
    parentId: string | null
  }): DeepSkyNode {
    const icrf: Vec3d = sphericalToCartesian(vec3d(), spec.raDeg, spec.decDeg, spec.distancePc * PC_M)
    const world = convertFrame(vec3d(), icrf, 'icrf', REGISTRY_FRAME)
    return {
      id: spec.id,
      designations: spec.designations,
      worldPosition: world,
      frame: REGISTRY_FRAME,
      radiusMetres: spec.radiusMetres,
      framingRadiusMetres: spec.framingRadiusMetres ?? spec.radiusMetres,
      layer: LAYER,
      objectClass: spec.objectClass,
      name: spec.name,
      parentId: spec.parentId,
      // A direction-only object has no position, only a bearing. Saying 'measured'
      // here would launder a projection into an observation.
      //
      // Nor is a literature distance one. `deepSkyDistances` says so itself — a
      // consensus figure from the general literature, no primary reduction and no
      // uncertainty travelling with it — but every row placed from that table still
      // came through here badged 'Measured', and the radius computed from it with
      // them. 'Derived' is what the table asks for and what the chip should read.
      provenance: !spec.measured ? 'illustration' : spec.distanceSource === 'literature' ? 'derived' : 'measured',
      directionOnly: !spec.measured,
      distanceSource: spec.distanceSource,
      designation: spec.designation,
      catalogue: spec.catalogue,
    }
  }

  // -------------------------------------------------------------------------
  // 3. The Harris globular clusters
  // -------------------------------------------------------------------------

  private async loadGlobulars(): Promise<void> {
    const payload = await fetchJson<{ count?: number; columns?: GlobularColumns }>(`${DATA}/globulars.json`)
    if (this.engine.isDisposed) return
    const columns = payload?.columns
    if (!columns?.id?.length) {
      this.manifest.datasets['globulars.json'] = 'missing'
      console.warn('[omniatlas] Harris globular catalogue unavailable')
      return
    }

    const count = columns.id.length
    const dirs = new Float32Array(count * 3)
    const dists = new Float32Array(count)
    const radii = new Float32Array(count)
    const absMags = new Float32Array(count)
    const colors = new Float32Array(count * 3)
    const color = categoryColor('globularCluster')
    const scratch = vec3d()

    let slot = 0
    let nearest = Infinity
    let farthest = 0
    let duplicates = 0
    let suppressed = 0
    for (let i = 0; i < count; i++) {
      const raDeg = columns.raDeg[i]
      const decDeg = columns.decDeg[i]
      const rKpc = columns.rSunKpc[i]
      // Harris leaves fields blank rather than estimating them; so do we.
      if (!Number.isFinite(raDeg) || !Number.isFinite(decDeg) || !Number.isFinite(rKpc) || rKpc <= 0) continue
      const distPc = rKpc * 1000

      sphericalToCartesian(scratch, raDeg, decDeg, 1)
      dirs[slot * 3] = scratch.x
      dirs[slot * 3 + 1] = scratch.y
      dirs[slot * 3 + 2] = scratch.z
      dists[slot] = distPc

      const halfLightArcmin = columns.halfLightRadiusArcmin[i]
      const radiusPc =
        typeof halfLightArcmin === 'number' && halfLightArcmin > 0
          ? halfLightArcmin * (Math.PI / 180 / 60) * distPc
          : 3 // a bare minimum so a cluster without a published r_h still has an extent
      radii[slot] = radiusPc

      const absMagV = columns.absMagV[i]
      absMags[slot] = typeof absMagV === 'number' ? absMagV : -5
      colors[slot * 3] = color.r
      colors[slot * 3 + 1] = color.g
      colors[slot * 3 + 2] = color.b

      // Half of these clusters are also NGC/IC entries, and OpenNGC's distance for
      // them is a different (often worse, sometimes absent) measurement. Harris wins —
      // it is the dedicated catalogue — so the duplicate registry entry is dropped and
      // the duplicate sprite is suppressed rather than being drawn twice in two places.
      const ngcDesignation = openNgcDesignation(columns.id[i])
      let inheritedName: string | null = null
      if (ngcDesignation) {
        const duplicate = this.engine.node(`ngc:${ngcDesignation}`) as DeepSkyNode | null
        if (duplicate) {
          inheritedName = duplicate.name
          this.engine.unregister(duplicate.id)
          const at = this.nodeIds.indexOf(duplicate.id)
          if (at >= 0) this.nodeIds.splice(at, 1)
          this.manifest.named.registered--
          // The removed row was counted in exactly one of the two buckets that are
          // supposed to add up to `registered`; decrementing only the total left the
          // manifest reporting 191 + 34 against a registered count of 194.
          if (duplicate.directionOnly) this.manifest.named.directionOnly--
          else this.manifest.named.measured--
          duplicates++
        }
        const row = this.designationToRow.get(ngcDesignation)
        const instance = row === undefined ? undefined : this.rowToInstance.get(row)
        if (instance !== undefined && this.pointMagAttribute) {
          // Past the magnitude limit by construction: the vertex shader collapses it.
          this.pointMagAttribute.setX(instance, 99)
          suppressed++
        }
      }

      const name = columns.name[i] ?? inheritedName ?? columns.id[i]
      const node = this.makeNode({
        id: `gc:${columns.id[i].replace(/\s+/g, '').toLowerCase()}`,
        name,
        designation: columns.id[i],
        catalogue: 'Harris 1996 (2010 edition)',
        objectClass: 'cluster',
        raDeg,
        decDeg,
        distancePc: distPc,
        radiusMetres: radiusPc * PC_M,
        measured: true,
        distanceSource: 'harris-2010',
        parentId: 'milky-way',
      })
      this.engine.register(node)
      this.nodeIds.push(node.id)

      nearest = Math.min(nearest, rKpc)
      farthest = Math.max(farthest, rKpc)
      slot++
    }

    if (slot === 0) {
      this.manifest.datasets['globulars.json'] = 'malformed'
      return
    }

    const magAttribute = new THREE.InstancedBufferAttribute(absMags.subarray(0, slot), 1)
    const colorAttribute = new THREE.InstancedBufferAttribute(colors.subarray(0, slot * 3), 3)

    for (const spec of LAYER_SPECS) {
      const k = 1 / spec.unitPc
      const geometry = new THREE.InstancedBufferGeometry()
      geometry.index = this.quad!.index
      geometry.setAttribute('position', this.quad!.getAttribute('position'))
      geometry.setAttribute('gcDir', new THREE.InstancedBufferAttribute(rotateDirections(dirs, slot, spec.frame), 3))
      geometry.setAttribute('gcDist', new THREE.InstancedBufferAttribute(scaled(dists, slot, k), 1))
      geometry.setAttribute('gcRadius', new THREE.InstancedBufferAttribute(scaled(radii, slot, k), 1))
      geometry.setAttribute('gcAbsMag', magAttribute)
      geometry.setAttribute('gcColor', colorAttribute)
      geometry.instanceCount = slot
      this.geometries.push(geometry)

      const material = new THREE.ShaderMaterial({
        uniforms: {
          uPixelWidth: { value: 1920 },
          uPixelHeight: { value: 1080 },
          uTanHalfFov: { value: 0.466 },
          uMagLimit: { value: 12.8 },
          // Up 1.25 with the sprite-width fix; see the note on the star field's uGain.
          uGain: { value: 0.088 },
          uMinPx: { value: 1.6 },
          uProxyTakeoverPx: { value: 45 },
          uMaxPx: { value: 150 },
          uUnitPc: { value: spec.unitPc },
          uLayerFade: { value: spec.near ? 1 : 0 },
        },
        vertexShader: GLOBULAR_VERTEX,
        fragmentShader: GLOBULAR_FRAGMENT,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      })
      this.materials.push(material)
      ;(spec.near ? this.nearMaterials : this.farMaterials).push(material)

      const mesh = new THREE.Mesh(geometry, material)
      mesh.frustumCulled = false
      mesh.renderOrder = -7
      mesh.name = `deepsky:globulars:${spec.layer}`
      this.objects.push(mesh)
      ;(spec.near ? this.nearObjects : this.farObjects).push(mesh)
      this.engine.layer(spec.layer).scene.add(mesh)
    }

    if (this.pointMagAttribute && suppressed > 0) this.pointMagAttribute.needsUpdate = true

    this.manifest.globulars = {
      registered: slot,
      nearestKpc: nearest,
      farthestKpc: farthest,
      replacedNgcEntries: duplicates,
      suppressedNgcSprites: suppressed,
    }
    this.manifest.datasets['globulars.json'] = 'loaded'
  }

  // -------------------------------------------------------------------------
  // 4. The traced nebula outlines
  // -------------------------------------------------------------------------

  private async loadOutlines(): Promise<void> {
    const [manifest, buffer] = await Promise.all([
      fetchJson<
        BinaryManifest & { outlines?: { i: number; object: string; level: number; rings: number }[] }
      >(`${DATA}/outlines.json`),
      fetchBinary(`${DATA}/outlines.bin`),
    ])
    if (this.engine.isDisposed) return
    if (!manifest || !buffer || !manifest.outlines?.length) {
      this.manifest.datasets['outlines.bin'] = 'missing'
      console.warn('[omniatlas] nebula outlines unavailable; the sky will be points only')
      return
    }

    const raMid = fieldView(buffer, manifest, 'outlineRaMid') as Float32Array
    const decMid = fieldView(buffer, manifest, 'outlineDecMid') as Float32Array
    const raScale = fieldView(buffer, manifest, 'outlineRaScale') as Float32Array
    const decScale = fieldView(buffer, manifest, 'outlineDecScale') as Float32Array
    const ringStart = fieldView(buffer, manifest, 'outlineRingStart') as Uint32Array
    const ringCount = fieldView(buffer, manifest, 'outlineRingCount') as Uint32Array
    const pointStart = fieldView(buffer, manifest, 'ringPointStart') as Uint32Array
    const pointCount = fieldView(buffer, manifest, 'ringPointCount') as Uint32Array
    const pointRa = fieldView(buffer, manifest, 'pointRa') as Int16Array
    const pointDec = fieldView(buffer, manifest, 'pointDec') as Int16Array

    const outlineCount = raMid.length
    const totalPoints = pointRa.length

    // Designation -> catalogue row (built with the catalogue), so an outline can find
    // the sprite it should tell to step aside.
    const rowOf = this.designationToRow

    const positions = new Float32Array(totalPoints * 3)
    const colors = new Float32Array(totalPoints * 3)
    const angular = new Float32Array(totalPoints)
    const levels = new Float32Array(totalPoints)
    const lineIndices: number[] = []
    const fillIndices: number[] = []

    const scratch = vec3d()
    const contour: THREE.Vector2[] = []
    let matched = 0
    let filledRings = 0
    let rings = 0

    for (let o = 0; o < outlineCount; o++) {
      const meta = manifest.outlines[o]
      const objectName = meta?.object ?? ''
      const level = meta?.level ?? 1
      const row = rowOf.get(objectName)
      const instance = row === undefined ? undefined : this.rowToInstance.get(row)
      // A matched outline takes the colour the catalogue already gave its object, so
      // the contour and its sprite are visibly the same thing. The thirteen regional
      // complexes that are not NGC objects at all (Orion, Cygnus, the LMC...) fall
      // back to the nebula hue.
      const color = categoryColor('nebula')
      if (instance !== undefined && this.pointColorAttribute) {
        matched++
        color.setRGB(
          this.pointColorAttribute.getX(instance),
          this.pointColorAttribute.getY(instance),
          this.pointColorAttribute.getZ(instance),
        )
      }

      // The outline's own angular radius, used for the screen-size fade and, where it
      // matches a catalogue row, to retire that object's point sprite.
      const cosDec = Math.cos((decMid[o] * Math.PI) / 180)
      let angularRadiusDeg = 0
      for (let r = ringStart[o]; r < ringStart[o] + ringCount[o]; r++) {
        for (let p = pointStart[r]; p < pointStart[r] + pointCount[r]; p++) {
          const dRa = pointRa[p] * raScale[o] * cosDec
          const dDec = pointDec[p] * decScale[o]
          const d = Math.hypot(dRa, dDec)
          if (d > angularRadiusDeg) angularRadiusDeg = d
        }
      }

      if (instance !== undefined) {
        for (const attribute of this.outlineAttributes) {
          if (angularRadiusDeg > attribute.getX(instance)) attribute.setX(instance, angularRadiusDeg)
        }
      }

      for (let r = ringStart[o]; r < ringStart[o] + ringCount[o]; r++) {
        const first = pointStart[r]
        const n = pointCount[r]
        if (n < 3) continue
        rings++
        contour.length = 0
        for (let k = 0; k < n; k++) {
          const p = first + k
          const dRa = pointRa[p] * raScale[o]
          const dDec = pointDec[p] * decScale[o]
          sphericalToCartesian(scratch, raMid[o] + dRa, decMid[o] + dDec, 1)
          worldToSceneBasis(scratch, scratch)
          positions[p * 3] = scratch.x
          positions[p * 3 + 1] = scratch.y
          positions[p * 3 + 2] = scratch.z
          colors[p * 3] = color.r
          colors[p * 3 + 1] = color.g
          colors[p * 3 + 2] = color.b
          angular[p] = angularRadiusDeg
          levels[p] = level
          // Triangulation happens in the local tangent plane, where the contour is a
          // plain 2D polygon; the vertices emitted are still the 3D directions above.
          contour.push(new THREE.Vector2(dRa * cosDec, dDec))
          lineIndices.push(p, first + ((k + 1) % n))
        }

        // Isophote contours are traced by hand and occasionally self-intersect, which
        // earcut cannot triangulate. A ring that fails keeps its outline and loses only
        // its fill.
        try {
          const faces = THREE.ShapeUtils.triangulateShape(contour, [])
          if (faces.length > 0) {
            filledRings++
            for (const face of faces) {
              fillIndices.push(first + face[0], first + face[1], first + face[2])
            }
          }
        } catch {
          /* outline only */
        }
      }
    }

    if (lineIndices.length === 0) {
      this.manifest.datasets['outlines.bin'] = 'malformed'
      return
    }

    // One set of attributes, two index buffers: the fill and the stroke are the same
    // 101,566 vertices read two different ways.
    const dirAttribute = new THREE.Float32BufferAttribute(positions, 3)
    const colorAttribute = new THREE.Float32BufferAttribute(colors, 3)
    const angularAttribute = new THREE.Float32BufferAttribute(angular, 1)
    const levelAttribute = new THREE.Float32BufferAttribute(levels, 1)

    const attach = (geometry: THREE.BufferGeometry) => {
      geometry.setAttribute('oDir', dirAttribute)
      geometry.setAttribute('oColor', colorAttribute)
      geometry.setAttribute('oAngularRadius', angularAttribute)
      geometry.setAttribute('oLevel', levelAttribute)
      this.geometries.push(geometry)
      return geometry
    }

    const makeMaterial = (alpha: number, fadeInPx: number) => {
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uShellPc: { value: SHELL_PC },
          uPixelHeight: { value: 1080 },
          uTanHalfFov: { value: 0.466 },
          uFadeInPx: { value: fadeInPx },
          uSolFade: { value: 1 },
          uAlpha: { value: alpha },
        },
        vertexShader: OUTLINE_VERTEX,
        fragmentShader: OUTLINE_FRAGMENT,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
      })
      this.materials.push(material)
      return material
    }

    const layer = this.engine.layer(LAYER)

    if (fillIndices.length > 0) {
      const fillGeometry = attach(new THREE.BufferGeometry())
      fillGeometry.setIndex(fillIndices)
      const fill = new THREE.Mesh(fillGeometry, makeMaterial(0.1, 14))
      fill.frustumCulled = false
      fill.renderOrder = -9
      fill.name = 'deepsky:outline-fill'
      this.outlineFill = fill
      layer.scene.add(fill)
    }

    const lineGeometry = attach(new THREE.BufferGeometry())
    lineGeometry.setIndex(lineIndices)
    const lines = new THREE.LineSegments(lineGeometry, makeMaterial(0.5, 14))
    lines.frustumCulled = false
    lines.renderOrder = -8
    lines.name = 'deepsky:outline-lines'
    this.outlineLines = lines
    layer.scene.add(lines)

    for (const attribute of this.outlineAttributes) attribute.needsUpdate = true

    this.manifest.outlines = {
      outlines: outlineCount,
      rings,
      points: totalPoints,
      matchedToCatalogue: matched,
      filledRings,
    }
    this.manifest.datasets['outlines.bin'] = 'loaded'
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  preRender(ctx: FrameContext): void {
    const layer = this.engine.layer(LAYER)
    const farLayer = this.engine.layer(FAR_LAYER)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const pixelWidth = ctx.width * dpr
    const pixelHeight = ctx.height * dpr
    const tanHalfFov = Math.tan((ctx.fovDegrees * Math.PI) / 360)

    // Narrowing the field reveals fainter objects, exactly as it does in a telescope
    // and exactly as the star field already behaves.
    const magLimit = 12.4 + 5 * Math.log10(50 / Math.max(ctx.fovDegrees, 1))

    // Distance from the Sun: both the shell and the traced contours are things seen
    // FROM HERE, so both have to let go as the camera leaves.
    const distancePc = layer.cameraDistanceMetres / PC_M
    const shellFade = 1 - smoothstep(SHELL_FADE_PC[0], SHELL_FADE_PC[1], distancePc)
    const outlineFade = 1 - smoothstep(OUTLINE_FADE_PC[0], OUTLINE_FADE_PC[1], distancePc)
    // The stellar copy hands the sky over to the galactic copy inside the overlap of
    // the two bands, so the total brightness stays constant through the handover.
    const handover = smoothstep(HANDOVER_PC[0], HANDOVER_PC[1], distancePc)

    // Scale gate.
    //
    // The existing fades are all keyed on distance FROM THE SUN, which is zero while
    // the camera is anywhere in the solar system — so none of them fired, and 13,371
    // catalogue objects projected onto a 100 kpc shell drew themselves across a seven
    // AU view of the inner planets as a wall of white speckle. Distance from the Sun
    // is the wrong question; how wide the view is, is the right one. A deep-sky object
    // only means anything once the view is wider than the solar system itself.
    //
    const logSpan = Math.log10(Math.max(ctx.viewSpanMetres, 1))
    const spanGate = smoothstep(Math.log10(2e14), Math.log10(2e16), logSpan)

    // renderOpacity rides on the same gate: it is the engine's verdict on how much of
    // a layer belongs in this frame, and it drops to a backdrop value when that layer is
    // only on screen because nothing nearer is drawing a sky. Drawn at full strength in
    // that role the catalogue stops being a backdrop and becomes the subject again.
    // spanOpacity is deliberately not used here: it is the raw band measure and knows
    // nothing about the layer's role.
    //
    // There are TWO verdicts, because there are two copies of the catalogue in two
    // different layers, and the handover between them happens exactly where the near
    // one is going out. Gating both on the stellar layer's verdict — which this did —
    // meant the galactic copy was dimmed by the fade of the layer it was taking over
    // FROM: leaving the solar system, the near copy handed the sky to a far copy that
    // the same multiplication was driving to zero, and the catalogue blinked out in the
    // middle of a crossfade designed to hold its brightness constant.
    const nearGate = spanGate * layer.renderOpacity
    const farGate = spanGate * farLayer.renderOpacity

    for (const material of this.materials) {
      const u = material.uniforms
      if (u.uPixelWidth) u.uPixelWidth.value = pixelWidth
      if (u.uPixelHeight) u.uPixelHeight.value = pixelHeight
      if (u.uTanHalfFov) u.uTanHalfFov.value = tanHalfFov
      if (u.uMagLimit) u.uMagLimit.value = magLimit
      if (u.uShellFade) u.uShellFade.value = shellFade
      if (u.uSolFade) u.uSolFade.value = outlineFade
    }
    const nearFade = (1 - handover) * nearGate
    const farFade = handover * farGate
    for (const material of this.nearMaterials) material.uniforms.uLayerFade.value = nearFade
    for (const material of this.farMaterials) material.uniforms.uLayerFade.value = farFade

    // Skip the draw entirely once a copy's gate is shut, rather than paying for 13,371
    // instances that resolve to zero alpha. Per copy, for the same reason the fades are.
    const nearDrawable = nearFade > 0.004
    const farDrawable = farFade > 0.004
    for (const object of this.nearObjects) object.visible = nearDrawable
    for (const object of this.farObjects) object.visible = farDrawable

    // The outlines live in the stellar layer only, so they follow the near copy.
    if (this.outlineFill) this.outlineFill.visible = nearDrawable && outlineFade > 0.01
    if (this.outlineLines) this.outlineLines.visible = nearDrawable && outlineFade > 0.01
  }

  dispose(): void {
    for (const object of this.objects) object.removeFromParent()
    this.objects.length = 0
    this.nearObjects.length = 0
    this.farObjects.length = 0
    this.outlineFill = null
    this.outlineLines = null

    for (const geometry of this.geometries) geometry.dispose()
    this.geometries.length = 0
    for (const material of this.materials) material.dispose()
    this.materials.length = 0
    this.nearMaterials.length = 0
    this.farMaterials.length = 0
    this.quad?.dispose()
    this.quad = null

    for (const id of this.nodeIds) this.engine?.unregister(id)
    this.nodeIds.length = 0
    this.rowToInstance.clear()
    this.outlineAttributes.length = 0
  }
}

/**
 * Rotate a run of ICRF unit directions into another frame's scene basis.
 *
 * The buffers stay unit vectors through this: the frame rotation is orthonormal, so
 * nothing here can push a vertex attribute out of [-1, 1].
 */
function rotateDirections(source: Float32Array, count: number, frame: FrameId): Float32Array {
  const out = new Float32Array(count * 3)
  const v = vec3d()
  const w = vec3d()
  for (let i = 0; i < count; i++) {
    v.x = source[i * 3]
    v.y = source[i * 3 + 1]
    v.z = source[i * 3 + 2]
    convertFrame(w, v, 'icrf', frame)
    worldToSceneBasis(w, w)
    out[i * 3] = w.x
    out[i * 3 + 1] = w.y
    out[i * 3 + 2] = w.z
  }
  return out
}

/**
 * Harris writes "NGC 6121" and "NGC 104"; OpenNGC writes "NGC6121" and "NGC0104".
 * Returns the OpenNGC spelling, or null for the clusters (Palomar, Terzan, 2MS-GC…)
 * that have no NGC or IC number at all.
 */
function openNgcDesignation(harrisId: string): string | null {
  const match = /^(NGC|IC)\s*(\d+)\s*([A-Za-z]?)$/.exec(harrisId.trim())
  if (!match) return null
  return `${match[1]}${match[2].padStart(4, '0')}${match[3].toUpperCase()}`
}

/** Copy `count` values scaled by `k` — parsecs into whatever unit a layer uses. */
function scaled(source: Float32Array, count: number, k: number): Float32Array {
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) out[i] = source[i] * k
  return out
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

export default function createDeepSkyModule(): AtlasModule {
  return new DeepSkyModule()
}
