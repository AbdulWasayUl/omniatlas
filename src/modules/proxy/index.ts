import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { AtlasModule, Engine, FrameContext, SceneNodeHandle } from '../../core/Engine'
import type { LayerId } from '../../core/Layer'
import { type Vec3d, convertFrame, distance3d, vec3d } from '../../core/world'

/**
 * Close-range stand-ins for objects that are only ever drawn as a point.
 *
 * Most of the atlas is catalogue data: 1,500 registered objects whose entire visual
 * existence is one instanced quad a few pixels across. That is the right call at
 * survey scale and completely wrong the moment someone flies to one. Before this
 * module, arriving at Ceres put the camera 1,500 km above a 940 km dwarf planet and
 * drew nothing at all, and the same was true of every named asteroid, comet, nebula,
 * cluster and galaxy in the registry — 1,480 of the 1,514 objects you can search for.
 *
 * So: when the camera anchors on a node that owns no geometry, build something at the
 * node's measured size and position, and throw it away when the anchor moves on. One
 * object exists at a time, so the cost is a single build rather than 1,480 meshes that
 * are off-screen forever. That also sets the budget: whatever is on screen here is the
 * only thing on screen, so the shaders can be expensive as long as the geometry is not.
 *
 * ## What these are, and are not
 *
 * The shapes are ILLUSTRATION. We have a measured position and a measured (or
 * size-derived) radius for these objects and nothing else — no shape model, no
 * resolved image, no density profile. A proxy therefore commits to exactly those two
 * measurements and invents the rest from a hash of the object's own identifier, which
 * at least makes it stable: the same object looks the same on every visit and in every
 * shared link. The inspector says so, and `isProxy` is what it reads.
 *
 * The alternative — leaving the screen empty — is not more honest. It just fails to
 * say anything at all, and it reads as a bug, because it is one.
 */

/** Hash a string to a 32-bit seed, so a proxy is stable across sessions and links. */
function hashId(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32, the same PRNG the galaxy field and asteroid belt use. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A soft round dot, used by every additive point representation here. */
let dotTexture: THREE.Texture | null = null
function softDot(): THREE.Texture {
  if (dotTexture) return dotTexture
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.42)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  dotTexture = new THREE.CanvasTexture(canvas)
  dotTexture.colorSpace = THREE.SRGBColorSpace
  return dotTexture
}

/**
 * A lumpy ball.
 *
 * Small bodies are not spheres, and drawing a billiard ball where a 500 km rubble pile
 * belongs misrepresents the one thing the shape could convey. The displacement is a sum
 * of six sinusoids along random axes — smooth, seamless on a sphere, and cheap. Its
 * amplitude falls with radius, because self-gravity really does round bodies off above
 * a few hundred kilometres. A second, higher-frequency octave at a tenth the amplitude
 * gives the terminator something to catch, which is what reads as regolith.
 */
export function lumpySphere(random: () => number, irregularity: number): THREE.BufferGeometry {
  // `PolyhedronGeometry` emits three unshared vertices per triangle, so
  // `computeVertexNormals` on it can only write one constant normal per face and Ceres
  // arrived as the 720-facet solid it is built from. Welding first is what turns the
  // facets back into a surface — and it is also the cheaper mesh: at detail 6 the 2,940
  // loose vertices collapse to 492 shared ones. The uv and normal attributes have to go
  // before the weld, because the uv seam would keep its duplicates and leave one
  // meridian flat-shaded.
  const faces = new THREE.IcosahedronGeometry(1, 24)
  faces.deleteAttribute('uv')
  faces.deleteAttribute('normal')
  const geometry = mergeVertices(faces, 1e-4)
  faces.dispose()
  const axes: THREE.Vector3[] = []
  const frequencies: number[] = []
  for (let i = 0; i < 10; i++) {
    axes.push(new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize())
    frequencies.push(i < 6 ? 1.4 + random() * 3.6 : 9 + random() * 11)
  }
  // Craters, because that is what the surface of a small body is.
  //
  // Sine octaves alone give a lumpy outline and a smooth face, which at close range
  // reads as modelling clay: a comet nucleus arrived as a featureless grey pebble.
  // Impacts are the one feature every airless body in the solar system has, they are
  // the same shape on all of them — a bowl inside a raised rim — and their
  // size-frequency distribution is a power law, so a handful of big ones and many
  // small ones is not a stylistic choice. Nothing here claims a PARTICULAR crater is
  // there; the Inspector badges the whole stand-in as an illustration.
  const craters: { axis: THREE.Vector3; angle: number; depth: number }[] = []
  for (let i = 0; i < 70; i++) {
    // Biased small, the way a real crater population is: a couple of big basins and
    // a lot of pits. Capped at 0.2 rad because a mesh this coarse cannot hold the rim
    // of anything larger without it reading as a dent in a balloon.
    const u = random()
    const angle = 0.035 + 0.165 * u * u
    craters.push({
      axis: new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize(),
      angle,
      // Depth to DIAMETER about 0.13 — simple craters run 0.2 and large ones are
      // shallower still, and the visible surface is mostly degraded old ones.
      depth: angle * 0.26 * (0.7 + 0.6 * random()),
    })
  }

  const position = geometry.attributes.position as THREE.BufferAttribute
  const v = new THREE.Vector3()
  const dir = new THREE.Vector3()
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i)
    let displacement = 0
    for (let a = 0; a < 6; a++) displacement += Math.sin(v.dot(axes[a]) * frequencies[a] + a) / 6
    let fine = 0
    for (let a = 6; a < axes.length; a++) fine += Math.sin(v.dot(axes[a]) * frequencies[a] + a) / 4
    dir.copy(v).normalize()
    let pits = 0
    for (const crater of craters) {
      // Angular distance from the crater centre, in crater radii.
      const t = Math.acos(THREE.MathUtils.clamp(dir.dot(crater.axis), -1, 1)) / crater.angle
      if (t > 1.6) continue
      // A bowl inside a rim: the floor is a paraboloid, the rim a narrow ridge just
      // outside the edge, and both vanish smoothly where the ejecta blanket would.
      if (t < 1) pits -= crater.depth * (1 - t * t)
      const rim = (t - 1) / 0.22
      pits += crater.depth * 0.42 * Math.exp(-rim * rim)
    }
    // Craters are NOT scaled by `irregularity`: that number says how far the body is
    // from hydrostatic equilibrium, and a round body is still cratered — Ceres, the
    // Moon and Mercury are the obvious cases. Tying them together made Ceres a
    // billiard ball again, since its irregularity floors at 0.02. The crater depths
    // are already in units of the body radius, at the measured depth-to-diameter.
    v.multiplyScalar(1 + displacement * irregularity + fine * irregularity * 0.1 + pits)
    position.setXYZ(i, v.x, v.y, v.z)
  }
  // Shared vertices have already moved as one, so the averaged normal is the surface
  // normal rather than a face normal.
  geometry.computeVertexNormals()
  return geometry
}

/**
 * The size to DRAW a stand-in at: the catalogue's radius, or the framing size when the
 * catalogue records none.
 *
 * Reaching for `framingRadiusMetres` here is not the placeholder-as-measurement the
 * registry forbids. Nothing this module draws is a measurement — the shapes are
 * illustration and the inspector says so — and the alternative is worse than a
 * nominal size: with the comets, the CF4 groups and the direction-only deep-sky rows
 * all now honestly reporting radius 0, gating on `radiusMetres` alone flew the camera
 * to thirty-four comets and showed the user empty sky. `radiusMetres` stays 0
 * everywhere it is read as a fact.
 */
export function drawnRadiusMetres(node: SceneNodeHandle): number {
  return node.radiusMetres > 0 ? node.radiusMetres : (node.framingRadiusMetres ?? 0)
}

/** Additive points from a position list, as one draw call. `size` is in body radii. */
function pointCloud(positions: Float32Array, colors: Float32Array, size: number, opacity: number): THREE.Points {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const material = new THREE.PointsMaterial({
    size,
    map: softDot(),
    vertexColors: true,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  })
  return new THREE.Points(geometry, material)
}

/**
 * Which layer draws a proxy.
 *
 * Solar-system bodies stay in the heliocentric layer: that is where the solar
 * module's point light lives, and a rock drawn anywhere else is a black ball. Its
 * origin is the Sun and nothing in it is more than a few hundred AU away, so
 * precision is not in question.
 *
 * Everything else goes in the system layer, which the engine re-origins onto the
 * anchor every time the anchor changes. That matters more than the unit does. The
 * cosmic layer measures in megaparsecs from a supergalactic origin, and asking it to
 * draw TON 618's 1,300 AU horizon means resolving one part in 10^15 of a coordinate
 * 1.7 gigaparsecs long — the near plane alone swallowed the entire object. Anchored
 * at the origin instead, the same horizon is 2x10^8 units across and ordinary.
 *
 * Nothing drawn this way needs a light, which is what makes the trade available:
 * nebulae, clusters, galaxies, stars and accretion discs are all self-lit.
 */
function proxyLayerFor(node: SceneNodeHandle): LayerId {
  return node.layer === 'helio' ? 'helio' : 'system'
}

/**
 * Every layer `proxyLayerFor` can return.
 *
 * `forceActive` is recomputed over this list each frame rather than toggled as proxies
 * come and go, so a layer is on exactly while something in it is live.
 */
const PROXY_LAYERS: readonly LayerId[] = ['helio', 'system']

/**
 * The catalogue's morphology class for a galaxy, which `SceneNodeHandle` does not
 * carry yet. Read through this so the proxy already does the right thing the moment
 * the galaxy and cosmos modules start setting it; until then every galaxy falls
 * through to the spiral branch, which is what it used to get unconditionally.
 */
interface MorphologyHint {
  proxyMorphology?: string
}

type GalaxyForm = 'elliptical' | 'lenticular' | 'irregular' | 'spiral'

/** de Vaucouleurs class to the handful of shapes a point cloud can actually show. */
export function galaxyForm(morphology: string | undefined): GalaxyForm {
  const type = morphology?.trim()
  if (!type) return 'spiral'
  if (/^(E|cE|dE|dSph|cD)/i.test(type)) return 'elliptical'
  if (/^(S0|SB0|L)/i.test(type)) return 'lenticular'
  if (/^(Im|IB|I\b|Irr|Sm|SBm|dIr|BCD|Pec)/i.test(type)) return 'irregular'
  return 'spiral'
}

