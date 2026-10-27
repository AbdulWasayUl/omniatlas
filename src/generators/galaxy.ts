import { type Rng, hashSeed, rngFrom } from './random'

/**
 * The inside of a galaxy that nobody has ever been inside.
 *
 * The atlas holds 950 galaxies, 216 clusters and 71 nebulae, and until now every one of
 * them was a point or an ellipse you could look at and not enter. That is the honest
 * state of the measurement: nobody has resolved a star in most of these, and the atlas
 * will not draw what nobody has seen. Immersive mode is where it is allowed to imagine
 * one instead, and this is the generator for it.
 *
 * Everything here is INVENTED. What it owes the viewer is a place that behaves like a
 * galaxy: a disc that thins outward, arms that wind the same way all the way round, a
 * halo of old clusters above and below the plane, star-forming regions along the arms
 * and not between them, and a core that is brighter and redder than anything else in it.
 *
 * Determinism is the same contract as everywhere else in this mode. The seed comes from
 * the galaxy's own catalogue id, so M51 has the same arms, the same clusters and the same
 * names every time anyone opens it, on any machine, forever.
 */

/** Broad morphology, which decides shape, colour and what landmarks are in it. */
export type GalaxyShape = 'spiral' | 'barred' | 'elliptical' | 'lenticular' | 'irregular'

export type LandmarkKind =
  | 'core'
  | 'nebula'
  | 'cluster'
  | 'starCloud'
  | 'remnant'
  | 'void'
  | 'knot'
  | 'front'
  | 'pulsar'
  | 'member'

/** What sort of thing the interior belongs to, which decides how it is built. */
export type InteriorForm = 'galaxy' | 'nebula' | 'cluster'

export interface GeneratedLandmark {
  id: string
  name: string
  kind: LandmarkKind
  /** Position in the galaxy's own frame, kiloparsecs. */
  x: number
  y: number
  z: number
  /** Characteristic radius, kiloparsecs. */
  radiusKpc: number
  color: string
  /** How bright to draw it, 0 to 1. */
  intensity: number
  description: string
}

export interface GeneratedGalaxy {
  hostId: string
  /**
   * A rotation applied to everything in this interior, as three basis vectors.
   *
   * Without one, every generated disc lay in the same plane as every other: the
   * generator works in a frame where z is the disc normal and the renderer dropped that
   * straight into ICRF, so the whole atlas tilted the same way. The rotation is seeded,
   * like everything else here, and it is applied at generation time so the landmarks and
   * the star cloud cannot drift apart.
   */
  basis: { e1: [number, number, number]; e2: [number, number, number]; e3: [number, number, number] }
  seed: number
  shape: GalaxyShape
  /** Half-light radius, kiloparsecs. */
  radiusKpc: number
  /** Thickness of the disc, kiloparsecs. Small for a spiral, large for an elliptical. */
  thicknessKpc: number
  armCount: number
  /** How tightly the arms wind: radians of rotation per e-folding of radius. */
  armPitch: number
  landmarks: GeneratedLandmark[]
  /** Points in the drawn star cloud. */
  starCount: number
  description: string
}

const SHAPE_LABEL: Record<GalaxyShape, string> = {
  spiral: 'Spiral galaxy',
  barred: 'Barred spiral galaxy',
  elliptical: 'Elliptical galaxy',
  lenticular: 'Lenticular galaxy',
  irregular: 'Irregular galaxy',
}

const SHAPE_NOTE: Record<GalaxyShape, readonly string[]> = {
  spiral: [
    'Arms wind out from a bright core and keep winding the same way the whole distance.',
    'Seen from above it is a pinwheel. Seen edge on it would be a line with a bulge in the middle.',
    'The arms are where the young stars are, which is why they are blue and the core is not.',
  ],
  barred: [
    'A straight bar crosses the core, and the arms start from its two ends rather than from the centre.',
    'The bar is funnelling gas inward, and the core is building something with it.',
    'Most spirals look like this, including the one the reader is standing in.',
  ],
  elliptical: [
    'No disc, no arms, and no particular direction. The stars orbit every which way.',
    'It finished forming stars a long time ago, and what is left is old and red.',
    'It is the result of other galaxies, several of them, and it kept none of their shapes.',
  ],
  lenticular: [
    'A disc with no arms in it: the shape of a spiral that ran out of gas.',
    'It has the structure for star formation and nothing left to form stars from.',
  ],
  irregular: [
    'No symmetry anywhere in it. Something pulled it out of shape and it never recovered.',
    'Star formation is happening in knots, scattered without pattern across the whole body.',
  ],
}

