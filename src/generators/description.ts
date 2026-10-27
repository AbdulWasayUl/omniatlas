import { type Rng, hashSeed, rngFrom } from './random'
import type { WorldKind } from './system'

/**
 * A description of an invented world, different for every world.
 *
 * The kind descriptions this replaces were one sentence per kind, so every desert in the
 * atlas read identically and the two hundredth one told you nothing the first had not.
 * That is fine for a legend and useless for a place. A place needs something that is only
 * true of it.
 *
 * So the text is composed, from vocabularies that belong to the kind, against a seed
 * taken from the world's own id. Three parts: what the ground is like, what the sky over
 * it is like, and one thing about it that is not about either. Each part is drawn
 * separately, so the combinations run to tens of thousands per kind and a reader can
 * visit a hundred ice worlds before two of them say the same thing.
 *
 * Two rules the prose follows, both learned the hard way on this project. No em dashes:
 * they are the house style of machine writing and they make everything read the same.
 * And every sentence has to carry something concrete, a number or an object or a
 * direction, because the failure mode of generated description is a paragraph of mood
 * that could be about anywhere.
 *
 * Where a number IS known it is used rather than invented twice: the star's width in the
 * sky and the length of the year are computed from the same orbit the renderer draws, so
 * the prose and the picture cannot disagree.
 */

export interface WorldDescriptionInput {
  /** The world's own id, which seeds everything. */
  id: string
  kind: WorldKind
  /** Radius in metres. */
  radiusMetres: number
  /** Semi-major axis about its primary, metres. */
  semiMajorAxisMetres: number
  /** Orbital period in days. */
  periodDays: number
  /** Equilibrium temperature in kelvin, where the caller has one. */
  equilibriumK?: number
  /** Radius of the star this world ultimately orbits, metres. */
  starRadiusMetres: number
  /** Distance from that star, metres. For a moon this is its planet's. */
  starDistanceMetres: number
  /** How many moons it has. Zero for a moon. */
  moonCount: number
  hasRings: boolean
  habitable: boolean
  /** True when this is a moon rather than a planet. */
  isMoon: boolean
  /** What it orbits, for a moon: the planet's display name. */
  primaryName?: string
}