/** Everything a built proxy needs for its lifetime. */
interface Proxy {
  nodeId: string
  layerId: LayerId
  group: THREE.Group
  /**
   * Called every frame with the apparent-size fade, 0 to 1, and an immersion factor.
   *
   * A closure rather than a material reference because the black hole's fade lives in
   * shader uniforms, and because the one OPAQUE mesh in each proxy used to be left out
   * of this list entirely — so a rock or a star snapped to full strength the instant
   * its point representation stopped drawing, while every additive part around it
   * faded in properly.
   *
   * `immersion` thins the ADDITIVE clouds back out as the object grows in the frame:
   * `fade` clamps at 1 and never comes back down, so flying INTO a nebula only ever
   * accumulated more overlapping sprites until the frame went white. A solid body
   * does not thin out when you get close to it and must ignore the second argument.
   *
   * It is NOT a late-arriving safety net. It reaches the standard 4.2-radii arrival
   * framing already biting: see IMMERSION_KNEE for the knee, the numbers at arrival,
   * and why the base opacities below are the numbers they are.
   */
  fading: ((fade: number, immersion: number) => void)[]
  /**
   * Point materials, with their size as a fraction of the object's radius.
   *
   * `PointsMaterial.size` is in the object's LOCAL space and is not multiplied by the
   * object's scale — three.js computes `gl_PointSize = size * scale / -mvPosition.z`
   * straight from the uniform. Since a proxy carries its entire physical size in the
   * group's scale, a size set at build time is off by that factor: a nebula whose
   * group scales by 1.7e11 drew points 3e-10 pixels across. It has to be rescaled
   * whenever the group's scale is recomputed, which is every frame.
   */
  points: { material: THREE.PointsMaterial; sizeFraction: number }[]
  /** Set only for black holes; see `updateBlackHole`. */
  blackHole?: BlackHoleState
  dispose: () => void
}

/** The camera-dependent state of a black hole proxy. */
interface BlackHoleState {
  discRoot: THREE.Object3D
  disc: THREE.ShaderMaterial
  shadow: THREE.ShaderMaterial
  ring: THREE.ShaderMaterial
  /** Disc normal, in the proxy group's frame. */
  normal: THREE.Vector3
  /** False until the first frame has placed the disc, which snaps rather than eases. */
  oriented: boolean
}

/**
 * Apparent radius in pixels below which a proxy says nothing a point has not already
 * said, and above which it is the only thing that can say it.
 */
const FADE_IN_PX = 3
const FADE_FULL_PX = 14

/**
 * Apparent radius, as a fraction of the frame height, at which the additive clouds
 * start thinning out.
 *
 * A fraction of the frame and not a pixel count, because the same object at the same
 * framing has twice the apparent radius in a window twice as tall, and used to thin
 * twice as hard for it.
 *
 * 0.14 is about a seventh of the frame height, so thinning starts when the object's
 * apparent DIAMETER covers a little over a quarter of the frame. The standard arrival
 * framing — 4.2 radii at a 50 degree field — is already a factor of 1.8 past that, so
 * an additive cloud reaches arrival at 55 per cent of its base opacity, and the base
 * opacities here were tuned against that fact rather than in spite of it: the galaxy
 * cloud's 0.46 is 0.25 on screen at arrival, the cluster's 0.7 is 0.38, the nebula's
 * filaments 0.21 and its haze 0.027. The floor of 0.25 arrives at about 1.9 radii,
 * which is inside the cloud, where every line of sight crosses several sprites and
 * the only thing left to protect is the white-out.
 */
const IMMERSION_KNEE = 0.14

/**
 * How far the additive clouds are thinned at an apparent radius of `radiusPx` in a
 * frame `viewportHeight` pixels tall. 1 is untouched; 0.25 is the floor.
 */
export function immersionFactor(radiusPx: number, viewportHeight: number): number {
  return THREE.MathUtils.clamp((IMMERSION_KNEE * viewportHeight) / Math.max(radiusPx, 1), 0.25, 1)
}

/** The object classes `build` has a shape for; everything else draws nothing. */
const PROXY_CLASSES = new Set([
  'asteroid',
  'comet',
  'dwarf-planet',
  'moon',
  'planet',
  'nebula',
  'cluster',
  'galaxy',
  'black-hole',
  'star',
])

/** Reused by the disc orientation; `setFromUnitVectors` needs a constant source axis. */
const UNIT_Z = new THREE.Vector3(0, 0, 1)

// ---------------------------------------------------------------------------
// Black hole
// ---------------------------------------------------------------------------

/**
 * The critical impact parameter, 3*sqrt(3)/2 r_s.
 *
 * A photon aimed closer than this at a Schwarzschild hole is captured, so this — not
 * the horizon at 1 r_s — is the radius of the dark circle an image of one shows. The
 * node radius is the Schwarzschild radius, so every length here is in units of it.
 */
const B_CRIT = (3 * Math.sqrt(3)) / 2

/** Inner edge of the disc: the innermost stable circular orbit, 6GM/c^2 = 3 r_s. */
const DISC_INNER = 3
/** Outer edge. Arbitrary — real discs have no edge, which is why the flux tapers. */
const DISC_OUTER = 14
/**
 * How far the lensed half of the disc is carried out of the disc plane, in r_s.
 *
 * 3.6, down from 7, and this is what finally killed the straight line across the
 * disc. Three waves of work went at that artefact as a shading problem — sheet
 * silhouettes, caustics, edge-on damping, a screen-space brightness cap — and it
 * survived all of them because it is the arch itself: where the lifted half starts
 * to rise it crosses in front of the flat half, and the crossing is an edge in
 * screen space however smooth the surface under it is. Measured at the TON 618
 * arrival camera with everything else held fixed, the arch alone reproduces the
 * artefact with the slab flattened to nothing, and a flat disc has no trace of it at
 * any gain. The edge appears between 3.5 and 5: at 5 it is a faint dark line to the
 * upper right, at 7 it was the hard wedge the user reported, at 3.6 it is gone and
 * the far side still visibly rides above the photon ring.
 *
 * Also the only reason the mesh's own bounds are wrong: the displacement happens in
 * the vertex shader, so the geometry three.js would measure is a flat annulus of
 * radius DISC_OUTER and the arch reaches well outside it.
 */
const DISC_LIFT = 3.6

/**
 * Largest apparent angular radius the shadow is allowed to reach, in radians.
 *
 * Inside the photon sphere the true shadow covers more than half the sky and a quad
 * cannot draw that. Holding it just short of the frame keeps the photon ring on
 * screen at the edges, which is the thing that says "you are inside it" rather than
 * "the renderer died". 0.64 rad is a little inside the horizontal half-FOV in use
 * (atan(aspect * tan(fov/2)) is 0.676 at 50 degrees and 16:9), so the ring stays on
 * screen at the left and right edges.
 *
 * The knee matters as much as the value. The cap is a soft minimum, and the HIGHER
 * the exponent the later it bites: at 0.6 with an 8th power it was already shaving 8
 * per cent off the true shadow at 4 r_s, which is ordinary close-approach range and
 * nowhere near the horizon it is supposed to be rescuing. At 0.64 with a 10th power
 * that is 4 per cent, and the cap is effectively inactive until the photon sphere.
 */
const SHADOW_THETA_MAX = 0.64
/** Sharpness of the soft minimum above; higher means it bites later. */
const SHADOW_CAP_KNEE = 10

/** Half-extent of the photon-ring billboard, in units of the ring's own radius. */
const RING_SPREAD = 1.8

/**
 * Vertical sheets through the disc slab, as a signed fraction of its half-thickness.
 *
 * Four, not the seven this started with, and NONE of them on the midplane.
 *
 * Seven was unaffordable. The slab is drawn additively with no depth test, so every
 * sheet is a full extra layer of shaded fill over whatever part of the frame the disc
 * covers, and at 10 r_s it covers all of it: M87* ran at 18.8 fps with the disc and
 * 39.5 without, against an Earth baseline of 34.
 *
 * The midplane is left out for a different reason. A sheet has no thickness, and the
 * inclination band deliberately holds the line of sight 52 to 80 degrees off face-on,
 * so at the far end of that band a midplane sheet is seen nearly edge-on and its whole
 * annulus lands in a few pixels. Carrying the peak of a Gaussian, that is the worst
 * possible place to put a sheet, so none of them goes there.
 *
 * That alone did NOT remove the straight bright line this stack kept drawing, and an
 * earlier revision of this comment wrongly claimed it had. Isolating one sheet at a
 * time at the arrival camera showed the line is the SILHOUETTE of a single sheet: the
 * inner pair on their own reproduce it exactly, and a false-colour render of
 * |n . eye| lights up along precisely the pixels the line runs through. Wherever a
 * ray grazes an emissive sheet it crosses it twice over a vanishing screen distance,
 * and the two crossings merge into a caustic. DISC_VERTEX now curves the fold so the
 * caustic is not a straight radius, and DISC_FRAGMENT damps each fragment by how
 * edge-on its own sheet is, which is where the artefact finally dies.
 */
const DISC_SHEETS = [-1, -0.45, 0.45, 1]

/**
 * Gaussian vertical density of the slab, on the NEAR side.
 *
 * Steep, so the inner pair carry 93 per cent of the disc between them and the outer
 * pair only edge it. Any emissive sheet throws a caustic along its own silhouette —
 * there it presents its whole radial extent to a few pixels instead of a few hundred
 * — so the faces of the slab have to stay dim or the frame gets a hard bright rim.
 */
const DISC_NEAR_K = 3.2
/**
 * ... and on the far side, where everything near the plane is behind the hole and
 * only the outermost lensed sheets really get out. The weighting there is nearly flat
 * because the arch is all there is left to draw.
 */
const DISC_FAR_K = 0.55
/** How bright that arch is relative to the near half. Measured off the old 7-sheet stack. */
const DISC_FAR_LEVEL = 0.45

/** Fraction of the far-side weight a sheet at |s| keeps; anything on the plane keeps none. */
const discFarShare = (s: number): number => THREE.MathUtils.smoothstep(Math.abs(s), 0.02, 0.6)

const DISC_NEAR_NORM = 1 / DISC_SHEETS.reduce((total, s) => total + Math.exp(-DISC_NEAR_K * s * s), 0)
const DISC_FAR_NORM =
  DISC_FAR_LEVEL / DISC_SHEETS.reduce((total, s) => total + Math.exp(-DISC_FAR_K * s * s) * discFarShare(s), 0)

/**
 * Apparent radius of the shadow, in r_s, for a static observer `d` r_s out.
 *
 * sin(theta) = (b_crit / d) * sqrt(1 - 1/d) is exact in Schwarzschild. It gives the
 * familiar 2.6 r_s far away, passes 90 degrees at the photon sphere, and keeps
 * growing inside it — which is the honest answer to what happens when you fly in. The
 * soft cap is the dishonest part, and it exists so that something is still drawn.
 */
export function shadowApparentRadius(d: number): number {
  const sine = d > 1 ? Math.min((B_CRIT / d) * Math.sqrt(1 - 1 / d), 1) : 1
  let theta = Math.asin(sine)
  if (d < 1.5) theta = Math.PI - theta
  theta /= Math.pow(1 + Math.pow(theta / SHADOW_THETA_MAX, SHADOW_CAP_KNEE), 1 / SHADOW_CAP_KNEE)
  return d * Math.tan(theta)
}

/**
 * A stack of annuli, one draw call, with the sheet index as an attribute.
 *
 * Radii are spaced logarithmically because the profile is steepest at the inner edge.
 * The old disc carried its brightness in 48 Gouraud-interpolated vertex bands, which
 * were plainly visible as steps; everything radial now happens per fragment, so the
 * tessellation only has to be fine enough for the displacements in the vertex shader.
 * The corrugation sets the floor: from inside the disc its surface is seen almost in
 * its own plane, and at 18 rings the linear interpolation between them read as a row
 * of flat facets across half the frame. 28 by 128 over four sheets is 28.7k
 * triangles, against 98.6k for the 32 by 220 over seven that this replaces.
 */
