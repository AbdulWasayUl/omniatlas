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
  'Amber', 'Ash', 'Bitter', 'Black', 'Bright', 'Broken', 'Cinder', 'Clay', 'Cold', 'Copper',
  'Deep', 'Drowned', 'Dust', 'Ember', 'Far', 'First', 'Glass', 'Grey', 'Half', 'High',
  'Hollow', 'Hungry', 'Iron', 'Lantern', 'Last', 'Long', 'Low', 'Narrow', 'Old', 'Pale',
  'Patient', 'Quiet', 'Rust', 'Salt', 'Shear', 'Silver', 'Slow', 'Smoke', 'Still', 'Stone',
  'Tall', 'Thin', 'Thorn', 'Vast', 'Wandering', 'White', 'Wide', 'Winter',
]
const NAME_SECOND: Record<LandmarkKind, readonly string[]> = {
  core: ['Throat', 'Furnace', 'Hub', 'Crown', 'Anvil', 'Forge', 'Axle', 'Well'],
  nebula: [
    'Veil', 'Bloom', 'Shoal', 'Curtain', 'Drift', 'Hollow', 'Reach', 'Mantle', 'Garden',
    'Cradle', 'Loom', 'Haze', 'Awning', 'Bank', 'Billow', 'Canopy', 'Fathom', 'Fleece',
    'Lantern', 'Nursery', 'Pall', 'Shroud',
  ],
  cluster: [
    'Knot', 'Hive', 'Bell', 'Cairn', 'Crowd', 'Nest', 'Spindle', 'Choir', 'Congress',
    'Hoard', 'Swarm', 'Assembly', 'Beehive', 'Bundle', 'Clutch', 'Company', 'Gathering',
    'Granary', 'Huddle', 'Muster', 'Reliquary', 'Vault',
  ],
  starCloud: ['Bank', 'Field', 'Shelf', 'Spill', 'Strand', 'Sprawl', 'Meadow', 'Drift', 'Scatter'],
  remnant: ['Scar', 'Wake', 'Shell', 'Ruin', 'Echo', 'Bell', 'Cinder', 'Aftermath'],
  void: ['Gap', 'Quiet', 'Hollow', 'Lull', 'Gulf', 'Shadow', 'Absence', 'Shutter'],
  knot: ['Pillar', 'Spire', 'Knot', 'Finger', 'Thumb', 'Column', 'Tower', 'Anvil'],
  front: ['Edge', 'Rim', 'Front', 'Wall', 'Break', 'Bow', 'Verge', 'Margin'],
  pulsar: ['Heart', 'Pin', 'Engine', 'Beacon', 'Clock', 'Needle', 'Metronome'],
  member: ['Lamp', 'Watcher', 'Elder', 'Beacon', 'Ember', 'Sentinel', 'Candle', 'Warden', 'Keeper'],
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
    'Every orbit in this galaxy is ultimately about what is here.',
    'The stars are packed so closely that from inside, night would never properly fall.',
    'It is the oldest part of the galaxy and the most crowded.',
    'Gas falling in from outside never gets back out.',
    'The motions here are measured in hundreds of kilometres a second.',
    'Whatever is at the exact centre is small, dark, and extremely heavy.',
  ],
  nebula: [
    'New stars are condensing out of it now, and their light is eating the cloud that made them.',
    'It glows because of what is inside it, not because of what falls on it.',
    'Pillars stand where denser knots have resisted the wind from the hot stars nearby.',
    'In a few million years there will be a cluster here and no cloud left at all.',
    'The colour is hydrogen, excited and falling back, over and over.',
    'Dark lanes cross the front of it where the dust has not been cleared.',
    'The youngest stars in it are still wrapped in what they were made from.',
    'It is thinner than any laboratory vacuum and bright enough to see across a galaxy.',
    'Shock waves run through it where the winds of the big stars collide.',
    'There are places inside it that light has not reached since it formed.',
  ],
  cluster: [
    'A few hundred thousand stars, bound to each other since before the disc below them existed.',
    'There is no gas left in it. Everything here formed at once, and nothing has formed since.',
    'From the middle of it, the nearest neighbours would be brighter than any planet in Earth’s sky.',
    'It is older than the galaxy it orbits, which is a strange thing to be able to say.',
    'Packed tightly enough at the centre that the individual stars stop being separable.',
    'It has lost most of what it started with to the tides, and what remains is the hard core of it.',
    'A sphere of old red stars, falling through the disc and out the other side.',
    'Everything in it is the same age and almost the same composition, which is why it is so useful.',
    'The brightest members are red giants, and they are what gives it its colour from outside.',
    'It trails a thin stream of stars behind it, stripped away pass by pass.',
    'Nothing has disturbed its middle since it formed, and nothing is likely to.',
  ],
  starCloud: [
    'Not a cluster, just a stretch of the arm where the stars happen to crowd.',
    'Dust thins out here and lets the light of a hundred thousand stars through at once.',
    'From outside it looks solid. From inside it is as empty as anywhere else.',
    'A window rather than an object: the arm behind it is doing the work.',
    'The stars in it have nothing to do with each other beyond a line of sight.',
    'Bright enough from far away to have been catalogued long before anyone knew what it was.',
    'It will have sheared apart within an orbit or two of the centre.',
    'There is no boundary to it, only a place where counting gets harder.',
    'Older surveys mapped it as one object, and it has kept the name.',
    'Its light is the sum of more stars than anyone has ever counted individually.',
  ],
  remnant: [
    'A star ended here, and the shell it threw off is still expanding.',
    'The filaments are thin, bright, and moving outward fast enough to measure year by year.',
    'Whatever is left at the centre is small, dense, and turning very quickly.',
    'The elements that make rocky worlds were scattered from here, and are still on their way out.',
    'For a few weeks it outshone everything else in this galaxy put together.',
    'The shell is thinner on one side, where it met less to push against.',
    'Somebody somewhere saw this happen, and may have written it down.',
    'What it scattered is the reason rocky worlds are possible at all.',
    'It is still expanding and it will not stop for a long time.',
    'The gas around it has been rearranged permanently.',
  ],
  void: [
    'Dust blocks this line of sight completely. Whatever is behind it is simply not available.',
    'A lane of cold dust, dark against the light of everything behind it.',
    'It is not empty. It is the opposite of empty, which is why nothing gets through.',
    'The grains in it are the size of smoke, and there are enough of them to hide a galaxy.',
    'At longer wavelengths it is not dark at all, and what is inside it is busy.',
    'It is the coldest place for a long way in any direction.',
    'Its outline is sharp enough to trace by hand from an image.',
    'Everything behind it has been catalogued as absent.',
    'Something is forming in there and nobody outside will know until it emerges.',
    'It looks like a hole and it is the densest thing in the frame.',
  ],
  knot: [
    'Gas dense enough here to shadow what is behind it, and dense enough to be collapsing.',
    'A pillar, with its head turned towards the stars that are eroding it.',
    'Something is forming inside this, and in a hundred thousand years it will blow the rest away.',
    'The edge of it glows where the radiation is eating in, and the inside stays dark.',
    'It is being sculpted from one side only, and it shows.',
    'What is left of it is what was dense enough to resist.',
    'The far side of it has never been lit by anything.',
    'Give it long enough and there will be a star here and no pillar at all.',
    'It casts a shadow longer than most solar systems are wide.',
    'Its surface is boiling away into the cavity beside it.',
  ],
  front: [
    'The expanding edge, moving outward fast enough to measure from one year to the next.',
    'Where the ejecta meets what was already here, both of them light up.',
    'A thin bright rim, and nothing behind it but the gas it has already swept.',
    'It is slowing, but not by much, and not yet.',
    'The gas it has passed through is hotter than the gas it brought with it.',
    'Seen edge on it is a bright filament; seen face on it is almost nothing.',
    'It is ragged where it met something dense and smooth where it did not.',
    'Everything it touches is lit for a while and then goes out again.',
    'This edge has been travelling since before anyone was watching.',
    'It is thin enough that the stars behind it show through unchanged.',
  ],
  pulsar: [
    'What is left of the star: a few kilometres across, and turning tens of times a second.',
    'It is powering everything around it, and it will keep doing so for a very long time.',
    'The beam sweeps past this line of sight on a schedule you could set a clock by.',
    'It is the size of a city and heavier than the star it came from.',
    'Its surface gravity would flatten anything that reached it, instantly and completely.',
    'The magnetic field around it is the strongest thing in this part of the galaxy.',
    'It has been slowing down since the day it formed, by a measurable amount.',
    'Everything bright nearby is bright because of it.',
    'Nothing about it is visible except what it does to its surroundings.',
    'It will still be turning long after the shell around it has dispersed.',
  ],
  member: [
    'One of the brighter stars here, and old, like everything else in this crowd.',
    'A red giant, well past its best, and conspicuous for it.',
    'Close enough to its neighbours that their light would cast shadows.',
    'It has been here since the crowd formed and will outlast most of it.',
    'Bright enough to have been picked out individually from a very long way off.',
    'It is burning helium now, which is the beginning of the end for a star.',
    'Its colour gives away both its age and what it is made of.',
    'One of the few here with a name rather than a number.',
    'It has swollen well past the size it spent most of its life at.',
    'A straggler: bluer and younger-looking than it has any right to be.',
    'If it has worlds, their skies are never dark.',
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

/**
 * A name for one place, avoiding both words another place in the same host already used.
 *
 * Deduping the whole string was not enough. One galaxy came out holding the Lantern
 * Bloom, the Lantern Reach and the Lantern Scar, plus an Iron Bell and a High Bell: every
 * name distinct, and the set of them reading like a list of variations rather than a list
 * of places. Each word is now claimed, and only released when the vocabulary runs out.
 */

/**
 * A second sentence per place, drawn separately from the first.
 *
 * One sentence from a pool of three or four meant 107 landmarks across eight galaxies
 * shared nineteen sentences between them, and one of them appeared fourteen times. Two
 * independent draws plus a measured clause takes the same vocabulary a very long way:
 * the same arithmetic that makes 887 worlds come out with 887 different descriptions.
 */
const LANDMARK_DETAIL: Record<LandmarkKind, readonly string[]> = {
  core: [
    'Everything within reach of it is moving fast and has been for a long time.',
    'The stars here are packed close enough that collisions are a normal event rather than a catastrophe.',
    'Whatever formed first in this galaxy formed here.',
    'Nothing young survives this close in.',
    'The light leaving it was made by stars that are already gone.',
    'Nothing here has been quiet for as long as the galaxy has existed.',
    'The orbits are short enough that a star can lap the centre many times in a life.',
    'Most of the galaxy\u2019s heavy elements passed through here on the way out.',
    'Light from the far side of it takes a human lifetime to cross.',
    'It is the one place in the galaxy that everything else is arranged around.',
  ],
  nebula: [
    'Give it ten million years and there will be a cluster here and nothing else.',
    'The hot stars inside are eating it from within and will finish the job.',
    'Dust sits in lanes across the front of it, dark against the glow behind.',
    'Its edges are ragged where the radiation has already broken through.',
    'It is bright in a handful of narrow colours and almost nothing in between.',
    'Most of what it is made of will end up in stars, and the rest will be blown clear.',
    'Its shape is set by the winds inside it rather than by anything it inherited.',
    'In a photograph it is the brightest thing for a long way; in the infrared it is a different object.',
    'What is forming in it now will outlive it by billions of years.',
    'Nothing about it is stable on any timescale worth the word.',
  ],
  cluster: [
    'It has survived every pass through the disc so far, and it has made many.',
    'Nothing in it has formed since it did.',
    'Its orbit takes it far above the plane and back again.',
    'The centre is crowded enough that stars there trade partners.',
    'It is one of the oldest things in this galaxy by a wide margin.',
    'It passes through the disc every few hundred million years and loses a little each time.',
    'There is no dust in it at all, which is why it looks so clean.',
    'Its brightest members are visible from outside the galaxy.',
    'It is bound tightly enough that nothing short of the core will break it up.',
    'Everything here was made from the same cloud at the same moment.',
  ],
  starCloud: [
    'It is a line of sight more than an object, and knowing that does not make it less striking.',
    'The stars in it are not bound to each other and will have drifted apart before long.',
    'From the far side it would not look like anything at all.',
    'It has no edge anybody could agree on.',
    'The crowding is a trick of depth: these stars are no closer to each other than any others.',
    'Depth is doing all the work: these stars are no nearer each other than any others.',
    'It is an accident of where the dust is not.',
    'Resolve it and it stops being a thing at all.',
    'Nobody has ever agreed where it ends.',
    'It was named before anyone knew what they were looking at.',
  ],
  remnant: [
    'The shell is still accelerating into whatever was thinnest around it.',
    'What it scattered is already part of the next generation of stars.',
    'It will be undetectable in a hundred thousand years, which is not long.',
    'The gas it swept up is hotter than the gas it threw out.',
    'Its filaments are thin enough to see straight through in places.',
    'The shock is still travelling outward and will be for thousands of years.',
    'It is brightest where it ran into something and faintest where it did not.',
    'What it scattered is already inside the next generation of stars.',
    'Nothing at the centre is more than a few kilometres across.',
    'It is younger than most human writing.',
  ],
  void: [
    'Nothing behind it has been seen at any wavelength that matters here.',
    'It is colder inside than anything around it, which is why it holds together.',
    'Stars are forming in it, and none of that is visible from outside.',
    'Its edge is sharper than a cloud has any right to be.',
    'Nothing has got through it in the time anyone has been looking.',
    'It is cold enough inside for molecules to survive that would not anywhere else.',
    'It is denser than anything bright nearby, which is the whole point.',
    'Its edges are where the dust runs out rather than where anything begins.',
    'What it hides has never been counted.',
    'It will be a cluster one day, and then it will be gone.',
  ],
  knot: [
    'The head of it is denser than the rest and is sheltering what lies behind.',
    'It will outlast the cloud it is standing in, and then it will go too.',
    'There is something inside it that has not finished collapsing.',
    'Its shadow stretches away from the stars that are eroding it.',
    'It is denser at the head and trails away behind, like everything in this wind.',
    'Something inside it stopped being gas a long time ago.',
    'It is losing its outer layers faster than it is gaining anything.',
    'The light behind it never reaches the far side.',
    'It will be a star and a memory of a pillar.',
    'Its shadow is measured in light years.',
  ],
  front: [
    'It is measurably further out than it was a decade ago.',
    'Everything it meets is swept up and carried along with it.',
    'The light here is from gas that has been hit rather than gas that is burning.',
    'Behind it there is very little left.',
    'It is brighter where it is slower and fainter where it is free.',
    'Measurable motion, year on year, with a good enough instrument.',
    'Everything behind it has already been swept.',
    'It is the only part of this that is still doing anything.',
    'Thin enough to see stars straight through.',
    'It has further to go than it has come.',
  ],
  pulsar: [
    'It is the densest thing for a very long way in any direction.',
    'Its spin is slowing, by an amount small enough to need good instruments and large enough to measure.',
    'The energy lighting everything nearby comes out of that rotation.',
    'A teaspoon of it would outweigh a mountain.',
    'It is turning faster than anything else of its size anywhere.',
    'What it radiates comes out of its rotation and nothing else.',
    'Its field lines sweep past here on a schedule.',
    'It will be doing this long after the shell has gone.',
    'A spoonful of it would weigh more than a mountain range.',
    'It is the densest thing anyone can point at.',
  ],
  member: [
    'It has been here since before the disc below had a shape.',
    'It is running out of the fuel it has left and the colour shows it.',
    'From a world in orbit around it, the rest of the crowd would never let the sky go dark.',
    'It is one of the few here bright enough to name from outside.',
    'Its light left before anything was here to see it.',
    'Bright enough to have a name of its own in a crowd of numbers.',
    'It has outlived almost everything it formed alongside.',
    'The colour is the giveaway: this one is nearly finished.',
    'From a world here the night sky would never be properly dark.',
    'It is one of the handful here that can be picked out from outside.',
  ],
}

/**
 * A measured clause, so no two places read identically even where the prose repeats.
 *
 * Size and position are the two things the generator actually knows about a place, and
 * they are different for every one of them.
 */
function lightYears(kpc: number): string {
  // One format throughout. Switching to "13.9 thousand light years" above a threshold
  // put two formats for the same unit in a single sentence: "3,037 light years across,
  // 13.9 thousand light years out from the centre".
  const n = Math.round(kpc * 3261.56)
  return `${n.toLocaleString('en-GB')} light ${n === 1 ? 'year' : 'years'}`
}

/**
 * How big a place is and where it sits, in the units the rest of the atlas uses.
 *
 * Kiloparsecs appear nowhere else in this interface, which shows light years and
 * thousands of them, and a rounding that could produce "1 light years" put a plural bug
 * on a tenth of all landmarks.
 *
 * `member` takes no size clause at all. A named star in a cluster was measured by the
 * same code as a nebula and came out "2 light years across" on all 154 of them: a star
 * some thirteen thousand times the width of the largest one known, stated as a fact, 154
 * times over. A number that sounds measured and is wrong is worse than the repetition
 * this clause was added to cure.
 */
function landmarkScale(kind: LandmarkKind, radiusKpc: number, distanceKpc: number): string {
  if (kind === 'member') {
    // Anything inside half a light year rounds to zero, and "It lies 0 light years from
    // the centre" is not a sentence.
    if (distanceKpc < 1.6e-4) return 'It sits at the very centre of the crowd.'
    return `It lies ${lightYears(distanceKpc)} from the centre of the crowd.`
  }
  const size = `${lightYears(radiusKpc * 2)} across`
  if (distanceKpc < 1e-4) return `It is ${size}, and it sits at the centre.`
  return `It is ${size}, ${lightYears(distanceKpc)} out from the centre.`
}

/**
 * Pick from a pool, preferring something this host has not used yet.
 *
 * Deduping only the whole description was not enough: the trailing measurement made
 * every string unique while the sentences in front of it repeated, so one galaxy opened
 * all three of its star clouds with the same line and a reader stopped reading by the
 * fourth entry.
 */
function pickFresh(pool: readonly string[], rng: Rng, used: Set<string>): string {
  for (let attempt = 0; attempt < 32; attempt++) {
    const line = rng.pick(pool)
    if (!used.has(line)) {
      used.add(line)
      return line
    }
    if (used.size >= pool.length) break
  }
  return rng.pick(pool)
}

function landmarkName(kind: LandmarkKind, rng: Rng, usedFirst: Set<string>, usedSecond: Set<string>): string {
  const seconds = NAME_SECOND[kind]
  let first = ''
  let second = ''
  for (let attempt = 0; attempt < 48; attempt++) {
    first = rng.pick(NAME_FIRST)
    second = rng.pick(seconds)
    const firstFree = !usedFirst.has(first) || usedFirst.size >= NAME_FIRST.length
    const secondFree = !usedSecond.has(second) || usedSecond.size >= seconds.length
    if (firstFree && secondFree) break
  }
  usedFirst.add(first)
  usedSecond.add(second)
  return `the ${first} ${second}`
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
  if (form === 'nebula') return generateNebula(hostId, radiusMetres, nebulaKindHint(hostId))
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
  'IC443', 'NGC2736',
])