/** Ground, sky and one other thing, per kind. */
const GROUND: Record<WorldKind, readonly string[]> = {
  lava: [
    'The day side glows a dull red through its own smoke.',
    'Rock boils off the star-facing hemisphere and falls as mineral rain on the night side.',
    'Lava runs in channels wide enough to be seen from orbit, and they have never once gone cold.',
    'There is no solid ground on the lit face, only a crust that forms and founders on a sea of melt.',
    'The whole surface is a slag heap being turned over from underneath.',
    'Its mountains are built and unbuilt on a timescale of weeks.',
    'Iron falls as rain here, and collects in pools that glow brighter than the rock around them.',
  ],
  volcanic: [
    'Four hundred vents are erupting at any moment, and the plumes rise clear of the atmosphere.',
    'Sulphur paints the plains in yellows and oranges that change between one season and the next.',
    'Nothing on the surface is older than a million years. It resurfaces itself faster than craters can form.',
    'The ground flexes twice a day, and the heat of that flexing is what keeps it molten inside.',
    'Lakes of liquid sulphur sit in calderas forty kilometres across.',
    'It has no impact craters at all, which is the strangest thing about looking at it.',
  ],
  carbon: [
    'The crust is graphite, and under pressure, deeper down, it is something harder.',
    'Everything here is black. What light falls on it mostly does not come back.',
    'Tar seas lie in the lowlands, thick and slow and utterly still.',
    'Its mountains are carbide, and they ring when struck.',
    'Soot covers the plains to a depth of several metres, undisturbed.',
  ],
  iron: [
    'What is left is the core. Whatever rock it had was stripped away long ago.',
    'The surface is bare metal, pitted and dark, with the texture of something poured rather than built.',
    'It is small for its weight, and it holds a magnetic field far stronger than its size suggests.',
    'Nickel and iron, all the way down, with no mantle between the surface and the centre.',
  ],
  greenhouse: [
    'The cloud deck is unbroken, and nothing beneath it has been seen directly.',
    'Pressure at the surface would crush a submarine hull, and the air glows faintly from its own heat.',
    'It is hotter at the poles than most worlds are at the equator, because the atmosphere moves the heat too well.',
    'Sulphuric acid falls from the high cloud and evaporates before it ever reaches the ground.',
    'The surface is in permanent twilight, lit orange by an atmosphere that lets almost nothing through.',
  ],
  desert: [
    'Dunes run in parallel ridges for a thousand kilometres without a break.',
    'Whatever water it had is in the rock now, locked into clays that have not been wet in a billion years.',
    'Wind has cut the mesas into blades, all of them leaning the same way.',
    'Dust storms cover a third of the surface at a time and take months to settle.',
    'There are dry riverbeds, braided and unmistakable, with nothing in them.',
    'The rock is iron-stained and the horizon is close, which makes it feel smaller than it is.',
    'Salt flats fill the basins, white and cracked and flat to the limit of sight.',
  ],
  rocky: [
    'Bare silicate rock, cratered to saturation, with no air to soften the edges.',
    'The regolith is metres deep and has the consistency of flour.',
    'Its shadows are absolute. With no atmosphere to scatter light, the unlit side of a boulder is simply black.',
    'Ridges run for hundreds of kilometres where the whole world shrank as it cooled.',
    'Nothing has moved here since the last large impact, and that was a long time ago.',
    'The surface is grey, and in sunlight it is a brighter grey.',
  ],
  terrestrial: [
    'Green runs almost to the poles, and the coastlines are long and ragged.',
    'Three continents, none of them touching, and a belt of cloud that follows the equator the whole way round.',
    'There is weather. From orbit it is the most obvious thing about the place.',
    'Rivers reach the sea through deltas that shift measurably within a human lifetime.',
    'Forest covers the warm latitudes, and the colour of it changes with the seasons.',
    'Mountain chains run north to south on both major landmasses, and both are still rising.',
    'The shallow seas are a different blue from the deep ones, and the boundary is sharp.',
  ],
  ocean: [
    'There is no shore anywhere on it. Water runs unbroken from pole to pole.',
    'The only fixed landmarks are the storms, and they last for decades.',
    'Nothing here has ever been dry. The deepest water lies eleven kilometres down.',
    'Swell crosses the whole world without meeting anything, and arrives taller than it left.',
    'Ice caps float free at both poles, turning slowly, never grounding on anything.',
    'Its tides have nothing to break against, so they simply travel, all the way round, forever.',
  ],
  hycean: [
    'Warm ocean below, hydrogen above, and no sharp boundary between them anywhere.',
    'The sky is not blue here. It is a deep colourless depth that goes on until it is dark.',
    'Pressure increases so gradually that there is no sea level to speak of.',
    'The water is warm to a great depth, and it never freezes anywhere on the globe.',
  ],
  ice: [
    'Ice over everything, as hard as granite at this temperature and just as old.',
    'The surface is cut by ridges where the shell has flexed and refrozen, over and over.',
    'Methane frost whitens the lowlands each winter and sublimes away each spring.',
    'Impact craters here have the shape of ripples, because the ground relaxed after the strike.',
    'There is liquid water under the shell. The ridges are the only evidence for it from above.',
    'Nitrogen snow collects in the shadows of the ridges and never melts.',
    'The ice is dirty with the dust of everything that has ever landed on it.',
    'Long cracks run most of the way round, and they are not all old.',
    'It is bright where it is fresh and grey where it is not, in patches with hard edges.',
  ],
  snowball: [
    'White from pole to pole, bright enough to throw back most of the little light it gets.',
    'It is frozen so completely that the ice has flowed flat, and the horizon is a clean line.',
    'The albedo keeps it cold and the cold keeps the albedo. Nothing is going to break that.',
    'Frost grows on frost here, in crystals large enough to see from a standing height.',
    'Every surface is the same surface: ice, polished by nothing, for a very long time.',
    'What little light arrives mostly leaves again, which is the whole problem.',
    'There are no dark patches anywhere on it, at any season.',
    'Snow falls here, slowly, out of almost nothing.',
  ],
  superEarth: [
    'Gravity is half again what a visitor would expect, and the horizon sits further away than it should.',
    'Mountains here are low, because at this gravity nothing stands tall for long.',
    'The crust is thick and unbroken, a single plate with no seams anywhere.',
    'It is large enough to have kept its internal heat, and the volcanism shows it.',
    'Its atmosphere is dense and the sky is pale, washed out towards the horizon.',
  ],
  subNeptune: [
    'A rocky core, somewhere far below, under an envelope of hydrogen it never managed to shed.',
    'There is no surface to arrive at, only gas that thickens until it stops being gas.',
    'Haze layers lie flat and featureless, and they hide everything beneath them.',
    'It is the commonest kind of planet in the galaxy, and nothing remotely like it orbits the Sun.',
    'Its atmosphere is streaming away slowly into space, and has been for billions of years.',
  ],
  iceGiant: [
    'A deep mantle of water, ammonia and methane, around a core that is almost an afterthought.',
    'Methane in the upper air takes the red out of the sunlight and leaves the rest.',
    'The winds run faster than the planet turns, and nobody is certain what drives them.',
    'Its magnetic field is tilted hard away from its axis, and offset from the centre as well.',
    'Storms appear, last a few years, and are gone without leaving a mark.',
  ],
  gasGiant: [
    'Bands of cloud run east and west at different speeds, and the storms where they shear are older than any coastline.',
    'There is no surface anywhere beneath the cloud tops, just hydrogen growing steadily less like a gas.',
    'One storm has been turning in the same latitude for longer than anything has been watching it.',
    'Lightning in the deep cloud is visible from orbit on the night side.',
    'Its weather has no ground to drag on, so nothing it starts ever really stops.',
    'Helium rains out in the deep interior and falls towards a core nobody has seen.',
  ],
  hotJupiter: [
    'It is close enough to its star that the atmosphere is streaming away in a tail.',
    'One face has been turned to the star for its whole history, and the temperature difference across the terminator drives winds at thousands of kilometres an hour.',
    'The planet is puffed up well beyond its mass, inflated by heat it cannot get rid of.',
    'Iron and silicate condense on the night side and fall as rain that never reaches anywhere.',
    'Its year is shorter than many worlds take to turn once.',
  ],
}