/** Name fragments, combined into landmark names that read like places. */
const NAME_FIRST = [
  'Amber', 'Ash', 'Bright', 'Cinder', 'Cold', 'Deep', 'Ember', 'Far', 'Glass', 'Grey',
  'High', 'Hollow', 'Iron', 'Lantern', 'Long', 'Low', 'Pale', 'Quiet', 'Red', 'Salt',
  'Shear', 'Silver', 'Slow', 'Still', 'Thin', 'Vast', 'White', 'Wide',
]
const NAME_SECOND: Record<LandmarkKind, readonly string[]> = {
  core: ['Throat', 'Furnace', 'Hub', 'Crown', 'Anvil'],
  nebula: ['Veil', 'Bloom', 'Shoal', 'Curtain', 'Drift', 'Hollow', 'Reach', 'Mantle'],
  cluster: ['Knot', 'Hive', 'Bell', 'Cairn', 'Crowd', 'Lantern', 'Nest', 'Spindle'],
  starCloud: ['Bank', 'Field', 'Shelf', 'Spill', 'Strand', 'Sprawl'],
  remnant: ['Scar', 'Wake', 'Shell', 'Ruin', 'Echo', 'Bell'],
  void: ['Gap', 'Quiet', 'Hollow', 'Lull', 'Gulf'],
  knot: ['Pillar', 'Spire', 'Knot', 'Finger', 'Thumb', 'Column'],
  front: ['Edge', 'Rim', 'Front', 'Wall', 'Break', 'Bow'],
  pulsar: ['Heart', 'Pin', 'Engine', 'Beacon', 'Clock'],
  member: ['Lamp', 'Watcher', 'Elder', 'Beacon', 'Ember', 'Sentinel', 'Lantern'],
}

const LANDMARK_LABEL: Record<LandmarkKind, string> = {
  core: 'Galactic core',
  nebula: 'Star-forming region',
  cluster: 'Globular cluster',
  starCloud: 'Star cloud',
  remnant: 'Supernova remnant',
  void: 'Dust void',
  knot: 'Dense knot',
  front: 'Shock front',
  pulsar: 'Neutron star',
  member: 'Bright member',
}