/**
 * The famous star-forming nebulae, which must never be called remnants.
 *
 * Protecting the remnants from being called nurseries and leaving the reverse unguarded
 * was half a fix. Orion, the Eagle and the Omega all rolled remnant, so the Eagle Nebula
 * was handed a neutron star and a shock front while the generator's "pillars resisting
 * them" branch sat unused next to it.
 *
 * This is the error that costs the most, and it is worth being precise about why. The
 * ILLUSTRATED badge covers an invented ARRANGEMENT. It does not cover an invented
 * IDENTITY: what kind of object M42 is was settled a century ago, and getting it wrong
 * is not imagination, it is a mistake.
 */
const KNOWN_NURSERIES = new Set([
  'NGC1976', 'NGC1982', 'IC4703', 'NGC6611', 'NGC6618', 'NGC6523', 'NGC6514', // Orion, Eagle, Omega, Lagoon, Trifid
  'NGC7000', 'IC1396', 'IC1805', 'IC1848', 'NGC2237', 'NGC2238', 'NGC2244', // North America, Elephant Trunk, Heart, Soul, Rosette
  'NGC3372', 'NGC6357', 'NGC6334', 'IC2944', 'NGC281', 'NGC1333', 'IC348', // Carina, War and Peace, Cat's Paw, Running Chicken, Pacman
  'NGC2024', 'IC434', 'B33', 'NGC7023', 'NGC1499', 'IC5070', 'NGC6820', // Flame, Horsehead, Iris, California, Pelican
  // A Wolf-Rayet wind bubble rather than a nursery or a remnant, but of the three
  // choices available here an emission nebula is the one that is not wrong.
  'NGC6888', // Crescent
])