const OTHER: Record<WorldKind, readonly string[]> = {
  lava: [
    'It is tidally locked, so the day side has never once cooled.',
    'The night side is cold enough to hold frost made of rock.',
    'Nothing about it is stable, and nothing about it changes.',
  ],
  volcanic: [
    'Its orbit is being pumped by the worlds either side of it, and that is where the heat comes from.',
    'A torus of its own escaped sulphur surrounds the planet it circles.',
    'It is the most geologically active body for a long way in any direction.',
  ],
  carbon: ['Diamond is a common rock here, and worth exactly as much as rock.', 'Its sunsets are the only colour it has.'],
  iron: [
    'Something took its mantle away, and no record of what survives.',
    'It rings, faintly, after a large impact, for days.',
    'Its magnetic field is far stronger than a world this size has any business having.',
    'What is left is the part that was always going to be hardest to remove.',
  ],
  greenhouse: [
    'It may have had oceans once. If it did, they are in the sky now.',
    'The surface and the upper cloud are two different worlds that happen to share a name.',
  ],
  desert: [
    'There is water at the poles, in the ground, and it has been there a long time.',
    'The sand is moving. Slowly, in one direction, across the whole face of the world.',
    'It was wetter once, and the shape of the land still says so.',
  ],
  rocky: [
    'It has no atmosphere worth the name, and nothing to lose.',
    'It is old, and it has been finished for a very long time.',
    'Nothing has moved on it since the last large impact.',
    'Its surface records every hit it has ever taken, in order.',
  ],
  terrestrial: [
    'If anything were ever going to happen anywhere, it would be somewhere like this.',
    'The atmosphere is in chemical disequilibrium, which is the kind of thing that is hard to explain without biology.',
    'Its axis is tilted enough to give it real seasons, and they are severe.',
  ],
  ocean: [
    'Whatever lives here, if anything does, has never had a reason to invent fire.',
    'Its weather is simple and enormous.',
    'There is more water on it than on every other world in the system together.',
  ],
  hycean: ['It is far larger than a rocky world and far lighter than it looks.', 'The ocean is warm all the way down, which should not be possible for long.'],
  ice: [
    'The shell is thinner at the equator, and that is where the ridges crowd together.',
    'Whatever ocean is under there has been sealed off since the world formed.',
    'It is geologically dead on the outside and possibly not on the inside.',
  ],
  snowball: ['It has been like this since shortly after it formed.', 'Sound would carry a long way here, if there were enough air to carry it.'],
  superEarth: [
    'A visitor would feel the weight of it in their knees within an hour.',
    'It holds its atmosphere easily, and always will.',
  ],
  subNeptune: ['Nobody has ever seen the bottom of one of these, anywhere.', 'It sits exactly in the size range that the galaxy prefers and this system does not explain.'],
  iceGiant: ['Its seasons last decades, and the whole atmosphere responds to them.', 'It is the coldest thing in the system that is not simply ice.'],
  gasGiant: [
    'It has more moons than most systems have planets.',
    'It is the heaviest thing here after the star, and everything else has had to arrange itself around that.',
    'Its own gravity is still squeezing it, and it radiates more heat than it receives.',
  ],
  hotJupiter: [
    'It will not last. On a long enough view it is falling into its star.',
    'It did not form here. Nothing could have.',
  ],
}