const LANDMARK_LINES: Record<LandmarkKind, readonly string[]> = {
  core: [
    'The density of stars here is such that the sky never goes properly dark.',
    'Something very heavy sits at the middle of it, and everything within a few parsecs is in a hurry.',
    'Orbits this close to the centre take a few thousand years, not a few hundred million.',
    'The light is old and red, and there is a great deal of it.',
  ],
  nebula: [
    'New stars are condensing out of it now, and their light is eating the cloud that made them.',
    'It glows because of what is inside it, not because of what falls on it.',
    'Pillars stand where denser knots have resisted the wind from the hot stars nearby.',
    'In a few million years there will be a cluster here and no cloud left at all.',
    'The colour is hydrogen, excited and falling back, over and over.',
  ],
  cluster: [
    'A few hundred thousand stars, bound to each other since before the disc below them existed.',
    'There is no gas left in it. Everything here formed at once, and nothing has formed since.',
    'From the middle of it, the nearest neighbours would be brighter than any planet in Earth’s sky.',
    'It is older than the galaxy it orbits, which is a strange thing to be able to say.',
  ],
  starCloud: [
    'Not a cluster, just a stretch of the arm where the stars happen to crowd.',
    'Dust thins out here and lets the light of a hundred thousand stars through at once.',
    'From outside it looks solid. From inside it is as empty as anywhere else.',
  ],
  remnant: [
    'A star ended here, and the shell it threw off is still expanding.',
    'The filaments are thin, bright, and moving outward fast enough to measure year by year.',
    'Whatever is left at the centre is small, dense, and turning very quickly.',
    'The elements that make rocky worlds were scattered from here, and are still on their way out.',
  ],
  void: [
    'Dust blocks this line of sight completely. Whatever is behind it is simply not available.',
    'A lane of cold dust, dark against the light of everything behind it.',
    'It is not empty. It is the opposite of empty, which is why nothing gets through.',
  ],
  knot: [
    'Gas dense enough here to shadow what is behind it, and dense enough to be collapsing.',
    'A pillar, with its head turned towards the stars that are eroding it.',
    'Something is forming inside this, and in a hundred thousand years it will blow the rest away.',
    'The edge of it glows where the radiation is eating in, and the inside stays dark.',
  ],
  front: [
    'The expanding edge, moving outward fast enough to measure from one year to the next.',
    'Where the ejecta meets what was already here, both of them light up.',
    'A thin bright rim, and nothing behind it but the gas it has already swept.',
  ],
  pulsar: [
    'What is left of the star: a few kilometres across, and turning tens of times a second.',
    'It is powering everything around it, and it will keep doing so for a very long time.',
    'The beam sweeps past this line of sight on a schedule you could set a clock by.',
  ],
  member: [
    'One of the brighter stars here, and old, like everything else in this crowd.',
    'A red giant, well past its best, and conspicuous for it.',
    'Close enough to its neighbours that their light would cast shadows.',
  ],
}

/** Three orthonormal axes from the seed, so not every disc lies in the same plane. */
function seededBasis(rng: Rng): GeneratedGalaxy['basis'] {
  // A random unit normal, then any two axes perpendicular to it.
  const cosT = rng.range(-1, 1)
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT))
  const phi = rng.range(0, Math.PI * 2)
  const e3: [number, number, number] = [sinT * Math.cos(phi), sinT * Math.sin(phi), cosT]
  const seed: [number, number, number] = Math.abs(e3[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0]
  const cross = (a: number[], b: number[]): [number, number, number] => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
  const norm = (v: [number, number, number]): [number, number, number] => {
    const n = Math.hypot(v[0], v[1], v[2]) || 1
    return [v[0] / n, v[1] / n, v[2] / n]
  }
  const e1 = norm(cross(seed, e3))
  const e2 = norm(cross(e3, e1))
  // A roll about the normal, so two galaxies with the same inclination still differ.
  const roll = rng.range(0, Math.PI * 2)
  const c = Math.cos(roll)
  const sn = Math.sin(roll)
  return {
    e1: [e1[0] * c + e2[0] * sn, e1[1] * c + e2[1] * sn, e1[2] * c + e2[2] * sn],
    e2: [e2[0] * c - e1[0] * sn, e2[1] * c - e1[1] * sn, e2[2] * c - e1[2] * sn],
    e3,
  }
}

/** Take a point from the generator's frame into the interior's own orientation. */
function rotate(basis: GeneratedGalaxy['basis'], x: number, y: number, z: number): [number, number, number] {
  return [
    basis.e1[0] * x + basis.e2[0] * y + basis.e3[0] * z,
    basis.e1[1] * x + basis.e2[1] * y + basis.e3[1] * z,
    basis.e1[2] * x + basis.e2[2] * y + basis.e3[2] * z,
  ]
}

function landmarkName(kind: LandmarkKind, rng: Rng, used: Set<string>): string {
  for (let attempt = 0; attempt < 24; attempt++) {
    const name = `the ${rng.pick(NAME_FIRST)} ${rng.pick(NAME_SECOND[kind])}`
    if (!used.has(name)) {
      used.add(name)
      return name
    }
  }
  return `the ${rng.pick(NAME_FIRST)} ${rng.pick(NAME_SECOND[kind])} ${used.size}`
}

const NEBULA_COLORS = ['#c8527a', '#b8486b', '#8f5fb0', '#4f7fc0', '#3f9c8f', '#c06a4a']
const CLUSTER_COLORS = ['#ffe6c0', '#ffd9a8', '#fff0d8', '#ffdcb0']
const CORE_COLORS = ['#ffd9a0', '#ffcf8c', '#ffe3b8']