function nebulaKindHint(hostId: string): boolean | undefined {
  const body = hostId.slice(hostId.indexOf(':') + 1).toUpperCase().replace(/\s|_/g, '')
  if (KNOWN_REMNANTS.has(body)) return true
  if (KNOWN_NURSERIES.has(body)) return false
  return undefined
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
  const usedFirst = new Set<string>()
  const usedSecond = new Set<string>()
  const usedLines = new Set<string>()
  const landmarks: GeneratedLandmark[] = []

  const add = (kind: LandmarkKind, x: number, y: number, z: number, radiusK: number, color: string, intensity: number) => {
    const name = landmarkName(kind, rng, usedFirst, usedSecond)
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
      description:
        `${LANDMARK_LABEL[kind]}. ${pickFresh(LANDMARK_LINES[kind], rng, usedLines)} ` +
        `${pickFresh(LANDMARK_DETAIL[kind], rng, usedLines)} ` +
        landmarkScale(kind, radiusK, Math.hypot(x, y, z)),
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
    // Capped in absolute terms, not as a fraction of the galaxy: scaled to a 14 kpc
    // disc the old range produced a supernova remnant 441 light years in radius, about
    // fifteen times the Crab.
    const remnantKpc = Math.min(radiusKpc * 0.02, rng.range(0.004, 0.016))
    add('remnant', r * Math.cos(theta), r * Math.sin(theta), rng.signed() * thicknessKpc, remnantKpc, '#7fd0c8', rng.range(0.4, 0.8))
  }
  if (discLike && rng.chance(0.6)) {
    const r = radiusKpc * rng.range(0.25, 0.85)
    const theta = rng.range(0, Math.PI * 2)
    add('void', r * Math.cos(theta), r * Math.sin(theta), rng.signed() * thicknessKpc * 0.5, radiusKpc * rng.range(0.03, 0.09), '#241c20', rng.range(0.5, 0.9))
  }

  // Enough that standing inside one is not standing in the dark. 30,000 points spread
  // through a 14 kpc disc puts almost nothing within a kiloparsec of wherever you are,
  // so arriving at a place inside the galaxy showed an empty sky with a few dots in it.
  const starCount = Math.round(50000 + radiusKpc * 2600)

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

  const usedFirst = new Set<string>()
  const usedSecond = new Set<string>()
  const usedLines = new Set<string>()
  const landmarks: GeneratedLandmark[] = []
  const add = (kind: LandmarkKind, x: number, y: number, z: number, r: number, color: string, intensity: number) => {
    const name = landmarkName(kind, rng, usedFirst, usedSecond)
    landmarks.push({
      id: `${hostId}/${name.replace(/^the /, '').toLowerCase().replace(/\s+/g, '-')}`,
      name, kind, x, y, z, radiusKpc: r, color, intensity,
      description:
        `${LANDMARK_LABEL[kind]}. ${pickFresh(LANDMARK_LINES[kind], rng, usedLines)} ` +
        `${pickFresh(LANDMARK_DETAIL[kind], rng, usedLines)} ` +
        landmarkScale(kind, r, Math.hypot(x, y, z)),
    })
  }

  // Remnants are rare in a nebula catalogue, and the ones people know are listed above.
  // A third of everything was far too many, and every one of them was a guess about an
  // identity rather than about an arrangement.
  const remnant = remnantHint ?? rng.chance(0.12)
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

  const usedFirst = new Set<string>()
  const usedSecond = new Set<string>()
  const usedLines = new Set<string>()
  const landmarks: GeneratedLandmark[] = []
  const count = 3 + Math.floor(rng.next() * 5)
  for (let i = 0; i < count; i++) {
    const r = radiusKpc * Math.pow(rng.next(), globular ? 1.6 : 0.8)
    const theta = rng.range(0, Math.PI * 2)
    const cosPhi = rng.range(-1, 1)
    const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi))
    const name = landmarkName('member', rng, usedFirst, usedSecond)
    landmarks.push({
      id: `${hostId}/${name.replace(/^the /, '').toLowerCase().replace(/\s+/g, '-')}`,
      name, kind: 'member',
      x: rotate(basis, r * sinPhi * Math.cos(theta), r * sinPhi * Math.sin(theta), r * cosPhi)[0],
      y: rotate(basis, r * sinPhi * Math.cos(theta), r * sinPhi * Math.sin(theta), r * cosPhi)[1],
      z: rotate(basis, r * sinPhi * Math.cos(theta), r * sinPhi * Math.sin(theta), r * cosPhi)[2],
      radiusKpc: radiusKpc * rng.range(0.03, 0.07),
      color: globular ? rng.pick(['#ffd0a0', '#ffc088', '#ffe0c0']) : rng.pick(['#cfe0ff', '#dde8ff', '#b8d0ff']),
      intensity: rng.range(0.6, 1),
      description:
        `${LANDMARK_LABEL.member}. ${pickFresh(LANDMARK_LINES.member, rng, usedLines)} ` +
        `${pickFresh(LANDMARK_DETAIL.member, rng, usedLines)} ` +
        landmarkScale('member', radiusKpc * 0.05, r),
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

/**
 * Both sentence pools, exposed so a test can check they are deeper than the number of
 * places that will draw from them. Picking without replacement is powerless against a
 * pool smaller than the draw.
 */
export const LANDMARK_POOLS: Record<string, readonly string[]> = Object.fromEntries(
  Object.keys(LANDMARK_LINES).flatMap((kind) => [
    [`${kind}:lines`, LANDMARK_LINES[kind as LandmarkKind]],
    [`${kind}:detail`, LANDMARK_DETAIL[kind as LandmarkKind]],
  ]),
)