/** How the star looks from this world, composed around the computed angular size. */
function skySentence(input: WorldDescriptionInput, rng: Rng): string {
  const sunFromEarthDeg = 0.533
  const angularDeg = (2 * Math.asin(Math.min(1, input.starRadiusMetres / Math.max(input.starDistanceMetres, 1))) * 180) / Math.PI
  const ratio = angularDeg / sunFromEarthDeg
  if (ratio > 12) {
    return rng.pick([
      `Its star fills a quarter of the sky and does not set.`,
      `The star is ${Math.round(ratio)} times the width of the Sun seen from Earth, and it dominates everything.`,
      `There is no part of the day here when the star is not overwhelming.`,
    ])
  }
  if (ratio > 3) {
    return rng.pick([
      `Its star is ${ratio.toFixed(1)} times as wide as the Sun looks from Earth, and noticeably a disc rather than a point.`,
      `The star hangs large and close, and casts shadows with soft edges.`,
      `Sunrise here takes a long time, because the star is a big thing to clear the horizon.`,
    ])
  }
  if (ratio > 0.4) {
    return rng.pick([
      `Its star is about the size the Sun looks from Earth, give or take.`,
      `The light here would be familiar to anyone from Earth, though not quite the same colour.`,
      `Its star reads as a disc, roughly a half-degree across.`,
    ])
  }
  if (ratio > 0.08) {
    return rng.pick([
      `Its star is a small bright disc, a fraction of the width the Sun shows from Earth.`,
      `Noon here is dimmer than an overcast afternoon on Earth.`,
      `The star is distant enough that shadows have hard edges.`,
    ])
  }
  return rng.pick([
    `Its star is barely a disc at all from here, bright but tiny.`,
    `From this distance the star is a point of light that happens to be very bright.`,
    `Daylight here is a kind of dusk that never improves.`,
  ])
}

/**
 * The length of the year, and whatever else the world keeps around it.
 *
 * The year is returned separately and always used, because it is the one sentence
 * guaranteed to carry a number. Picking uniformly from the whole list let a description
 * come out as four sentences of mood with nothing measurable in it, which is exactly the
 * failure this kind of generated text falls into.
 */