/**
 * Invent the inside of a galaxy.
 *
 * `radiusMetres` is the host's catalogued size where the atlas has one, so a big galaxy
 * comes out big. Everything else is from the seed.
 */
/**
 * Published morphological types for the galaxies people actually fly to.
 *
 * The atlas carries a T-type for the 868 Local Volume galaxies in UNGC and for nothing
 * else, so a bright galaxy outside that volume fell back to the seed. Usually harmless;
 * occasionally badly wrong, and wrong in the way that costs trust. M87 came out as a
 * barred spiral, and M87 is the elliptical that every textbook uses to show what an
 * elliptical is.
 *
 * These are the published de Vaucouleurs types from RC3 and HyperLeda, in the same
 * convention UNGC uses, for the galaxies with a Messier number or a common name. They
 * are measurements, not inventions, which is why there is a table of them rather than a
 * better guess.
 */
const PUBLISHED_T: Record<string, number> = {
  NGC224: 3, NGC598: 6, NGC221: -5, NGC205: -5, // M31, M33, M32, M110
  NGC1068: 3, NGC1316: -2, NGC1365: 3, NGC1399: -5,
  NGC2403: 6, NGC2903: 4, NGC3031: 2, NGC3034: 10, // M81, M82
  NGC3115: -3, NGC3351: 3, NGC3368: 2, NGC3379: -5, // M95, M96, M105
  NGC3556: 6, NGC3627: 3, NGC4038: 9, NGC4039: 9,
  NGC4258: 4, NGC4321: 4, NGC4374: -5, NGC4406: -5, // M106, M100, M84, M86
  NGC4435: -2, NGC4438: 0, NGC4472: -5, NGC4486: -4, // M49, M87
  NGC4501: 3, NGC4552: -5, NGC4565: 3, NGC4569: 2,
  NGC4594: 1, NGC4621: -5, NGC4649: -5, NGC4736: 2, // M104 Sombrero, M59, M60, M94
  NGC4826: 2, NGC5055: 4, NGC5128: -2, NGC5194: 4, // M64, M63, Centaurus A, M51
  NGC5236: 5, NGC5457: 6, NGC6822: 10, NGC253: 5,
  NGC300: 7, NGC55: 9, NGC7331: 3, NGC891: 3,
}

/** `ngc:NGC5194` and `ungc:ngc5194` both reduce to NGC5194. */
function designationOf(id: string): string | null {
  const body = id.slice(id.indexOf(':') + 1)
  const match = /^(NGC|IC)[\s_-]*0*(\d+)$/i.exec(body)
  return match ? `${match[1].toUpperCase()}${match[2]}` : null
}

/** The published type for this host, if it is one of the well-known ones. */
export function publishedMorphology(hostId: string): number | undefined {
  const key = designationOf(hostId)
  return key ? PUBLISHED_T[key] : undefined
}

export function shapeFromMorphology(tType: number | undefined): GalaxyShape | undefined {
  if (typeof tType !== 'number' || !Number.isFinite(tType)) return undefined
  // The de Vaucouleurs sequence, coarsely: ellipticals are negative, lenticulars sit
  // around zero, spirals run from about 1 to 9, and past that it is irregular. The
  // bar is not in the T-type at all, so which spirals are barred stays with the seed.
  if (tType <= -4) return 'elliptical'
  if (tType <= 0) return 'lenticular'
  if (tType <= 9) return 'spiral'
  return 'irregular'
}

/**
 * Build whatever kind of inside this host should have.
 *
 * The atlas's "explorable" set is galaxies, nebulae and star clusters, and they are not
 * the same thing at all. Generating a galaxy for every one of them gave the Crab Nebula
 * spiral arms and sixteen globular clusters, which is a supernova remnant with the inside
 * of a galaxy in it.
 */