function accretionDiscGeometry(radial: number, angular: number): THREE.BufferGeometry {
  const perSheet = (radial + 1) * (angular + 1)
  const positions = new Float32Array(perSheet * DISC_SHEETS.length * 3)
  const sheets = new Float32Array(perSheet * DISC_SHEETS.length)
  // The azimuth has to be an attribute, not `atan(y, x)` in the shader. atan's branch
  // cut at pi lands in the middle of a quad, and the varying then sweeps the whole
  // circle across that one segment: a bright radial scar across the disc, in the same
  // place every time.
  const angles = new Float32Array(perSheet * DISC_SHEETS.length)
  const index: number[] = []
  let v = 0
  for (let s = 0; s < DISC_SHEETS.length; s++) {
    for (let i = 0; i <= radial; i++) {
      const r = DISC_INNER * (DISC_OUTER / DISC_INNER) ** (i / radial)
      for (let j = 0; j <= angular; j++) {
        const a = (j / angular) * Math.PI * 2
        positions[v * 3] = r * Math.cos(a)
        positions[v * 3 + 1] = r * Math.sin(a)
        sheets[v] = DISC_SHEETS[s]
        angles[v] = a
        v++
      }
    }
    const base = s * perSheet
    for (let i = 0; i < radial; i++) {
      for (let j = 0; j < angular; j++) {
        const a = base + i * (angular + 1) + j
        const b = a + angular + 1
        index.push(a, b, a + 1, b, b + 1, a + 1)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aSheet', new THREE.BufferAttribute(sheets, 1))
  geometry.setAttribute('aAngle', new THREE.BufferAttribute(angles, 1))
  geometry.setIndex(index)
  return geometry
}

/** Value noise and the temperature ramp, shared by the disc shader. */
const BH_COMMON = /* glsl */ `
  float bhHash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  float bhNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(bhHash(i), bhHash(i + vec2(1.0, 0.0)), u.x),
      mix(bhHash(i + vec2(0.0, 1.0)), bhHash(i + vec2(1.0, 1.0)), u.x),
      u.y);
  }

  // Blackbody-ish, from the 2,000 K outer rim through white to the blue-white of the
  // inner edge. Not a Planck integral: a four-stop ramp is within a few per cent over
  // the range a thin disc actually spans, and costs four mixes.
  vec3 bhRamp(float t) {
    vec3 c = mix(vec3(0.34, 0.040, 0.010), vec3(1.00, 0.27, 0.030), smoothstep(0.00, 0.38, t));
    c = mix(c, vec3(1.00, 0.70, 0.30), smoothstep(0.34, 0.62, t));
    c = mix(c, vec3(1.00, 0.96, 0.88), smoothstep(0.60, 0.90, t));
    c = mix(c, vec3(0.68, 0.83, 1.00), smoothstep(0.90, 1.35, t));
    return c;
  }
`

/**
 * The disc, displaced, and its surface normal.
 *
 * Two things happen here that the old flat plate did not do. The slab is given a
 * thickness that opens with radius, so edge-on it is a wedge rather than a razor. And
 * the half of it that lies behind the hole is lifted out of the disc plane — upward
 * for the sheets above the midplane, downward for those below — which stands in for
 * gravitational lensing carrying the far side's image over and under the shadow. It
 * is an approximation, not a geodesic trace: the arch is in the right place and has
 * roughly the right shape, and nothing is claimed beyond that.
 *
 * All of the displacement lives in `discSheet`, which is evaluated three times: once
 * for the vertex and twice more a short step away in radius and in azimuth, so the
 * surface normal comes out of the same expression that made the surface. Analytic
 * derivatives of five sheared sine modes, a power-law flare and a smoothstep fold
 * would be four times the code and would go stale the first time a mode changed; the
 * two extra evaluations cost nothing measurable, because 15k vertices is nothing
 * beside a stack of four full-screen additive sheets. The fragment shader needs that
 * normal — see the silhouette damping there.
 */
const DISC_VERTEX = /* glsl */ `
  uniform vec3 uCam;
  uniform float uHeight;
  uniform float uLift;
  uniform float uTime;
  attribute float aSheet;
  attribute float aAngle;
  varying vec3 vP;
  varying float vR;
  varying float vAng;
  varying float vSheet;
  varying float vFar;
  varying vec3 vNormal;

  /**
   * How much of the far-side arch this azimuth carries, 0 on the near limb, 1 behind
   * the hole.
   *
   * Biased by radius. Without the bias the ramp is a pure function of azimuth, so its
   * iso-lines are exact radii, the fold they carry is a straight crease in the
   * surface, and the crease throws its caustic along a dead-straight line through the
   * middle of the frame. Shifting the ramp inward at small radius curves every
   * iso-line. It is also the better approximation: how far round the hole the far
   * side's image is carried depends on the impact parameter, which is to say on
   * radius.
   *
   * Squared, so the lifted surface leaves the flat near half with zero curvature as
   * well as zero slope: there is no crease anywhere for the light to catch on. The
   * same ramp carries the near-to-far brightness blend, which is the honest coupling
   * — the arch and the light that reaches us from behind the hole are the same
   * approximation seen twice.
   */
  float discFold(float a, vec2 azn, float t) {
    float c = smoothstep(-0.55, 0.85, -dot(vec2(cos(a), sin(a)), azn) - 0.35 * (1.0 - t));
    return c * c;
  }

  vec3 discSheet(float r, float a, float sheet, vec2 azn, float edgeOn) {
    float t = clamp((r - ${DISC_INNER.toFixed(1)}) / ${(DISC_OUTER - DISC_INNER).toFixed(1)}, 0.0, 1.0);
    // Seen face-on nothing is hidden, so nothing needs lifting; the arch fades in as
    // the line of sight approaches the disc plane.
    float farness = discFold(a, azn, t) * edgeOn;

    // The slab FLARES. A constant opening angle makes each face a cone, a cone is
    // ruled by straight lines through its own apex, and the silhouette of a ruled
    // surface is one of those lines — a dead-straight brightness step running across
    // the frame. h/r growing outward is also what a real disc does, and a flared face
    // is not ruled, so its outline is a curve. Corrugating the surface was the first
    // attempt at this and it does not work on its own: at the amplitude needed to
    // defeat a cone (most of a sheet height) the outline came out scalloped like a
    // flower, which is no more like gas than the straight edge was. So the flare
    // carries it and the three sheared modes only have to break it up. They ride the
    // rotation, so the surface moves with the gas rather than sitting on it.
    float flare = pow(r * ${(1 / DISC_INNER).toFixed(5)}, 1.35);
    float lr = log(r);

    // Twist each sheet about the axis before anything else. A vertical offset shared
    // by the whole stack moves every sheet the same way, so wherever the stack is
    // seen edge-on it projects onto the same pixels and collapses into one line three
    // times the surrounding brightness. A couple of degrees of shear, opening
    // outwards, separates them at every azimuth.
    float twist = sheet * (0.045 + 0.075 * t);
    vec2 xy = vec2(cos(a + twist), sin(a + twist)) * r;

    float warp = 1.0
      + 0.20 * sin(a * 3.0 + lr * 2.1 + uTime * 0.45)
      + 0.14 * sin(a * 7.0 - lr * 3.4 - uTime * 0.31)
      + 0.09 * sin(a * 13.0 + lr * 5.9 + uTime * 0.67);
    // A common-mode warp that all four sheets ride together, so the slab as a whole
    // is not a plane. Real discs are warped anyway, by a companion or by a misaligned
    // spin axis, and a stack of parallel sheets reads as glass without it.
    float bulk = 0.52 * sin(a * 2.0 + lr * 1.3 + uTime * 0.23)
               + 0.30 * sin(a * 5.0 - lr * 2.6 - uTime * 0.19);

    // Which lensed arc this sheet rides, over the shadow or under it.
    float z = uHeight * ${DISC_INNER.toFixed(1)} * flare * (sheet * max(warp, 0.3) + bulk)
      + sign(sheet) * uLift * (0.45 + 0.55 * t) * farness;
    return vec3(xy, z);
  }

  void main() {
    float r = max(length(position.xy), 1e-4);
    float a = aAngle;
    vR = r;
    vAng = a;
    vSheet = aSheet;

    // Which half is behind the hole depends only on the camera's azimuth within the
    // disc plane, so the near half is always the half facing the viewer however the
    // disc is tilted.
    float camLen = length(uCam);
    vec2 az = uCam.xy;
    float azLen = length(az);
    vec2 azn = azLen > 1e-6 ? az / azLen : vec2(1.0, 0.0);
    float edgeOn = (azLen > 1e-6 && camLen > 1e-6) ? smoothstep(0.10, 0.48, azLen / camLen) : 0.0;
    vFar = discFold(a, azn, clamp((r - ${DISC_INNER.toFixed(1)}) / ${(DISC_OUTER - DISC_INNER).toFixed(1)}, 0.0, 1.0)) * edgeOn;

    vec3 p = discSheet(r, a, aSheet, azn, edgeOn);
    // Steps small enough to resolve the fastest mode in each direction (13 cycles per
    // turn in azimuth, 5.9 per e-fold in radius) and large enough to stay well clear
    // of float32 cancellation.
    vec3 dr = discSheet(r + 0.03, a, aSheet, azn, edgeOn) - p;
    vec3 da = discSheet(r, a + 0.012, aSheet, azn, edgeOn) - p;
    vec3 n = cross(dr, da);
    vNormal = normalize(dot(n, n) > 1e-24 ? n : vec3(0.0, 0.0, 1.0));

    vP = p;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`

/**
 * The disc, shaded.
 *
 * Everything radial is continuous here rather than interpolated between vertex bands.
 * The profile is Shakura-Sunyaev: flux proportional to R^-3 (1 - sqrt(Rin/R)), which
 * is zero at the innermost stable orbit because there is no torque across it, peaks a
 * third of the way out, and falls as the cube of radius after that. Temperature
 * follows as the fourth root, giving T proportional to R^-3/4.
 *
 * On top of that sits the one effect that makes a picture of a disc read as a black
 * hole rather than a planetary ring: relativistic beaming. Material at the innermost
 * stable orbit moves at 0.41 c, so the limb coming towards you is boosted by the
 * Doppler factor cubed and shifted bluewards, and the limb going away is dimmed and
 * reddened by the same factor. Gravitational redshift multiplies into it. Both are
 * real physics with no free parameters, which is why they are here and a hand-painted
 * highlight is not.
 *
 * The occlusion test is analytic rather than depth-buffered. The lensed arcs sit at
 * the same depth as the shadow billboard and would z-fight with it, so the disc does
 * not depth-test at all: instead each fragment asks whether the ray back to the eye
 * passes inside the critical impact parameter with the hole in front of it, which is
 * exactly the question the depth buffer was being asked to answer.
 */
const DISC_FRAGMENT = /* glsl */ `
  uniform vec3 uCam;
  uniform float uTime;
  uniform float uFade;
  uniform float uGain;
  varying vec3 vP;
  varying float vR;
  varying float vAng;
  varying float vSheet;
  varying float vFar;
  varying vec3 vNormal;

  ${BH_COMMON}

  void main() {
    float R = max(vR, ${DISC_INNER.toFixed(1)});
    float x = ${DISC_INNER.toFixed(1)} / R;

    // 17.66 puts the peak of the profile at one.
    float profile = x * x * x * max(1.0 - sqrt(x), 0.0) * 17.66;
    // Real discs have no edge. The old one ended on a hard ellipse rim, which was the
    // single most artificial thing in the frame, so the outer half tapers to nothing.
    // Written increasing: GLSL ES leaves smoothstep undefined for edge0 >= edge1, and
    // the reversed form that used to be here was the only one in the repository.
    profile *= 1.0 - smoothstep(0.50, 1.0, R / ${DISC_OUTER.toFixed(1)});

    // Gaussian vertical density, so the slab fades at its faces rather than ending on
    // a bright sheet. On the far side everything near the plane is behind the hole and
    // nothing from it gets out, so the weighting there kills the plane and flattens
    // across the lensed sheets, which are all that is left to draw the arch.
    float s2 = vSheet * vSheet;
    float vert = mix(
      exp(-${DISC_NEAR_K.toFixed(2)} * s2) * ${DISC_NEAR_NORM.toFixed(5)},
      exp(-${DISC_FAR_K.toFixed(2)} * s2) * ${DISC_FAR_NORM.toFixed(5)} * smoothstep(0.02, 0.60, abs(vSheet)),
      vFar);

    vec3 ray = vP - uCam;
    float len = length(ray);
    vec3 dir = ray / max(len, 1e-6);
    vec3 toEye = -dir;

    // Damp the silhouettes. A ray that grazes a sheet crosses it twice within a
    // vanishing screen distance, the two crossings merge, and the sheet draws a
    // caustic along the locus where it is exactly edge-on. That locus is what the
    // straight bright line across this disc was: isolating the stack one sheet at a
    // time put it on the inner pair, and a false-colour render of this very quantity
    // lit up along the same pixels. A sheet is a stand-in for a slice of a slab, not
    // a real surface, so there is nothing physical to preserve at its own silhouette.
    //
    // Measured against how edge-on the DISC is, not against a fixed angle: the
    // inclination band swings the whole plane between 52 and 80 degrees off face-on,
    // and an absolute threshold would dim the entire disc by up to half at the far
    // end of that swing. A fragment whose sheet lies in the disc plane has the ratio
    // at one and is left alone at every inclination; only a sheet turned further
    // edge-on than the plane itself is damped.
    float plane = max(abs(toEye.z), 0.06);
    // Renormalised: interpolating a normal across a triangle shortens it, and most
    // where the two ends disagree most, which is exactly at a fold.
    float graze = abs(dot(toEye, normalize(vNormal)));
    vert *= mix(0.35, 1.0, smoothstep(0.0, 0.90, graze / plane));


    // Is this fragment behind the hole? The lensed arcs sit at the same depth as the
    // shadow billboard and would z-fight with it, so the disc does not depth-test at
    // all: instead the ray back to the eye is asked whether it passes inside the
    // critical impact parameter with the hole in front of it, which is exactly the
    // question the depth buffer was being asked to answer.
    //
    // Asked as a sphere, and asked smoothly. THIS is where the straight bright line
    // across the disc came from, and it is a shading discontinuity, not the geometry:
    // the old test was "closest < len ? smoothstep(...) : 1.0", and closest == len
    // is the locus of fragments level with the hole in depth — a diameter of the disc,
    // dead straight, running from the shadow out to the rim. Every fragment just
    // inside it was dimmed by the smoothstep and every fragment just outside it was
    // not, so the line survived every change to the sheets, including flattening the
    // slab to zero thickness and removing the lensed arch entirely.
    //
    // The occluder is the shadow, so the honest question is whether the fragment lies
    // beyond the shadow SPHERE along this ray, not merely beyond its centre: a chord
    // of half-length sqrt(b_crit^2 - b^2) separates the two, and it goes to zero
    // exactly where the radial smoothstep has already dimmed the fragment to nothing.
    // The pair is continuous everywhere.
    float closest = dot(-uCam, dir);
    float b = length(uCam + dir * closest);
    float shadowed = smoothstep(${B_CRIT.toFixed(4)} * 0.93, ${B_CRIT.toFixed(4)} * 1.05, b);
    float chord = sqrt(max(${(B_CRIT * B_CRIT).toFixed(4)} - b * b, 0.0));
    float behind = (closest > 0.0)
      ? smoothstep(-${(B_CRIT * 0.35).toFixed(4)}, ${(B_CRIT * 0.35).toFixed(4)}, len - closest - chord)
      : 0.0;
    float lit = mix(1.0, shadowed, behind);

    // Leave before the expensive half. Most of what this stack rasterises contributes
    // nothing visible: the outer third of the disc after the taper, the faces of the
    // slab, the sheets nearest the plane over the far side, everything the shadow
    // covers, and now the damped silhouettes too. The noise, the Doppler factor and
    // the colour ramp below are the bulk of the shader, and this skips them for well
    // over a third of the fragments.
    if (profile * vert * lit < 0.0012) discard;

    // Rotation, as a rigid term plus a BOUNDED differential one.
    //
    // Omega goes as R^-3/2, so the inner edge laps the rim many times over, and any
    // fixed fraction of that applied to uTime winds the noise field into concentric
    // rings and leaves it there: total winding grows without limit because uTime
    // does, so taking 60 per cent of it only delayed the problem by a factor of two.
    // Three minutes in, the disc was a sheet of polished wood grain. A rigid rotation
    // never winds, and a differential term that OSCILLATES gives the gas its sense of
    // being sheared and then un-shears it. uTime is WALL-CLOCK seconds and never the
    // simulated epoch: the clock reaches a year per second and anything keyed to it
    // strobes.
    float omega = 0.40 + 0.60 * pow(x, 1.5);
    float phase = vAng + uTime * 0.42 + 1.1 * omega * sin(uTime * 0.17);
    float lr = log(R) * 2.9;
    // The azimuthal circle has to be several noise cells across or one trip round the
    // disc samples two cells and every feature comes out a ring. At 4.4 it is ~28.
    vec2 q = vec2(cos(phase), sin(phase)) * 4.4 + vec2(lr * 1.15, -lr * 0.9);
    // Two octaves, not three. The third carried 14 per cent of the amplitude for a
    // third of the noise cost; folded into the second, nothing in a side-by-side moved.
    float n = bhNoise(q) * 0.56 + bhNoise(q * 2.7 + 11.3) * 0.44;
    // Enough contrast to read as turbulence, not so much that the gaps between the
    // filaments show the background through a disc that is supposed to be optically
    // thick. The smeared look the old wound-up noise had was hiding this.
    float flux = profile * (0.42 + 1.12 * n);

    // Keplerian speed in units of c: v^2/c^2 = r_s / 2r.
    float beta = sqrt(0.5 / R);
    vec3 tangent = vec3(-sin(vAng), cos(vAng), 0.0);
    float mu = dot(tangent, toEye);
    float gamma = inversesqrt(max(1.0 - beta * beta, 1e-4));
    float doppler = 1.0 / (gamma * max(1.0 - beta * mu, 0.05));
    float g = doppler * sqrt(max(1.0 - 1.0 / R, 0.02));
    flux *= g * g * g;

    // Observed temperature is the emitted one times the same factor. Taken from the
    // smooth profile, not the turbulent flux, so the colour does not flicker.
    float temp = pow(max(profile, 0.0), 0.25) * g * 1.18;

    vec3 colour = bhRamp(temp) * flux * vert * lit * uGain * uFade;
    gl_FragColor = vec4(colour, 1.0);
  }
`

/**
 * A billboard whose radius is given in the object's own units.
 *
 * The shadow and the photon ring are both circles on the sky from every viewing angle
 * — the shadow because it is the hole's capture cross-section, the ring because it is
 * the image of light that orbited the hole — so neither can be geometry sitting in a
 * fixed plane. A `RingGeometry` was, and orbiting a black hole swung it from a wide
 * ellipse to a straight bar lying across the shadow's face. The offset is applied in
 * view space, after the model-view matrix, so the quad never rotates with anything.
 */
const BILLBOARD_VERTEX = /* glsl */ `
  uniform float uRadius;
  varying vec2 vLocal;

  void main() {
    vLocal = position.xy;
    // The proxy carries its physical size in the group's uniform scale, which the
    // quad has to pick up by hand now that its offset bypasses the model matrix.
    float scale = length(modelViewMatrix[0].xyz);
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * uRadius * scale;
    gl_Position = projectionMatrix * mv;
  }
`

/**
 * The shadow.
 *
 * Opaque, because it is: nothing behind the capture cross-section gets out. The faint
 * interior tint only appears close in. It is not a surface and does not claim to be
 * one; it is there because flying inside 2.6 r_s used to leave a literally empty
 * frame, and an empty frame reads as a crash rather than as an event horizon.
 */
const SHADOW_FRAGMENT = /* glsl */ `
  uniform float uFade;
  uniform float uInner;
  varying vec2 vLocal;

  void main() {
    float d = length(vLocal);
    float a = 1.0 - smoothstep(0.984, 1.0, d);
    if (a < 0.004) discard;
    vec3 tint = vec3(0.008, 0.0016, 0.003) * uInner * (1.0 - d);
    gl_FragColor = vec4(tint, a * uFade);
  }
`

/**
 * The photon ring.
 *
 * A thin, very bright circle at the shadow's edge with a soft radial falloff on both
 * sides, brightest on the limb the disc is rotating towards. The hard-edged annulus it
 * replaces had the same brightness all the way round and a visible inner and outer
 * rim, neither of which a lensed image has.
 */
const RING_FRAGMENT = /* glsl */ `
  uniform float uFade;
  uniform float uGain;
  uniform vec2 uBoost;
  uniform vec3 uColour;
  varying vec2 vLocal;

  void main() {
    vec2 p = vLocal * ${RING_SPREAD.toFixed(2)};
    float d = length(p);
    // Squared by multiplication, not by pow(). d runs from 0 to RING_SPREAD, so
    // (d - 1.0) is negative over the whole inner half of the billboard, and GLSL ES
    // leaves pow(x, y) undefined for x < 0. It renders on this driver only because
    // FXC strength-reduces the literal exponent to a multiply; one that evaluates pow
    // as exp2(y * log2(x)) returns NaN, and the i < 0.0015 guard below is false for
    // NaN, so every fragment inside the ring radius would write NaN. It is also
    // cheaper than a pow.
    float u = (d - 1.0) * 23.8095;
    float core = exp(-u * u);
    float w = (d - 1.0) * 5.0;
    float halo = exp(-w * w) * 0.14;
    float beam = mix(0.30, 1.85, 0.5 + 0.5 * dot(p / max(d, 1e-5), uBoost));
    float i = (core + halo) * beam * uGain;
    if (i < 0.0015) discard;
    gl_FragColor = vec4(uColour * i * uFade, 1.0);
  }
`

/**
 * The two colours a star proxy is shaded between: the driven core and the cooler limb.
 *
 * The centre has to CLEAR the bloom threshold, not approach it. PostStack takes its
 * bright pass at 1.9 with a soft knee at 1.14, and an earlier drive of 2.05 put the
 * core's Rec.709 luminance at 1.12 — a quarter of the way up the knee, so about two
 * and a half per cent of the star's own light reached the glow buffer. A star you had
 * flown to sat there matte while the catalogue point sprites behind it glared, which
 * is backwards. 4.0 puts the luminance at 2.19 for every catalogue colour, clear of
 * the threshold, and about a fifth of the star's light into the glow.
 *
 * The drive stays OFF the limb. That is the part AgX would bleach, and it is the part
 * carrying the spectral type: the hue is identical in both colours and only the limb
 * keeps enough saturation for a red supergiant and a blue giant to look different.
 */
export function photosphereColours(proxyColor: string | undefined): {
  core: THREE.Color
  limb: THREE.Color
} {
  // Normalise to chromaticity first. The catalogue's colour carries the star's
  // brightness as well as its hue, and a drive factor applied on top of that made
  // the exposure depend on which star you were looking at.
  const colour = new THREE.Color(proxyColor ?? '#fff3e0')
  colour.multiplyScalar(1 / Math.max(colour.r, colour.g, colour.b, 1e-4))
  const hsl = { h: 0, s: 0, l: 0 }
  colour.getHSL(hsl)
  const saturation = Math.min(hsl.s * 1.6, 1)
  return {
    core: new THREE.Color().setHSL(hsl.h, saturation * 0.62, 0.64).multiplyScalar(4.0),
    limb: new THREE.Color().setHSL(hsl.h, Math.min(saturation * 1.3, 1), 0.42).multiplyScalar(1.25),
  }
}

export class ProxyModule implements AtlasModule {
  readonly id = 'proxy'
  private engine!: Engine
  /**
   * The live stand-ins, by node id. At most two, and two only while a flight is in
   * the air: the body being left and the one being approached.
   *
   * It used to be one, and `update` handed it the DEPARTURE body for the whole flight
   * so that leaving a black hole did not tear down the thing filling the screen. The
   * cost of that was the other end: the destination had no stand-in until `inTransit`
   * cleared, so an object with no mesh of its own was absent for the entire approach
   * and then appeared whole, at arrival size, in one frame. Flying to Andromeda showed
   * empty sky for three seconds and then a galaxy across the viewport.
   *
   * Holding both ends fixes it without a special case, because `preRender` already
   * fades each proxy on its own honest apparent size: the departure body shrinks out
   * as the destination grows in, and neither knows the other exists.
   */
  private readonly proxies = new Map<string, Proxy>()
  private readonly scratch = new THREE.Vector3()
  /** World-metre scratch, for the in-transit distance in `preRender`. */
  private readonly scratchWorld: Vec3d = vec3d()
  private readonly camLocal = new THREE.Vector3()
  private readonly camDisc = new THREE.Vector3()
  private readonly axis = new THREE.Vector3()
  private readonly desired = new THREE.Vector3()
  private readonly quat = new THREE.Quaternion()
  private readonly viewQuat = new THREE.Quaternion()
  /**
   * Seconds of WALL CLOCK since this module loaded, which is what every animated
   * proxy runs on. The simulated clock is user-driven and reaches a year a second;
   * an accretion disc keyed to it would alias into a flickering mess long before the
   * rate got interesting.
   */
  private phase = 0

  init(engine: Engine): void {
    this.engine = engine
  }

  /** True when the anchored object is being drawn as an illustration, not an observation. */
  isProxy(nodeId: string | null): boolean {
    return nodeId !== null && this.proxies.has(nodeId)
  }

  /**
   * Build and tear down here rather than in `preRender`.
   *
   * The engine decides which layers are active between `update` and `preRender`, and
   * a proxy in the system layer has to set `forceActive` to be drawn at all. Built in
   * `preRender` that flag arrived one pass too late and every newly built proxy was
   * invisible for its first frame — a blink on arrival at every object in the atlas
   * that has one.
   */
  update(ctx: FrameContext): void {
    this.phase += Math.min(ctx.delta, 0.05)

    // Both ends of a flight, so the approach is a cross-fade rather than a pop.
    //
    // `anchorId` is identity and moves to the destination the moment a flight is
    // ordered, which is right for the label and the URL. `transitFromId` is the body
    // being left, and is null when not flying. Holding only one of them loses the
    // other end: the departure body alone meant the destination appeared whole on
    // arrival, and the destination alone tore down the black hole filling the screen
    // on frame 0. There is no third option that keeps both, so it keeps both.
    const wanted = new Set<string>()
    for (const id of [ctx.anchorId, ctx.inTransit ? ctx.transitFromId : null]) {
      if (!id) continue
      const node = this.engine.node(id)
      if (node && !node.object3D && drawnRadiusMetres(node) > 0) wanted.add(id)
    }

    for (const id of [...this.proxies.keys()]) {
      if (!wanted.has(id)) this.clearOne(id)
    }
    for (const id of wanted) {
      if (this.proxies.has(id)) continue
      const node = this.engine.node(id)
      const built = node && this.build(node)
      if (built) this.proxies.set(id, built)
    }

    // One flag per layer, recomputed from what is actually live. Set on build and
    // unset on teardown, it would be cleared by whichever proxy happened to be torn
    // down second while the other was still in that layer and needing it.
    for (const layerId of PROXY_LAYERS) {
      let needed = false
      for (const proxy of this.proxies.values()) {
        if (proxy.layerId === layerId) needed = true
      }
      this.engine.layer(layerId).forceActive = needed
    }
  }

  preRender(ctx: FrameContext): void {
    for (const proxy of this.proxies.values()) this.updateProxy(ctx, proxy)
  }

  private updateProxy(ctx: FrameContext, proxy: Proxy): void {
    const node = this.engine.node(proxy.nodeId)
    if (!node) return

    const layer = this.engine.layer(proxy.layerId)
    layer.toLocal(this.scratch, node.worldPosition, node.frame)
    proxy.group.position.copy(this.scratch)
    const radiusMetres = drawnRadiusMetres(node)
    const scale = layer.toLocalLength(radiusMetres)
    proxy.group.scale.setScalar(scale)
    for (const entry of proxy.points) entry.material.size = entry.sizeFraction * scale

    // Fade on apparent size, so the proxy takes over from the catalogue point exactly
    // where the point stops being able to represent the object.
    //
    // Measured to THIS node every time, never from `ctx.anchorDistanceMetres`. That
    // number is the distance to the anchor, which is one of these two at best and the
    // interpolated orbit point while a flight is in the air: on frame 0 of
    // Earth -> TON 618 it reads 3.6e7 m against a 1.95e14 m radius, which saturates
    // the fade and submits the group at ~1e20 layer units into a camera whose far
    // plane is 1e6. Outside a flight it equals this computation exactly, so there is
    // nothing to branch on and one fewer way to be wrong.
    const distanceMetres = distance3d(
      convertFrame(this.scratchWorld, node.worldPosition, node.frame, ctx.cameraFrame),
      ctx.cameraWorld,
    )
    const halfFov = Math.tan((ctx.fovDegrees * Math.PI) / 360)
    const radiusPx = (radiusMetres / Math.max(distanceMetres, 1) / halfFov) * (ctx.height / 2)
    const fade = THREE.MathUtils.clamp((radiusPx - FADE_IN_PX) / (FADE_FULL_PX - FADE_IN_PX), 0, 1)
    // ... and thin the additive clouds back out as the object fills the frame, which
    // is what a fly-through has to look like.
    const immersion = immersionFactor(radiusPx, ctx.height)
    proxy.group.visible = fade > 0.002
    for (const apply of proxy.fading) apply(fade, immersion)

    if (proxy.blackHole && proxy.group.visible) {
      // The camera in the proxy's own units, where one is the Schwarzschild radius.
      this.camLocal.copy(layer.camera.position).sub(proxy.group.position).divideScalar(Math.max(scale, 1e-30))
      this.updateBlackHole(proxy.blackHole, layer.camera, ctx.delta)
    }
  }

  dispose(): void {
    this.clearAll()
  }

  private clearOne(id: string): void {
    const proxy = this.proxies.get(id)
    if (!proxy) return
    // `forceActive` is NOT cleared here: `update` recomputes it for every proxy layer
    // once the whole set has settled. Clearing it per teardown turned the layer off
    // while the other end of a flight was still being drawn into it.
    this.engine.layer(proxy.layerId).scene.remove(proxy.group)
    proxy.dispose()
    this.proxies.delete(id)
  }

  private clearAll(): void {
    for (const id of [...this.proxies.keys()]) this.clearOne(id)
    for (const layerId of PROXY_LAYERS) this.engine.layer(layerId).forceActive = false
  }

  private build(node: SceneNodeHandle): Proxy | null {
    // Checked before anything is allocated. A node this module has no shape for —
    // the Zone of Avoidance anchors are objectClass 'region' — leaves `this.proxy`
    // null, so `update` calls build again on the very next frame and goes on doing
    // it for as long as the camera stays there. Reaching the switch's `default`
    // meant throwing away a Group, a PRNG closure and three arrays sixty times a
    // second; this is the only allocation the module makes per frame.
    if (!PROXY_CLASSES.has(node.objectClass)) return null
    const random = mulberry32(hashId(node.id))
    const group = new THREE.Group()
    const disposables: { dispose: () => void }[] = []
    const fading: Proxy['fading'] = []
    const points: Proxy['points'] = []
    let blackHole: BlackHoleState | undefined

    switch (node.objectClass) {
      case 'asteroid':
      case 'comet':
      case 'dwarf-planet':
      case 'moon':
      case 'planet':
        this.buildRockyBody(node, random, group, disposables, fading)
        break
      case 'nebula':
        this.buildNebula(random, group, disposables, fading, points)
        break
      case 'cluster':
        // A 'cluster' in the cosmic layer is a cluster of GALAXIES — the CF4 groups —
        // and a Plummer ball of star points is the wrong object by a factor of 1e11 in
        // membership and 1e6 in the size of each dot. The layer is the honest
        // discriminator: nothing below the cosmic layer is catalogued in galaxies.
        if (node.layer === 'cosmic') this.buildGalaxyGroup(random, group, disposables, fading, points)
        else this.buildCluster(random, group, disposables, fading, points)
        break
      case 'galaxy':
        this.buildGalaxy(node, random, group, disposables, fading, points)
        break
      case 'black-hole':
        blackHole = this.buildBlackHole(random, group, disposables, fading)
        break
      case 'star':
        this.buildStar(node, group, disposables, fading)
        break
      default:
        return null
    }

    const layerId = proxyLayerFor(node)
    const layer = this.engine.layer(layerId)
    layer.scene.add(group)
    // The system layer sits outside every distance band when the anchor is a quasar,
    // so it has to be told to draw anyway.
    // `forceActive` is owned by `update`, which sets it from the live set every frame.
    return {
      nodeId: node.id,
      layerId,
      group,
      fading,
      points,
      blackHole,
      dispose: () => {
        for (const d of disposables) d.dispose()
      },
    }
  }

  /**
   * An airless rock or an icy nucleus, lit by the solar module's point light.
   *
   * Bodies in the heliocentric layer get real lighting for free. Anything else (a
   * rogue object outside the layer) would be unlit and black, so it falls back to a
   * dim self-lit material.
   */
  private buildRockyBody(
    node: SceneNodeHandle,
    random: () => number,
    group: THREE.Group,
    disposables: { dispose: () => void }[],
    fading: Proxy['fading'],
  ): void {
    // Below about 300 km, self-gravity loses to material strength and shapes stay
    // irregular; above it they relax towards a sphere.
    const irregularity = THREE.MathUtils.clamp(0.26 * (1 - node.radiusMetres / 4e5), 0.02, 0.26)
    const geometry = lumpySphere(random, irregularity)
    const isComet = node.objectClass === 'comet'
    // Dark, because these things are dark: a comet nucleus reflects about 4 per cent
    // of the light that hits it and a C-type asteroid under 10, which is charcoal and
    // asphalt respectively. The old pair read as pale concrete under full sun. Not
    // taken all the way to a true albedo — at 4 per cent of a surface already lit by
    // an inverse-square point light the body is a silhouette on most screens — but
    // far enough that it reads as rock.
    const tint = isComet ? 0x4f4c49 : 0x6f675d

    // Albedo variegation. A smooth-shaded body with one flat colour reads as a
    // billiard ball, and the mottling is the cheapest thing that says "surface"
    // without claiming any particular feature is there.
    const position = geometry.attributes.position as THREE.BufferAttribute
    const colors = new Float32Array(position.count * 3)
    const base = new THREE.Color(tint)
    const v = new THREE.Vector3()
    const axes: THREE.Vector3[] = []
    for (let i = 0; i < 4; i++) {
      axes.push(new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize())
    }
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i)
      // Relief drives albedo as well as shape. A crater floor collects dust and dark
      // regolith and a fresh rim exposes brighter material, which is why craters are
      // visible at full phase at all — and full phase is exactly how the camera
      // arrives, with the Sun behind it and no shadows to read the surface by.
      const relief = THREE.MathUtils.clamp((v.length() - 1) * 6, -0.3, 0.3)
      v.normalize()
      let patch = 0
      for (let a = 0; a < axes.length; a++) patch += Math.sin(v.dot(axes[a]) * (5 + a * 4.3) + a * 2.1)
      const shade = 0.72 + 0.28 * (patch / axes.length) + relief
      colors[i * 3] = base.r * shade
      colors[i * 3 + 1] = base.g * shade
      colors[i * 3 + 2] = base.b * shade
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    const material =
      proxyLayerFor(node) === 'helio'
        ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, transparent: true })
        : new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.rotation.set(random() * Math.PI, random() * Math.PI, random() * Math.PI)
    group.add(mesh)
    disposables.push(geometry, material)
    fading.push((fade) => {
      material.opacity = fade
    })
  }

  /**
   * A star as a self-lit sphere with limb darkening, in its own colour.
   *
   * Two things used to go wrong. The disc was uniformly bright, which is a billiard
   * ball and not a photosphere; and the colour was driven to 2.3x with the saturation
   * tripled in the hope that some hue would survive AgX, which it did not — every
   * star reached the screen white, so a red supergiant and a blue giant looked the
   * same. The fix is to put the hue where the tone mapper cannot bleach it. A real
   * photosphere is a gas: a sightline at the limb stops higher up and therefore
   * cooler, so the rim is both fainter and redder than the centre. Driving the centre
   * hard and the rim gently gives the bloom its glare AND leaves a saturated annulus
   * that carries the spectral type. The two colours, and how hard "hard" has to be
   * before the bloom actually fires, are in `photosphereColours`.
   */
  private buildStar(
    node: SceneNodeHandle,
    group: THREE.Group,
    disposables: { dispose: () => void }[],
    fading: Proxy['fading'],
  ): void {
    const geometry = new THREE.SphereGeometry(1, 64, 32)
    const { core, limb } = photosphereColours(node.proxyColor)
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uCore: { value: core },
        uLimb: { value: limb },
        uFade: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vToEye;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vToEye = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uCore;
        uniform vec3 uLimb;
        uniform float uFade;
        varying vec3 vNormal;
        varying vec3 vToEye;
        void main() {
          float mu = clamp(dot(normalize(vNormal), normalize(vToEye)), 0.0, 1.0);
          // Eddington's grey-atmosphere law, I(mu)/I(1) = 0.4 + 0.6 mu. The Sun's
          // measured visual coefficient is close enough to it that the difference
          // would not survive tone mapping.
          float bright = 0.40 + 0.60 * mu;
          vec3 colour = mix(uLimb, uCore, pow(mu, 0.75));
          gl_FragColor = vec4(colour * bright, uFade);
        }
      `,
      transparent: true,
    })
    group.add(new THREE.Mesh(geometry, material))
    disposables.push(geometry, material)
    fading.push((fade) => {
      material.uniforms.uFade.value = fade
    })
  }

  /**
   * An emission nebula as a clump of soft billboards.
   *
   * Real nebulae are filamentary, so the cloud is built as a handful of elongated
   * strands rather than one isotropic blob — at the measured angular size, and with
   * nothing in it that claims to be a specific structure.
   *
   * Two clouds, not one. A single sprite size big enough to fill the volume turned
   * every filament into a fat grey worm, because additive blending of a dozen
   * overlapping wide sprites saturates to white whatever colour went in. Thin sprites
   * draw the filaments; a sparse set of wide, very dim ones fills the space between
   * them. The palette is the spectrum an H II region actually emits — hydrogen alpha
   * in the red, doubly-ionised oxygen in the blue-green near the ionising stars —
   * rather than the single interpolated mauve the old radial ramp collapsed to.
   */
  private buildNebula(
    random: () => number,
    group: THREE.Group,
    disposables: { dispose: () => void }[],
    fading: Proxy['fading'],
    points: Proxy['points'],
  ): void {
    // Nine short, curved, independently placed filaments rather than long spokes
    // through a common centre — the latter is a starfish, which is not what any
    // emission region looks like. Each one is a quadratic Bezier with its own start,
    // bend and length.
    const strands = 9
    const a: THREE.Vector3[] = []
    const b: THREE.Vector3[] = []
    const c: THREE.Vector3[] = []
    const lengths: number[] = []
    const ions: THREE.Color[] = []
    // Hydrogen alpha dominates; O III shows where the radiation field is hardest, and
    // a little S II deepens the outer edges.
    const halpha = new THREE.Color('#ff4a46')
    const oiii = new THREE.Color('#3ad9b6')
    const sii = new THREE.Color('#b8304a')
    const reflection = new THREE.Color('#6f9cff')
    for (let s = 0; s < strands; s++) {
      const start = new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).multiplyScalar(0.55)
      const run = 0.4 + random() * 0.8
      const dir = new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize()
      const bend = new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).multiplyScalar(0.45)
      a.push(start)
      b.push(start.clone().addScaledVector(dir, run * 0.5).add(bend))
      c.push(start.clone().addScaledVector(dir, run))
      lengths.push(run)
      // Hydrogen alpha everywhere, with the other lines mixed in rather than given
      // whole strands of their own: a solid teal filament lying beside a solid red
      // one reads as two objects, which is what the old per-strand colouring did.
      const roll = random()
      const dominant = roll < 0.68 ? halpha : roll < 0.86 ? sii : roll < 0.95 ? oiii : reflection
      ions.push(dominant.clone().lerp(halpha, 0.35))
    }

    const colour = new THREE.Color()
    const point = new THREE.Vector3()

    const filamentCount = 14000
    const fPositions = new Float32Array(filamentCount * 3)
    const fColors = new Float32Array(filamentCount * 3)
    for (let i = 0; i < filamentCount; i++) {
      const s = i % strands
      const t = random()
      const u = 1 - t
      point
        .copy(a[s])
        .multiplyScalar(u * u)
        .addScaledVector(b[s], 2 * u * t)
        .addScaledVector(c[s], t * t)
      // Triangular rather than uniform across the strand, so it has a bright spine
      // and ragged edges instead of the constant-width tube that read as a worm.
      const spread = 0.17 * lengths[s] * (0.25 + Math.sin(Math.PI * t))
      point.x += (random() + random() - 1) * spread
      point.y += (random() + random() - 1) * spread
      point.z += (random() + random() - 1) * spread
      fPositions[i * 3] = point.x
      fPositions[i * 3 + 1] = point.y
      fPositions[i * 3 + 2] = point.z
      // Towards the middle the ionising stars harden the radiation field, so O III
      // wins there whatever the filament's own dominant line is; mixing a little of
      // each strand's neighbour in stops the strands reading as separate objects.
      const r = point.length()
      colour.copy(ions[s]).lerp(ions[(s + 1) % strands], random() * 0.5)
      colour.lerp(oiii, THREE.MathUtils.clamp(0.7 - r * 2.2, 0, 0.6))
      const brightness = (0.3 + random() ** 2 * 0.7) * Math.exp(-1.1 * r)
      fColors[i * 3] = colour.r * brightness
      fColors[i * 3 + 1] = colour.g * brightness
      fColors[i * 3 + 2] = colour.b * brightness
    }
    // 0.085 body radii, not 0.14. The sprite has to be SMALLER than the structure it
    // is meant to resolve or the strand is a chain of equal discs, which is a smooth
    // cylinder however many points go into it — the strands read as salmon ropes with
    // hard edges at 0.14, where the transverse scatter is at most 0.2 radii. Dropping
    // the diameter and raising the count is close to free: total sprite area goes from
    // 127 to 101 body radii squared, so this is also slightly less fill than before.
    const filaments = pointCloud(fPositions, fColors, 0.085, 0.38)
    group.add(filaments)
    disposables.push(filaments.geometry, filaments.material as THREE.Material)
    const fMaterial = filaments.material as THREE.PointsMaterial
    fading.push((fade, immersion) => {
      fMaterial.opacity = 0.38 * fade * immersion
    })
    points.push({ material: fMaterial, sizeFraction: 0.085 })

    const hazeCount = 1500
    const hPositions = new Float32Array(hazeCount * 3)
    const hColors = new Float32Array(hazeCount * 3)
    for (let i = 0; i < hazeCount; i++) {
      const r = random() ** 0.42
      const cosTheta = random() * 2 - 1
      const sinTheta = Math.sqrt(1 - cosTheta * cosTheta)
      const phi = random() * Math.PI * 2
      hPositions[i * 3] = r * sinTheta * Math.cos(phi)
      hPositions[i * 3 + 1] = r * sinTheta * Math.sin(phi)
      hPositions[i * 3 + 2] = r * cosTheta
      colour.copy(sii).lerp(halpha, THREE.MathUtils.clamp(1.2 - r, 0, 1))
      colour.lerp(oiii, THREE.MathUtils.clamp(0.5 - r, 0, 0.55))
      // Exponential in radius. A uniform haze truncated at the catalogue radius ends
      // on a visible circular edge, and an emission region has no such thing.
      const brightness = (0.5 + random() ** 2) * Math.exp(-1.9 * r)
      hColors[i * 3] = colour.r * brightness
      hColors[i * 3 + 1] = colour.g * brightness
      hColors[i * 3 + 2] = colour.b * brightness
    }
    const haze = pointCloud(hPositions, hColors, 0.34, 0.05)
    group.add(haze)
    disposables.push(haze.geometry, haze.material as THREE.Material)
    const hMaterial = haze.material as THREE.PointsMaterial
    fading.push((fade, immersion) => {
      hMaterial.opacity = 0.05 * fade * immersion
    })
    points.push({ material: hMaterial, sizeFraction: 0.34 })
  }

  /**
   * A star cluster as a Plummer-like swarm.
   *
   * The radial profile is the one thing about a cluster that a proxy can get right
   * from a single number: concentrated core, sparse halo, truncated at the measured
   * radius.
   */
  /**
   * A cluster of galaxies, as the 14 CF4 groups are drawn.
   *
   * Each dot is one member galaxy, not one star, so the count is in the hundreds and
   * the dots are large enough to read as extended objects rather than as a star field.
   * Positions are illustrative: CF4 publishes a group centre, a distance and a
   * membership count, and nothing about where inside the group its members sit. The
   * radial law is the same Plummer profile the globular uses — clusters of both kinds
   * really are centrally concentrated — with a flatter core, because a galaxy cluster
   * is not nearly as cuspy as a globular, and a mild prolate stretch, because they are
   * not round either.
   */
  private buildGalaxyGroup(
    random: () => number,
    group: THREE.Group,
    disposables: { dispose: () => void }[],
    fading: Proxy['fading'],
    points: Proxy['points'],
  ): void {
    // Two clouds, because PointsMaterial sizes every point alike: a dozen bright
    // members you can tell apart and a faint field behind them.
    const tiers: { count: number; size: number; opacity: number; gain: number }[] = [
      { count: 18, size: 0.085, opacity: 1.0, gain: 1.35 },
      { count: 320, size: 0.042, opacity: 0.72, gain: 0.8 },
    ]
    const red = new THREE.Color('#ffd7b0')
    const blue = new THREE.Color('#bfd4ff')
    const colour = new THREE.Color()
    for (const tier of tiers) {
      const positions = new Float32Array(tier.count * 3)
      const colors = new Float32Array(tier.count * 3)
      for (let i = 0; i < tier.count; i++) {
        const u = random()
        let r = 0.62 / Math.sqrt(Math.max(u ** (-2 / 3) - 1, 1e-6))
        r = Math.min(r, 1)
        const cosTheta = random() * 2 - 1
        const sinTheta = Math.sqrt(1 - cosTheta * cosTheta)
        const phi = random() * Math.PI * 2
        positions[i * 3] = r * sinTheta * Math.cos(phi) * 0.82
        positions[i * 3 + 1] = r * sinTheta * Math.sin(phi) * 0.82
        positions[i * 3 + 2] = r * cosTheta * 1.25
        // The morphology-density relation, which is the one thing about a cluster's
        // appearance that is not a guess: the core is red ellipticals, the outskirts
        // keep their blue spirals.
        colour.copy(blue).lerp(red, THREE.MathUtils.clamp(1.15 - r * 1.3, 0, 1) * (0.5 + random() * 0.5))
        const brightness = (0.45 + random() ** 2) * tier.gain
        colors[i * 3] = colour.r * brightness
        colors[i * 3 + 1] = colour.g * brightness
        colors[i * 3 + 2] = colour.b * brightness
      }
      const cloud = pointCloud(positions, colors, tier.size, tier.opacity)
      group.add(cloud)
      disposables.push(cloud.geometry, cloud.material as THREE.Material)
      const material = cloud.material as THREE.PointsMaterial
      const base = tier.opacity
      fading.push((fade, immersion) => {
        // Only a quarter of the immersion thinning the other proxies take. That fade
        // exists so a nebula you fly into does not become a wall of fog, and it is
        // wrong here: these dots are member GALAXIES, discrete objects that stay
        // discrete however close the camera gets, and at the arrival framing the full
        // factor is already at its floor — Virgo arrived as an empty frame with a
        // label in the middle of it.
        material.opacity = base * fade * (0.75 + 0.25 * immersion)
      })
      points.push({ material, sizeFraction: tier.size })
    }
  }

  private buildCluster(
    random: () => number,
    group: THREE.Group,
    disposables: { dispose: () => void }[],
    fading: Proxy['fading'],
    points: Proxy['points'],
  ): void {
    // 1,400 points at 0.035 radii covered 1.7 radii squared, and from inside M 13 —
    // half a million stars in 70 light years — that is a scatter of countable specks
    // with black between them. A point cloud is close to free at these counts —
    // toggling the entire galaxy proxy, five times the points, moves the frame by
    // under a millisecond — so the right answer is more of them and smaller.
    const count = 7000
    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const blue = new THREE.Color('#cfe0ff')
    const gold = new THREE.Color('#ffd9a8')
    const colour = new THREE.Color()
    for (let i = 0; i < count; i++) {
      // Plummer radius sampling, truncated at the catalogue radius.
      const u = random()
      let r = 0.42 / Math.sqrt(Math.max(u ** (-2 / 3) - 1, 1e-6))
      r = Math.min(r, 1)
      const cosTheta = random() * 2 - 1
      const sinTheta = Math.sqrt(1 - cosTheta * cosTheta)
      const phi = random() * Math.PI * 2
      positions[i * 3] = r * sinTheta * Math.cos(phi)
      positions[i * 3 + 1] = r * sinTheta * Math.sin(phi)
      positions[i * 3 + 2] = r * cosTheta
      colour.copy(blue).lerp(gold, random() ** 2)
      const brightness = 0.35 + random() ** 3
      colors[i * 3] = colour.r * brightness
      colors[i * 3 + 1] = colour.g * brightness
      colors[i * 3 + 2] = colour.b * brightness
    }
    const cloud = pointCloud(positions, colors, 0.024, 0.70)
    group.add(cloud)
    disposables.push(cloud.geometry, cloud.material as THREE.Material)
    const material = cloud.material as THREE.PointsMaterial
    fading.push((fade, immersion) => {
      material.opacity = 0.7 * fade * immersion
    })
    points.push({ material, sizeFraction: 0.024 })
  }

  /**
   * A galaxy at the catalogue radius, in the catalogue's own morphological class.
   *
   * Every galaxy used to get the same two-to-four-arm spiral, which is wrong for
   * roughly a third of the registry and badly wrong for the ones it is wrong about:
   * an elliptical has no disc and no arms, a dwarf irregular has no bulge and no
   * symmetry at all. `proxyMorphology` carries the catalogue's own class where it has
   * one. Where it has none the shape falls through to a spiral, which is the most
   * common outcome and is still a guess — the inspector says the shape is an
   * illustration for exactly this reason.
   */
  private buildGalaxy(
    node: SceneNodeHandle,
    random: () => number,
    group: THREE.Group,
    disposables: { dispose: () => void }[],
    fading: Proxy['fading'],
    points: Proxy['points'],
  ): void {
    const form = galaxyForm((node as SceneNodeHandle & MorphologyHint).proxyMorphology)
    // Denser, and this time by an amount that can actually change the picture. Going
    // from 9,000 points at 0.028 radii to 16,000 at 0.021 was a no-op and should not
    // have been claimed as a fix: 9000 * 0.028^2 and 16000 * 0.021^2 are both 7.056,
    // so the filled fraction of the arms was identical to five figures and the only
    // net effect was that each dot got 25 per cent narrower, i.e. easier to count.
    // What stops a point cloud reading as countable dots is coverage with no single
    // dot standing out, so: 24000 * 0.024^2 = 13.8 against 7.06, nearly twice the
    // sprite area, at 0.46 opacity rather than 0.8 so the total light is about what it
    // was, and a wider scatter across each arm so the dots overlap.
    const count = 24000
    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const young = new THREE.Color('#9fc4ff')
    const old = new THREE.Color('#ffd9a0')
    const colour = new THREE.Color()

    if (form === 'elliptical') {
      // de Vaucouleurs in projection: a smooth, centrally concentrated, triaxial
      // swarm of old stars. No disc, no arms, no colour gradient worth drawing.
      const b = 0.45 + random() * 0.45
      const c = b * (0.6 + random() * 0.35)
      for (let i = 0; i < count; i++) {
        const r = Math.min(0.9 * random() ** 2.6, 1)
        const cosTheta = random() * 2 - 1
        const sinTheta = Math.sqrt(1 - cosTheta * cosTheta)
        const phi = random() * Math.PI * 2
        positions[i * 3] = r * sinTheta * Math.cos(phi)
        positions[i * 3 + 1] = r * sinTheta * Math.sin(phi) * b
        positions[i * 3 + 2] = r * cosTheta * c
        colour.copy(old).lerp(young, 0.1 * random())
        const brightness = 0.3 + random() ** 2
        colors[i * 3] = colour.r * brightness
        colors[i * 3 + 1] = colour.g * brightness
        colors[i * 3 + 2] = colour.b * brightness
      }
    } else if (form === 'irregular') {
      // A handful of star-forming knots with no centre and no symmetry, which is the
      // defining property: a dwarf irregular is lumpy all the way down.
      const knots = 5 + Math.floor(random() * 4)
      const centres: THREE.Vector3[] = []
      const sizes: number[] = []
      for (let k = 0; k < knots; k++) {
        centres.push(
          new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, (random() * 2 - 1) * 0.35).multiplyScalar(0.55),
        )
        sizes.push(0.12 + random() * 0.3)
      }
      for (let i = 0; i < count; i++) {
        const k = Math.floor(random() * knots)
        const r = sizes[k] * random() ** 0.8
        const cosTheta = random() * 2 - 1
        const sinTheta = Math.sqrt(1 - cosTheta * cosTheta)
        const phi = random() * Math.PI * 2
        positions[i * 3] = centres[k].x + r * sinTheta * Math.cos(phi)
        positions[i * 3 + 1] = centres[k].y + r * sinTheta * Math.sin(phi)
        positions[i * 3 + 2] = centres[k].z + r * cosTheta * 0.5
        colour.copy(young).lerp(old, random() ** 2.2)
        const brightness = 0.25 + random() ** 2
        colors[i * 3] = colour.r * brightness
        colors[i * 3 + 1] = colour.g * brightness
        colors[i * 3 + 2] = colour.b * brightness
      }
    } else {
      // Disc plus bulge. A lenticular gets the same disc with the spiral arms turned
      // off, which is what S0 means.
      const bulgeFraction = form === 'lenticular' ? 0.42 : 0.22
      const armStrength = form === 'lenticular' ? 0 : 1
      const arms = 2 + Math.floor(random() * 3)
      const pitch = 0.22 + random() * 0.16
      for (let i = 0; i < count; i++) {
        if (random() < bulgeFraction) {
          const r = 0.26 * random() ** 1.8
          const cosTheta = random() * 2 - 1
          const sinTheta = Math.sqrt(1 - cosTheta * cosTheta)
          const phi = random() * Math.PI * 2
          positions[i * 3] = r * sinTheta * Math.cos(phi)
          positions[i * 3 + 1] = r * sinTheta * Math.sin(phi)
          positions[i * 3 + 2] = r * cosTheta * 0.72
          colour.copy(old)
        } else {
          const r = Math.min(-0.34 * Math.log(1 - random() * 0.98), 1)
          const arm = Math.floor(random() * arms)
          const armPhase = (arm / arms) * Math.PI * 2 + Math.log(Math.max(r, 0.02)) / pitch
          const phi = armStrength > 0 ? armPhase + (random() - 0.5) * 1.25 : random() * Math.PI * 2
          positions[i * 3] = r * Math.cos(phi)
          positions[i * 3 + 1] = r * Math.sin(phi)
          positions[i * 3 + 2] = (random() - 0.5) * 0.06 * (1 - r * 0.6)
          colour.copy(old).lerp(young, THREE.MathUtils.clamp(r * 1.3 * (0.3 + 0.7 * armStrength), 0, 1))
        }
        const brightness = 0.3 + random() ** 2
        colors[i * 3] = colour.r * brightness
        colors[i * 3 + 1] = colour.g * brightness
        colors[i * 3 + 2] = colour.b * brightness
      }
    }

    const cloud = pointCloud(positions, colors, 0.024, 0.46)
    // A seeded tilt. With no rotation at all every galaxy in the atlas lies in the
    // system layer's XY plane, so its apparent inclination is an accident of which
    // way the camera happened to arrive and a thousand spirals share one orientation.
    // The catalogues hold a real inclination and position angle for about 940 of the
    // 1,030, but neither reaches a SceneNodeHandle yet; a stable per-object tilt is
    // the honest stand-in until they do, and it is no more invented than the arms.
    // Kept between 11 and 66 degrees from face-on so the disc still reads as a disc.
    const nodes = random() * Math.PI * 2
    const tilt = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(Math.cos(nodes), Math.sin(nodes), 0),
      0.2 + random() * 0.95,
    )
    cloud.quaternion.copy(tilt).multiply(new THREE.Quaternion().setFromAxisAngle(UNIT_Z, random() * Math.PI * 2))
    group.add(cloud)
    disposables.push(cloud.geometry, cloud.material as THREE.Material)
    const material = cloud.material as THREE.PointsMaterial
    fading.push((fade, immersion) => {
      material.opacity = 0.46 * fade * immersion
    })
    points.push({ material, sizeFraction: 0.024 })
  }

  /**
   * A black hole: the shadow, the photon ring, and an accretion disc.
   *
   * ## What this claims
   *
   * The node radius is the Schwarzschild radius, and everything here is measured in
   * it. The shadow is drawn at the critical impact parameter, 3*sqrt(3)/2 = 2.598 r_s,
   * with its apparent angular size following the exact Schwarzschild expression for a
   * static observer rather than a fixed 2.6 at every distance. The disc runs from the
   * innermost stable circular orbit at 3 r_s outwards. Its radial brightness is the
   * Shakura-Sunyaev thin-disc profile, its temperature the fourth root of that, its
   * orbital speed Keplerian, and the Doppler beaming and gravitational redshift that
   * follow from those have no free parameters. Those parts are physics.
   *
   * ## What it does not
   *
   * It is still a SCHEMATIC. There is no geodesic integration: the far side of the
   * disc is lifted over and under the shadow by a vertex displacement that puts the
   * arch roughly where lensing would put it and gets its shape approximately right,
   * and the secondary and higher-order images are simply absent. The outer radius,
   * the disc's thickness, the turbulence and the inclination are inventions — no
   * black hole in this atlas has a measured accretion-disc geometry, and only two
   * have a resolved image of any kind. The inclination in particular is chosen
   * against the camera, because a disc whose orientation was fixed in object space
   * showed up edge-on as a one-pixel scratch for whoever happened to arrive from the
   * wrong direction, and a one-pixel scratch says nothing true.
   */
  private buildBlackHole(
    random: () => number,
    group: THREE.Group,
    disposables: { dispose: () => void }[],
    fading: Proxy['fading'],
  ): BlackHoleState {
    const quad = new THREE.PlaneGeometry(2, 2)
    disposables.push(quad)

    const shadow = new THREE.ShaderMaterial({
      uniforms: { uRadius: { value: B_CRIT }, uFade: { value: 1 }, uInner: { value: 0 } },
      vertexShader: BILLBOARD_VERTEX,
      fragmentShader: SHADOW_FRAGMENT,
      transparent: true,
      depthWrite: true,
    })
    const shadowMesh = new THREE.Mesh(quad, shadow)
    shadowMesh.frustumCulled = false
    shadowMesh.renderOrder = 0
    group.add(shadowMesh)
    disposables.push(shadow)

    const discRoot = new THREE.Object3D()
    group.add(discRoot)
    const discGeometry = accretionDiscGeometry(28, 128)
    // The arch is a vertex displacement, so the bounds three.js would compute from the
    // positions are a flat annulus and would cull the disc while it is still on screen.
    discGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), DISC_OUTER + DISC_LIFT)
    const disc = new THREE.ShaderMaterial({
      uniforms: {
        uCam: { value: new THREE.Vector3(0, 0, 40) },
        uTime: { value: 0 },
        uFade: { value: 1 },
        // Trimmed from 0.42 when the sheet stack changed: four sheets straddling the
        // plane cover more screen area between them than seven stacked through it, so
        // the same gain pushed the near half into flat clipped white at close range.
        // Matched back to the old frame brightness at the arrival distance.
        uGain: { value: 0.34 },
        // Half-thickness of the slab AT THE INNER EDGE, as a fraction of it; the
        // flare in DISC_VERTEX takes it to about 0.085 r at the rim. Real thin discs
        // run h/r near 0.01 there, and this is several times that, because at 0.01
        // the thickness is invisible and the edge-on view is the razor it replaces.
        uHeight: { value: 0.055 },
        uLift: { value: DISC_LIFT },
      },
      vertexShader: DISC_VERTEX,
      fragmentShader: DISC_FRAGMENT,
      transparent: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    })
    const discMesh = new THREE.Mesh(discGeometry, disc)
    // Cullable again, now that it has bounds that cover the displacement. The disc is
    // the single most expensive thing the atlas draws; skipping it whenever the hole is
    // off screen is free.
    discMesh.frustumCulled = true
    discMesh.renderOrder = 1
    discRoot.add(discMesh)
    disposables.push(discGeometry, disc)

    const ring = new THREE.ShaderMaterial({
      uniforms: {
        uRadius: { value: B_CRIT * RING_SPREAD },
        uFade: { value: 1 },
        uGain: { value: 1.3 },
        uBoost: { value: new THREE.Vector2(1, 0) },
        uColour: { value: new THREE.Color('#fff0d2') },
      },
      vertexShader: BILLBOARD_VERTEX,
      fragmentShader: RING_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    })
    const ringMesh = new THREE.Mesh(quad, ring)
    ringMesh.frustumCulled = false
    ringMesh.renderOrder = 2
    group.add(ringMesh)
    disposables.push(ring)

    fading.push((fade) => {
      shadow.uniforms.uFade.value = fade
      disc.uniforms.uFade.value = fade
      ring.uniforms.uFade.value = fade
    })

    // A seeded starting normal, so two holes do not arrive identically oriented. The
    // first frame snaps it into the viewable band; after that it holds still.
    const normal = new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1)
    if (normal.lengthSq() < 1e-6) normal.set(0, 0, 1)
    normal.normalize()

    return { discRoot, disc, shadow, ring, normal, oriented: false }
  }

  /**
   * Point the disc at the camera, size the shadow, and hand both the view geometry.
   *
   * The inclination is kept inside a band rather than pinned, which is the whole
   * trick. Pinned to the camera, orbiting a black hole would show no parallax and the
   * thing would read as a decal. Fixed in object space — which is what a hardcoded
   * `rotation.x` is — the disc goes edge-on from half the directions you can arrive
   * from, and at Cygnus X-1 that meant a one-pixel scratch across a small black ball.
   * Inside the band the disc does not move at all, so orbiting works normally; only
   * when the line of sight approaches the disc plane, or comes too close to face-on,
   * does it ease back, over about half a second.
   */
  private updateBlackHole(state: BlackHoleState, camera: THREE.Camera, delta: number): void {
    const distance = Math.max(this.camLocal.length(), 1.0001)
    const view = this.axis.copy(this.camLocal).divideScalar(distance)

    const cosine = state.normal.dot(view)
    const inclination = Math.abs(cosine)
    // cos i between 0.17 and 0.62 is 52 to 80 degrees from face-on: enough opening to
    // read as a disc, enough tilt for the far side to arch over the shadow.
    let target = inclination
    if (inclination < 0.17) target = 0.24
    else if (inclination > 0.62) target = 0.54
    if (target !== inclination) {
      this.desired.copy(state.normal).addScaledVector(view, -cosine)
      if (this.desired.lengthSq() < 1e-8) {
        // Exactly face-on: any perpendicular will do.
        this.desired.set(view.y, -view.x, 0)
        if (this.desired.lengthSq() < 1e-8) this.desired.set(1, 0, 0)
      }
      this.desired.normalize().multiplyScalar(Math.sqrt(Math.max(1 - target * target, 0)))
      this.desired.addScaledVector(view, cosine >= 0 ? target : -target)
      const k = state.oriented ? 1 - Math.exp(-delta / 0.55) : 1
      state.normal.lerp(this.desired, k).normalize()
    }
    state.oriented = true

    this.quat.setFromUnitVectors(UNIT_Z, state.normal)
    state.discRoot.quaternion.copy(this.quat)

    // The camera in the disc's own frame, which is where the shader needs it.
    this.camDisc.copy(this.camLocal).applyQuaternion(this.quat.invert())
    const disc = state.disc.uniforms
    ;(disc.uCam.value as THREE.Vector3).copy(this.camDisc)
    disc.uTime.value = this.phase

    const radius = shadowApparentRadius(distance)
    state.shadow.uniforms.uRadius.value = radius
    // Below the photon sphere the apparent size saturates by construction — a quad
    // cannot draw more than half the sky — so the deepening interior is the only cue
    // left that the camera is still falling in. The ramp therefore runs to 1 r_s, not
    // to 2: stopping at 2 made the bottom of a zoom sweep three copies of one frame.
    state.shadow.uniforms.uInner.value = 1 - THREE.MathUtils.smoothstep(distance, 1, 9)
    state.ring.uniforms.uRadius.value = radius * RING_SPREAD

    // Which limb of the ring is coming towards us. The disc orbits anticlockwise about
    // its own +z, so the approaching side lies along z_view x n_view, and the ring
    // brightens there for the same reason the disc's near limb does.
    this.desired.copy(state.normal).applyQuaternion(this.viewQuat.copy(camera.quaternion).invert())
    const bx = -this.desired.y
    const by = this.desired.x
    const length = Math.hypot(bx, by)
    const boost = state.ring.uniforms.uBoost.value as THREE.Vector2
    if (length > 1e-4) boost.set(bx / length, by / length)
  }
}