function moonSentence(input: WorldDescriptionInput, rng: Rng): string | null {
  // Always stated when there are any, because leaving it to a random pick meant one
  // planet with a moon mentioned it and the next one did not.
  if (input.moonCount === 1) {
    return rng.pick(['It has one moon.', 'A single moon goes round it.', 'One moon, and nothing else.'])
  }
  if (input.moonCount > 1) {
    return rng.pick([
      `${input.moonCount} moons go round it, and they are never all full at once.`,
      `It holds ${input.moonCount} moons, the innermost close enough to show a disc.`,
      `There are ${input.moonCount} moons in its sky.`,
      `${input.moonCount} moons, and no two of them alike.`,
      `A family of ${input.moonCount} moons keeps it company.`,
    ])
  }
  return null
}

function orbitSentence(input: WorldDescriptionInput, rng: Rng): { year: string; moons: string | null; others: string[] } {
  const out: string[] = []
  const years = input.periodDays / 365.25
  let year = ''
  if (input.isMoon) {
    // A moon's period is the time it goes round its PLANET, which is a month. Calling it
    // a year gave one moon a 395-day year around a planet that takes 75 years to orbit.
    const around = input.primaryName ?? 'its planet'
    year =
      input.periodDays < 2
        ? `It goes round ${around} in ${(input.periodDays * 24).toFixed(0)} hours.`
        : input.periodDays < 400
          ? `It goes round ${around} once every ${input.periodDays.toFixed(input.periodDays < 30 ? 1 : 0)} days.`
          : `It goes round ${around} once every ${(input.periodDays / 365.25).toFixed(1)} years.`
  } else if (input.periodDays < 30) {
    year = `A year here lasts ${input.periodDays.toFixed(1)} days.`
  } else if (years < 2) {
    year = `Its year is ${Math.round(input.periodDays)} days long.`
  } else if (years < 400) {
    year = `One orbit takes ${years < 10 ? years.toFixed(1) : Math.round(years)} years.`
  } else {
    year = `It takes ${Math.round(years).toLocaleString('en-GB')} years to go round once.`
  }
  if (input.hasRings) {
    out.push(rng.pick([
      'It carries a ring system, thin and bright and tilted hard to its orbit.',
      'A ring runs round its equator, close in, made of whatever it pulled apart.',
    ]))
  }

  if (input.isMoon && input.primaryName) {
    out.push(rng.pick([
      `${input.primaryName} hangs fixed in its sky, always in the same place.`,
      `From the near side, ${input.primaryName} never moves from where it sits.`,
    ]))
  }
  return { year, moons: moonSentence(input, rng), others: out }
}

/**
 * Pick from a pool, preferring a line this system has not used yet.
 *
 * A planet with ten moons exhausts any per-kind pool, and when it does the repetition
 * lands exactly where it is most visible: three of one planet's moons opened with the
 * same sentence, and the inspector shows the opening first. The set is per SYSTEM, which
 * is the list a reader actually works through.
 */
function pickFresh(pool: readonly string[], rng: Rng, used?: Set<string>): string {
  if (!used) return rng.pick(pool)
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

/**
 * Two to five sentences about one world, the same every time for the same world.
 *
 * `used` is optional and carries the lines this system has already spent, so that a
 * system read top to bottom does not repeat itself. Passing nothing still gives a stable
 * description for that world on its own.
 */
export function describeWorld(input: WorldDescriptionInput, used?: Set<string>): string {
  const rng = rngFrom(hashSeed(`describe:${input.id}`))
  const parts: string[] = [pickFresh(GROUND[input.kind], rng, used), skySentence(input, rng)]

  const { year, moons, others } = orbitSentence(input, rng)
  parts.push(year)
  if (moons) parts.push(moons)
  // One more fact at most: a paragraph of statistics is not a description either.
  if (others.length && rng.chance(0.8)) parts.push(rng.pick(others))
  if (rng.chance(0.75)) parts.push(pickFresh(OTHER[input.kind], rng, used))
  if (input.habitable) {
    parts.push(rng.pick([
      'Liquid water could stand on its surface, which is rarer than it sounds.',
      'It sits in the narrow band where water is neither steam nor ice.',
      'Of everything in this system, this is the one somebody could walk on.',
    ]))
  }
  return parts.join(' ')
}