export function generateInterior(
  hostId: string,
  radiusMetres: number,
  form: InteriorForm,
  shapeHint?: GalaxyShape,
): GeneratedGalaxy {
  if (form === 'nebula') return generateNebula(hostId, radiusMetres, isKnownRemnant(hostId))
  // `gc:` is the Harris catalogue, which is globulars and nothing else. Without this,
  // omega Centauri came out an open cluster, and omega Centauri is the largest globular
  // in the Galaxy.
  if (form === 'cluster') return generateCluster(hostId, radiusMetres, hostId.startsWith('gc:') ? true : undefined)
  return generateGalaxy(hostId, radiusMetres, shapeHint)
}

/**
 * The famous supernova remnants, which should not come out as star-forming clouds.
 *
 * OpenNGC distinguishes a remnant from an emission nebula and the atlas does not carry
 * that column on the registry node, so the seed decided, and the Crab had a one in three
 * chance of being described as a nursery. These are the ones a reader will recognise.
 */
const KNOWN_REMNANTS = new Set([
  'NGC1952', // Crab
  'NGC6960', 'NGC6992', 'NGC6995', // Veil
  'NGC6888', // Crescent
  'IC443', 'NGC2736',
])

function isKnownRemnant(hostId: string): boolean | undefined {
  const body = hostId.slice(hostId.indexOf(':') + 1).toUpperCase().replace(/\s|_/g, '')
  return KNOWN_REMNANTS.has(body) ? true : undefined
}

export function generateGalaxy(hostId: string, radiusMetres: number, shapeHint?: GalaxyShape): GeneratedGalaxy {
  const seed = hashSeed(`galaxy:${hostId}`)
  const rng = rngFrom(seed)
  const KPC_M = 3.0856775814913673e19

  const radiusKpc = radiusMetres > 0 ? Math.min(90, Math.max(1.2, radiusMetres / KPC_M)) : rng.range(4, 28)

  // A measured type wins where the atlas has one. Where it says "spiral" the seed still
  // chooses whether the spiral is barred, because the T-type does not record that and
  // roughly two thirds of spirals are.
  const measured = shapeHint
  const roll = rng.next()
  const seeded: GalaxyShape =
    roll < 0.42 ? 'barred' : roll < 0.74 ? 'spiral' : roll < 0.87 ? 'elliptical' : roll < 0.95 ? 'lenticular' : 'irregular'
  const shape: GalaxyShape = measured === 'spiral' ? (rng.chance(0.62) ? 'barred' : 'spiral') : (measured ?? seeded)

  const discLike = shape === 'spiral' || shape === 'barred' || shape === 'lenticular'
  const thicknessKpc = discLike ? radiusKpc * rng.range(0.03, 0.09) : radiusKpc * rng.range(0.45, 0.85)
  const armCount = shape === 'barred' ? 2 : shape === 'spiral' ? (rng.chance(0.55) ? 2 : rng.chance(0.6) ? 4 : 3) : 0
  const armPitch = rng.range(0.18, 0.42)

  const basis = seededBasis(rng)
  const used = new Set<string>()
  const landmarks: GeneratedLandmark[] = []

  const add = (kind: LandmarkKind, x: number, y: number, z: number, radiusK: number, color: string, intensity: number) => {
    const name = landmarkName(kind, rng, used)
    const id = `${hostId}/${name.replace(/^the /, '').toLowerCase().replace(/\s+/g, '-')}`
    const [rx, ry, rz] = rotate(basis, x, y, z)
    landmarks.push({
      id,
      name,
      kind,
      x: rx,
      y: ry,
      z: rz,
      radiusKpc: radiusK,
      color,
      intensity,
      description: `${LANDMARK_LABEL[kind]}. ${rng.pick(LANDMARK_LINES[kind])}`,
    })
  }

  // The core, always, because every one of these has a middle.
  add('core', 0, 0, 0, Math.max(0.12, radiusKpc * 0.05), rng.pick(CORE_COLORS), 0.55)

  // Star-forming regions and clouds sit in the disc, and in a spiral they sit ON the arms.
  const nebulaCount = discLike ? 4 + Math.floor(rng.next() * 6) : shape === 'irregular' ? 5 + Math.floor(rng.next() * 5) : 1
  for (let i = 0; i < nebulaCount; i++) {
    const r = radiusKpc * rng.range(0.15, 0.92)
    let theta = rng.range(0, Math.PI * 2)
    if (armCount > 0) {
      // Snap to the nearest arm, with scatter: a star-forming region sits where the gas
      // piled up, and the gas piles up in the arms.
      const arm = Math.floor(rng.next() * armCount)
      theta = Math.log(Math.max(r, 0.05) / Math.max(radiusKpc * 0.1, 0.05)) / armPitch + (arm * 2 * Math.PI) / armCount
      theta += rng.signed() * 0.22
    }
    add(
      rng.chance(0.65) ? 'nebula' : 'starCloud',
      r * Math.cos(theta),
      r * Math.sin(theta),
      rng.signed() * thicknessKpc * 0.8,
      radiusKpc * rng.range(0.015, 0.06),
      rng.pick(NEBULA_COLORS),
      rng.range(0.5, 1),
    )
  }

  // Globular clusters live in the halo, above and below the plane as often as in it.
  const clusterCount = 3 + Math.floor(rng.next() * 7)
  for (let i = 0; i < clusterCount; i++) {
    const r = radiusKpc * rng.logRange(0.1, 1.6)
    const theta = rng.range(0, Math.PI * 2)
    const cosPhi = rng.range(-1, 1)
    const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi))
    add(
      'cluster',
      r * sinPhi * Math.cos(theta),
      r * sinPhi * Math.sin(theta),
      r * cosPhi,
      radiusKpc * rng.range(0.004, 0.016),
      rng.pick(CLUSTER_COLORS),
      rng.range(0.45, 0.9),
    )
  }

  if (discLike && rng.chance(0.75)) {
    const r = radiusKpc * rng.range(0.2, 0.8)
    const theta = rng.range(0, Math.PI * 2)
    add('remnant', r * Math.cos(theta), r * Math.sin(theta), rng.signed() * thicknessKpc, radiusKpc * rng.range(0.008, 0.025), '#7fd0c8', rng.range(0.4, 0.8))
  }
  if (discLike && rng.chance(0.6)) {
    const r = radiusKpc * rng.range(0.25, 0.85)
    const theta = rng.range(0, Math.PI * 2)
    add('void', r * Math.cos(theta), r * Math.sin(theta), rng.signed() * thicknessKpc * 0.5, radiusKpc * rng.range(0.03, 0.09), '#241c20', rng.range(0.5, 0.9))
  }

  const starCount = Math.round(18000 + radiusKpc * 900)

  return {
    hostId,
    seed,
    basis,
    shape,
    radiusKpc,
    thicknessKpc,
    armCount,
    armPitch,
    landmarks,
    starCount,
    description: `${SHAPE_LABEL[shape]}. ${rng.pick(SHAPE_NOTE[shape])}`,
  }
}

/**
 * The inside of a nebula: gas, the stars lighting it, and the structures in between.
 *
 * A nebula is parsecs across rather than kiloparsecs, so the scale here is three orders
 * smaller than a galaxy's and the landmarks are different in kind. The ionising stars are
 * inside it rather than orbiting it, the knots are being eaten rather than forming, and
 * there is no core, no halo and nothing in orbit around anything.
 */
function generateNebula(hostId: string, radiusMetres: number, remnantHint?: boolean): GeneratedGalaxy {
  const seed = hashSeed(`nebula:${hostId}`)
  const rng = rngFrom(seed)
  const basis = seededBasis(rng)
  const KPC_M = 3.0856775814913673e19
  const radiusKpc = radiusMetres > 0 ? Math.max(0.0004, Math.min(0.2, radiusMetres / KPC_M)) : rng.range(0.002, 0.02)

  const used = new Set<string>()
  const landmarks: GeneratedLandmark[] = []
  const add = (kind: LandmarkKind, x: number, y: number, z: number, r: number, color: string, intensity: number) => {
    const name = landmarkName(kind, rng, used)
    landmarks.push({
      id: `${hostId}/${name.replace(/^the /, '').toLowerCase().replace(/\s+/g, '-')}`,
      name, kind, x, y, z, radiusKpc: r, color, intensity,
      description: `${LANDMARK_LABEL[kind]}. ${rng.pick(LANDMARK_LINES[kind])}`,
    })
  }

  const remnant = remnantHint ?? rng.chance(0.35)
  if (remnant) {
    add('pulsar', 0, 0, 0, radiusKpc * 0.02, '#cfe4ff', 1)
    const fronts = 2 + Math.floor(rng.next() * 3)
    for (let i = 0; i < fronts; i++) {
      const theta = rng.range(0, Math.PI * 2)
      const cosPhi = rng.range(-1, 1)
      const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi))
      const r = radiusKpc * rng.range(0.7, 1.05)
      add('front', r * sinPhi * Math.cos(theta), r * sinPhi * Math.sin(theta), r * cosPhi,
        radiusKpc * rng.range(0.1, 0.22), rng.pick(['#7fd0c8', '#9fd8e8', '#c86a7a']), rng.range(0.5, 0.95))
    }
  } else {
    // A star-forming cloud: the hot stars that light it, and the pillars resisting them.
    const lights = 2 + Math.floor(rng.next() * 4)
    for (let i = 0; i < lights; i++) {
      const r = radiusKpc * rng.range(0, 0.45)
      const theta = rng.range(0, Math.PI * 2)
      add('member', r * Math.cos(theta), r * Math.sin(theta), rng.signed() * radiusKpc * 0.3,
        radiusKpc * rng.range(0.02, 0.05), '#dce8ff', rng.range(0.7, 1))
    }
  }
  const knots = 3 + Math.floor(rng.next() * 5)
  for (let i = 0; i < knots; i++) {
    const r = radiusKpc * rng.range(0.2, 0.95)
    const theta = rng.range(0, Math.PI * 2)
    const cosPhi = rng.range(-0.6, 0.6)
    add('knot', r * Math.cos(theta), r * Math.sin(theta), r * cosPhi,
      radiusKpc * rng.range(0.08, 0.2), rng.pick(NEBULA_COLORS), rng.range(0.4, 0.85))
  }

  return {
    hostId, seed, basis, shape: 'irregular', radiusKpc, thicknessKpc: radiusKpc * 0.7,
    armCount: 0, armPitch: 0, landmarks,
    starCount: Math.round(2500 + rng.next() * 3500),
    description: remnant
      ? 'Supernova remnant. A star ended here, and what it threw off is still moving outward fast enough to measure.'
      : 'Emission nebula. It glows from the inside, lit by stars that formed out of it and are now destroying it.',
  }
}

/**
 * The inside of a star cluster: a crowd, and a few of its brighter members.
 *
 * Globulars are old, dense and spherical with no gas left; open clusters are young, loose
 * and still trailing the cloud they came from. Both are stars and almost nothing else,
 * which is why this has no nebulae in it and no core worth naming.
 */
function generateCluster(hostId: string, radiusMetres: number, globularHint?: boolean): GeneratedGalaxy {
  const seed = hashSeed(`cluster:${hostId}`)
  const rng = rngFrom(seed)
  const basis = seededBasis(rng)
  const KPC_M = 3.0856775814913673e19
  const radiusKpc = radiusMetres > 0 ? Math.max(0.0008, Math.min(0.08, radiusMetres / KPC_M)) : rng.range(0.003, 0.02)
  const globular = globularHint ?? rng.chance(0.55)

  const used = new Set<string>()
  const landmarks: GeneratedLandmark[] = []
  const count = 3 + Math.floor(rng.next() * 5)
  for (let i = 0; i < count; i++) {
    const r = radiusKpc * Math.pow(rng.next(), globular ? 1.6 : 0.8)
    const theta = rng.range(0, Math.PI * 2)
    const cosPhi = rng.range(-1, 1)
    const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi))
    const name = landmarkName('member', rng, used)
    landmarks.push({
      id: `${hostId}/${name.replace(/^the /, '').toLowerCase().replace(/\s+/g, '-')}`,
      name, kind: 'member',
      x: rotate(basis, r * sinPhi * Math.cos(theta), r * sinPhi * Math.sin(theta), r * cosPhi)[0],
      y: rotate(basis, r * sinPhi * Math.cos(theta), r * sinPhi * Math.sin(theta), r * cosPhi)[1],
      z: rotate(basis, r * sinPhi * Math.cos(theta), r * sinPhi * Math.sin(theta), r * cosPhi)[2],
      radiusKpc: radiusKpc * rng.range(0.03, 0.07),
      color: globular ? rng.pick(['#ffd0a0', '#ffc088', '#ffe0c0']) : rng.pick(['#cfe0ff', '#dde8ff', '#b8d0ff']),
      intensity: rng.range(0.6, 1),
      description: `${LANDMARK_LABEL.member}. ${rng.pick(LANDMARK_LINES.member)}`,
    })
  }

  return {
    hostId, seed, basis, shape: 'elliptical', radiusKpc,
    thicknessKpc: radiusKpc * (globular ? 0.95 : 0.7),
    armCount: 0, armPitch: 0, landmarks,
    starCount: Math.round(globular ? 14000 + rng.next() * 16000 : 1200 + rng.next() * 2600),
    description: globular
      ? 'Globular cluster. A few hundred thousand stars bound together since before the galaxy around them had a shape.'
      : 'Open cluster. A few thousand young stars, still drifting apart from the cloud that made them.',
  }
}

/**
 * The drawn star cloud: positions in kiloparsecs, in the galaxy's own frame.
 *
 * A prefix of this array is itself a valid realisation of the same galaxy at lower
 * density, because the sampling is independent per point. That is what lets the renderer
 * draw fewer of them when the galaxy is small on screen without the shape changing.
 */
export function galaxyStarField(galaxy: GeneratedGalaxy): Float32Array {
  const rng = rngFrom(galaxy.seed ^ 0x5bf03635)
  const out = new Float32Array(galaxy.starCount * 3)
  const discLike = galaxy.shape === 'spiral' || galaxy.shape === 'barred' || galaxy.shape === 'lenticular'

  for (let i = 0; i < galaxy.starCount; i++) {
    let x: number
    let y: number
    let z: number
    if (!discLike) {
      // A de Vaucouleurs-ish blob: dense middle, long tail, no preferred plane.
      const r = galaxy.radiusKpc * Math.pow(rng.next(), 2.2) * 1.6
      const theta = rng.range(0, Math.PI * 2)
      const cosPhi = rng.range(-1, 1)
      const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi))
      x = r * sinPhi * Math.cos(theta)
      y = r * sinPhi * Math.sin(theta) * (galaxy.shape === 'elliptical' ? rng.range(0.6, 1) : 1)
      z = r * cosPhi * (galaxy.thicknessKpc / galaxy.radiusKpc) * 1.4
    } else {
      // Exponential disc, with the arms as an overdensity rather than a separate thing.
      const r = -Math.log(Math.max(1e-6, rng.next())) * galaxy.radiusKpc * 0.42
      let theta = rng.range(0, Math.PI * 2)
      if (galaxy.armCount > 0 && rng.chance(0.74) && r > galaxy.radiusKpc * 0.08) {
        const arm = Math.floor(rng.next() * galaxy.armCount)
        theta =
          Math.log(Math.max(r, 0.05) / Math.max(galaxy.radiusKpc * 0.1, 0.05)) / galaxy.armPitch +
          (arm * 2 * Math.PI) / galaxy.armCount +
          rng.signed() * 0.17
      }
      x = r * Math.cos(theta)
      y = r * Math.sin(theta)
      z = rng.signed() * galaxy.thicknessKpc
      if (galaxy.shape === 'barred' && r < galaxy.radiusKpc * 0.3) {
        // Straighten the inner disc into a bar.
        const t = 1 - r / (galaxy.radiusKpc * 0.3)
        x = x * (1 - t) + r * Math.cos(theta) * (1 + t * 0.9)
        y = y * (1 - t) * (1 - t * 0.75)
      }
    }
    const [rx, ry, rz] = rotate(galaxy.basis, x, y, z)
    out[i * 3] = rx
    out[i * 3 + 1] = ry
    out[i * 3 + 2] = rz
  }
  return out
}
