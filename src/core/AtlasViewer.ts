import * as THREE from 'three'
import { Engine, type AtlasModule, type SceneNodeHandle } from './Engine'
import { AtlasControls } from './camera/AtlasControls'
import { LabelEngine } from './labels/LabelEngine'
import { PostStack } from './render/PostStack'
import { classStyle } from '../data/objectClasses'
import { AU_M, KPC_M, MPC_M, PC_M, type Vec3d, convertFrame, copy3d, distance3d, vec3d } from './world'
import type { LayerId } from './Layer'

/**
 * Owns the renderer, the engine, the camera controller and the animation loop.
 *
 * Deliberately framework-agnostic: React mounts it and reads from it, but never drives
 * a frame. The old architecture called the ephemeris three times a second from three
 * separate components and re-reconciled the entire R3F tree on every tick; here the
 * hot path touches no React state at all, and the chrome subscribes to a throttled
 * snapshot instead.
 */

/**
 * How far from the Sun a thing can be and still be in this galaxy, in metres.
 *
 * 50 kpc: past the disc, past the bulge, past the globular system, and inside the
 * Magellanic Clouds, which are companions rather than residents. The frames the atlas
 * uses differ from one another by rotation only, so a node's distance from the Sun is
 * the same number in all of them and no conversion is needed to ask this.
 */
const MILKY_WAY_REACH_M = 1.54e21

/**
 * A catalogue designation carried by a node id, normalised so two spellings of one
 * designation compare equal; null when the id carries none.
 *
 * `ungc:ngc5128` and `ngc:NGC5128` are one galaxy listed in two tables, and the tables
 * disagree about what to call it — "NGC 5128" against "Centaurus A". Leading zeros,
 * case and separators differ too, so the comparison is over the catalogue prefix and
 * the number alone.
 */
function designationKey(raw: string): string | null {
  const match = /^(NGC|IC|UGCA|UGC|PGC|DDO|ESO|MESSIER|M)[\s_-]*0*(\d+[A-Za-z]*(?:-\d+)?)$/i.exec(raw)
  if (!match) return null
  const prefix = match[1].toUpperCase()
  return `${prefix === 'M' ? 'MESSIER' : prefix}${match[2].toUpperCase()}`
}

/**
 * The designation an id carries, if any.
 *
 * A bare "M" is deliberately not read as a Messier number here: `bh:m87` is the black
 * hole at the centre of M87, not the galaxy, and merging the two would cost the atlas
 * one of them. A module that means the Messier number says so in `designations`, where
 * it is a statement rather than an inference from a naming convention.
 */
function idDesignationKey(id: string): string | null {
  const body = id.slice(id.indexOf(':') + 1)
  return /^m\d/i.test(body) ? null : designationKey(body)
}

/**
 * One label per object, which is not the same as one per registry entry.
 *
 * The nearby dwarf galaxies are in both the Local Group table and the Updated Nearby
 * Galaxy Catalog, two modules register them independently, and the Milky Way view came
 * out with "Segue 1", "Segue 3" and "Bootes I" each written twice a few pixels apart.
 * Both rows are real catalogue rows and both stay in the registry — search and the
 * inspector should still find either — but the sky gets one name per thing.
 *
 * Matched on direction AND on either the name or the catalogue designation. The name
 * alone was not enough: the Local Volume table and OpenNGC share 23 galaxies and
 * disagree about every one of their names, so NGC 5128 and "Centaurus A" were drawn as
 * two markers five per cent apart in range — close together from here, sliding apart
 * under parallax as the camera moved, and merging again as one of the two layers faded.
 * The designation is the identity the two tables DO agree on, and it is already in the
 * ids.
 *
 * The designation does not replace the name, it joins it, because the two catch
 * different things and neither catches both. OpenNGC lists the Eagle Nebula twice on
 * purpose, as IC 4703 and NGC 6611 — two designations, one name, one object. The
 * Antennae are the mirror image: one name over two designations and two galaxies, which
 * the deep-sky module separates by giving them distinguishable names before they ever
 * reach this function.
 *
 * Directions are compared in ONE frame: the modules state their positions in different
 * ones, so comparing raw components compares a galactic direction with an equatorial
 * one and never matches. The survivor is the row with the catalogued size, which is the
 * one that can be drawn rather than merely marked; the tie-break is the id, so the
 * choice does not depend on which module finished loading first.
 */
export function oneLabelPerObject(nodes: Iterable<SceneNodeHandle>): SceneNodeHandle[] {
  // Direction first, then identity within the direction, because two keys that may each
  // merge a pair cannot both be a Map key at once.
  const buckets = new Map<string, SceneNodeHandle[]>()
  const scratch = vec3d()
  for (const node of nodes) {
    convertFrame(scratch, node.worldPosition, node.frame, 'icrf')
    const r = Math.hypot(scratch.x, scratch.y, scratch.z) || 1
    // ~0.6 degrees of sky, quantised: close enough that two labels would collide.
    const key = `${Math.round(scratch.x / r / 0.01)}|${Math.round(scratch.y / r / 0.01)}|${Math.round(
      scratch.z / r / 0.01,
    )}`
    const held = buckets.get(key)
    if (held) held.push(node)
    else buckets.set(key, [node])
  }

  const out: SceneNodeHandle[] = []
  for (const members of buckets.values()) {
    if (members.length === 1) {
      out.push(members[0])
      continue
    }
    // Union-find over the bucket: a node joins a group if it shares EITHER key with
    // something already in it, so name and designation can chain through one another.
    const parent = members.map((_, i) => i)
    const find = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]]
      return i
    }
    const union = (a: number, b: number) => {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent[rb] = ra
    }
    const first = new Map<string, number>()
    for (let i = 0; i < members.length; i++) {
      const designations = [idDesignationKey(members[i].id), ...(members[i].designations ?? []).map(designationKey)]
      for (const key of [
        `n:${members[i].name.trim().toLowerCase()}`,
        ...designations.map((d) => d && `d:${d}`),
      ]) {
        if (!key) continue
        const seen = first.get(key)
        if (seen === undefined) first.set(key, i)
        else union(seen, i)
      }
    }

    const best = new Map<number, SceneNodeHandle>()
    for (let i = 0; i < members.length; i++) {
      const root = find(i)
      const held = best.get(root)
      const node = members[i]
      if (
        !held ||
        node.radiusMetres > held.radiusMetres ||
        (node.radiusMetres === held.radiusMetres && node.id < held.id)
      ) {
        best.set(root, node)
      }
    }
    out.push(...best.values())
  }
  return out
}

/** Solar-system layers; everything a node in one of these draws orbits the Sun. */
const SOLAR_LAYERS = new Set(['surface', 'system', 'helio'])

/**
 * The outermost structure an object's address starts from.
 *
 * Deliberately coarse, and never a guess: the layer settles the solar system, and
 * everything else is settled by how far away the thing actually is. The breadcrumb
 * used to push "Solar System" onto every address in the atlas, which put TON 618
 * inside it; rooting by layer alone then put M87* — drawn in the galactic layer
 * because of its apparent size, not its address — inside the Milky Way. Distance
 * from the Sun is a measurement the registry already holds, and it answers the
 * question directly.
 */
function addressRoot(node: SceneNodeHandle | null): { id: string; name: string } {
  if (!node) return { id: 'observable-universe', name: 'Observable Universe' }
  if (SOLAR_LAYERS.has(node.layer)) return { id: 'solar-system', name: 'Solar System' }
  const r = Math.hypot(node.worldPosition.x, node.worldPosition.y, node.worldPosition.z)
  return r < MILKY_WAY_REACH_M
    ? { id: 'milky-way', name: 'Milky Way' }
    : { id: 'observable-universe', name: 'Observable Universe' }
}

/** The widest instant `new Date` can represent, in milliseconds either side of 1970. */
const MAX_EPOCH_MS = 8.64e15

export interface ViewerSnapshot {
  anchorId: string | null
  anchorName: string
  /** Camera distance to the anchor's centre, metres. */
  distanceMetres: number
  /** Camera altitude above the anchor's surface, metres. */
  altitudeMetres: number
  /** Width of the viewport at the anchor distance, metres. */
  viewSpanMetres: number
  epochMs: number
  fps: number
  drawCalls: number
  /** Objects currently in the engine registry. */
  registered: number
  activeLayers: string[]
  /** Containment chain from the outermost structure down to the anchor. */
  addressPath: { id: string; name: string }[]
  /** True when the time rate is spinning a visible body faster than the frame rate can show. */
  rotationAliased: boolean
  /** True when the clock is the real one: see `AtlasViewer.trackingNow`. */
  trackingNow: boolean
}

export interface AtlasViewerOptions {
  canvas: HTMLCanvasElement
  /** The 2D overlay the label engine draws into. */
  labelCanvas: HTMLCanvasElement
  /** Called when the user clicks an object, or empty space (null). */
  onSelect?: (id: string | null) => void
  /** Modules to load, in no particular order; failures are isolated. */
  modules: { id: string; load: () => Promise<AtlasModule> }[]
  onSnapshot?: (snapshot: ViewerSnapshot) => void
  onReady?: () => void
}

/**
 * Arrival distance, in radii of the object being visited.
 *
 * 4.2 frames a solid body well: the disc fills a comfortable share of the frame with
 * room around it. A black hole's radius is its Schwarzschild radius, which is not
 * what it looks like — the shadow is 2.6 times larger, and the accretion disc that
 * makes it visible at all runs out past 13. Arriving at 4.2 r_s puts the camera
 * inside the disc, facing a black wall.
 */
function arrivalRadii(objectClass: string): number {
  return objectClass === 'black-hole' ? 34 : 4.2
}

/**
 * View span, in metres, to frame an object whose catalogue records no size — one entry
 * per layer, because the layer a node is drawn in is the only statement the catalogue
 * makes about the scale of the thing.
 *
 * `radiusMetres: 0` means "no size was recorded", not "this thing is a point", and 100
 * of the 2,132 registered destinations were in that state before the catalogues began
 * stating `framingRadiusMetres`. The flat 1e9 m arrival distance that covered all of
 * them is a solar-system number: flying to 'The Sun'
 * (the galactic catalogue's own marker for where we sit in the disc, registered as a
 * point because its photosphere is 2e-8 kpc across) parked the camera at 1.44 solar
 * radii and filled the frame with orange, and the Virgo Cluster — 16 Mpc away, in the
 * cosmic layer — parked at the same 1e9 m, which is five hundred million times closer
 * than the thing it was pointed at and renders as nothing at all.
 *
 * A span is the right quantity to pick rather than a distance, because it is what the
 * layer bands and the scale ladder are stated in: 40 layer units across the frame puts
 * the view a comfortable margin above the layer's SPAN floor, so the span band is not
 * what switches the node's own layer off. Note the limit of that claim, which this
 * comment used to overstate. A layer has two gates, and an arrival span only moves one
 * of them: the DISTANCE band asks how far the camera ends up from the layer's own
 * origin, and no choice of arrival distance can answer it for a node that sits outside
 * its layer's band to begin with — flying to a deep-sky object registered in the
 * stellar layer but projected onto the 100 kpc shell lands 1.57 kpc from the glyph and
 * 100 kpc from the ICRF origin, three decades outside `stellar`'s [0, 3 kpc] band, and
 * the arrival is black whatever span is asked for. That is a routing problem for the
 * catalogue — the node belongs in the layer whose band contains its distance — not
 * something an arrival distance can fix.
 *
 * Note also what this is NOT: a size for the object. Nothing here is written back into
 * `radiusMetres`, so the inspector keeps reporting the catalogue's silence and no
 * apparent-size fade is computed from it.
 *
 * Reach, as of the current catalogues: exactly one registered node has neither a radius
 * nor a `framingRadiusMetres`, and it is 'sun-galactic' — so `galactic` is the only
 * entry that is read today (measured: arrives 25 kpc out with the whole disc framed).
 * The rest are untested fallbacks, kept so the lookup is total: a catalogue that later
 * registers a sizeless node in its layer gets a span of the right order rather than an
 * `undefined` distance, and the number it gets should be re-measured then.
 */
const POINT_ARRIVAL_SPAN_M: Record<LayerId, number> = {
  // 40 Mpc: a CF4 group framed against the supercluster it belongs to.
  cosmic: 40 * MPC_M,
  // 40 kpc: the whole Milky Way disc, which is what a galactic-frame marker is for.
  galactic: 40 * KPC_M,
  // 40 pc: the solar neighbourhood around a star whose radius nobody recorded.
  stellar: 40 * PC_M,
  // 2 kpc: a landmark inside an invented galaxy, framed against the arm it sits in.
  galaxyInterior: 2 * KPC_M,
  // Unchanged, deliberately: the 34 comets with no measured nucleus are helio nodes,
  // and ~1e9 m is the distance their orbit neighbourhood reads at.
  helio: 1.7e9,
  // An invented world always carries a radius, so this is unreachable today and is here
  // only to keep the lookup total.
  imagined: 1.7e9,
  system: 1.7e9,
  surface: 1.7e9,
}

/**
 * How far from the Sun "arrive on the lit side" still means anything, in metres.
 *
 * Roughly 6,700 AU — past the scattered disc, well inside the Oort cloud. Out to there
 * the Sun is the only illumination worth framing against and a solid body has a day
 * side to point at. Beyond it there is no lit side to arrive on.
 */
const SUNLIT_REACH_M = 1e15

/**
 * The orbit pose to arrive on when the destination sits at the frame origin and there
 * is no direction to aim at. AtlasControls' own initial yaw and pitch, so the opening
 * view of the atlas — which is a flight to the Sun — is unchanged.
 */
const ORIGIN_ARRIVAL_YAW = 0.6
const ORIGIN_ARRIVAL_PITCH = 0.32

/** How often the UI snapshot is published, in milliseconds. */
const SNAPSHOT_INTERVAL_MS = 100

export class AtlasViewer {
  readonly renderer: THREE.WebGLRenderer
  readonly engine: Engine
  readonly controls: AtlasControls
  readonly labels: LabelEngine
  readonly post: PostStack

  /** Simulated instant being drawn. */
  epochMs = Date.now()
  /** Simulated seconds per real second. 1 is live; 0 is paused. */
  timeRate = 1
  paused = false

  private readonly canvas: HTMLCanvasElement
  private readonly onSnapshot?: (snapshot: ViewerSnapshot) => void
  /**
   * Anchor identity lives here, with the thing that decides it.
   *
   * It used to live in two places that disagreed for the length of every flight.
   * `focus` told the engine to re-anchor, and then the loop overwrote the engine's
   * anchor with the CONTROLLER's — which only adopts the destination when the flight
   * ends — so for the whole flight the near layers stayed re-originned on the object
   * being left behind, and the engine's anchor flipped under the user on arrival. The
   * controller's `anchorId` is its own business: what it is orbiting right now,
   * mid-interpolation. What the atlas is focused on is this.
   */
  private currentAnchorId: string | null = null
  private rafHandle = 0
  private lastFrameTime = 0
  private lastSnapshotTime = 0
  private elapsed = 0
  private lastViewSpanMetres = 1
  private frameAccumulator = 0
  private frameCount = 0
  private fps = 0
  private disposed = false
  private readonly scratchWorld: Vec3d = vec3d()
  private readonly resizeObserver: ResizeObserver
  private readonly onSelect?: (id: string | null) => void
  private hits: { id: string; x: number; y: number; r: number; touch: boolean }[] = []
  private pointerDownAt = { x: 0, y: 0, time: 0 }

  constructor(options: AtlasViewerOptions) {
    this.canvas = options.canvas
    this.onSnapshot = options.onSnapshot
    this.onSelect = options.onSelect

    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      // See the note in Layer.ts: layering solves position precision, this solves the
      // in-layer depth range that a planet-plus-moons pass genuinely needs.
      logarithmicDepthBuffer: true,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    // Tone mapping is applied once, by PostStack's composite pass, after bloom. Leaving
    // it on here would crush the above-1.0 values the glow is computed from.
    this.renderer.toneMapping = THREE.AgXToneMapping
    this.renderer.toneMappingExposure = 1.0
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    // Pure black, and it has to be pure. Space is the floor under every star field in
    // the atlas, and AgX lifts whatever sits there: 0x05070a — a colour chosen to read
    // as "very dark blue" in a swatch — came out of the tone curve at rgb(42,49,59), a
    // flat slate grey behind everything, which is what made the whole atlas look foggy
    // and low-contrast. Any non-zero clear colour becomes a fog floor; the post stack
    // owns the tone curve, the viewer owns only this.
    this.renderer.setClearColor(0x000000, 1)

    this.engine = new Engine({ renderer: this.renderer })
    this.controls = new AtlasControls({ domElement: options.canvas, frame: 'ecliptic' })
    this.controls.setDistance(6 * AU_M)
    this.labels = new LabelEngine(options.labelCanvas)
    // Threshold well above 1.0 on purpose. With tens of thousands of additive star
    // sprites in frame, a threshold at unity lets the faint majority into the mip
    // chain, and the blur smears them into a uniform haze that reads as light
    // pollution. Lifting the bar means only genuinely bright objects bloom, which is
    // both prettier and closer to what an eye adapted to the dark actually sees.
    this.post = new PostStack(this.renderer, { threshold: 1.9, intensity: 0.55, vignette: 0.42, grain: 0.005 })

    // Selection is a click, not a drag that happened to end on an object.
    options.canvas.addEventListener('pointerdown', this.handlePointerDown)
    options.canvas.addEventListener('pointerup', this.handlePointerUp)
    options.canvas.addEventListener('dblclick', this.handleDoubleClick)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(options.canvas)
    this.resize()

    void this.boot(options)
  }

  private async boot(options: AtlasViewerOptions): Promise<void> {
    if (this.disposed) return
    await this.engine.loadModules(options.modules)
    if (this.disposed) return
    this.refreshLabels()
    // Open on the inner solar system: close enough that the planets are distinct,
    // wide enough that the product's subject is immediately legible.
    //
    // Unless something already chose a destination. The registry fills before boot
    // finishes, so a click in that window ordered a real flight — and this call,
    // being instant, routes through `endFlight(false)`, which cancelled it and
    // snapped back to the Sun with no error and no explanation.
    if (!this.currentAnchorId) this.focus('sun', { instant: true, distanceMetres: 3.4 * AU_M })
    options.onReady?.()
    this.start()
  }

  /** Rebuild the label set from the registry. Call after modules add objects. */
  /** Last registry version the label set was built from. */
  private labelledVersion = -1

  refreshLabels(): void {
    this.labelledVersion = this.engine.registryVersion
    this.labels.setItems(
      oneLabelPerObject(this.engine.registry.values()).map((node) => ({
        node,
        priority: classStyle(node.objectClass).priority,
      })),
    )
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  /**
   * Fly to an object and anchor on it.
   *
   * The arrival distance is framed from the object's own size, so a crater and a
   * supercluster both end up filling a comparable fraction of the screen.
   */
  focus(id: string, options: { instant?: boolean; distanceMetres?: number } = {}): void {
    const node = this.engine.node(id)
    if (!node) return
    // A catalogue that knows no radius may still state a size to frame against; see
    // `framingRadiusMetres`. A node with neither — 'sun-galactic' is the last one in
    // the registry — falls back to the span its layer is built for.
    const framingRadius = node.radiusMetres > 0 ? node.radiusMetres : (node.framingRadiusMetres ?? 0)
    const distance =
      options.distanceMetres ??
      (framingRadius > 0
        ? framingRadius * arrivalRadii(node.objectClass)
        : this.distanceForSpan(POINT_ARRIVAL_SPAN_M[node.layer]))

    this.orientArrival(node)

    this.controls.flyTo(
      {
        anchorWorld: node.worldPosition,
        frame: node.frame,
        radiusMetres: node.radiusMetres,
        shapeRatio: node.shapeRatio,
        distanceMetres: distance,
        anchorId: id,
      },
      { instant: options.instant },
    )
    this.currentAnchorId = id
    this.engine.setAnchor(id)
  }

  /**
   * Choose the direction the camera arrives from.
   *
   * Both cases put the camera between the origin and the object, which is the same
   * arithmetic for two different reasons, so the one block covers both.
   *
   * Inside the solar system that is the LIT side: a body's day side is where the
   * surface detail is, and arriving at a black disc is both ugly and uninformative.
   * The Sun sits at the origin of the heliocentric frame, so the sunward direction
   * from any body is the negated normalised position. Offsetting by about 28 degrees
   * keeps a crescent of night in frame, so the terminator still reads and the globe
   * still looks like a sphere rather than a flat lit disc.
   *
   * Outside it there is no lit side, and the offset would only swing the camera off
   * the approach for no reason — a star or a galaxy is not illuminated by our Sun and
   * has no terminator to show. What is still true is that we come at it from our side
   * of the sky, so it is framed against the far sky rather than flown past.
   *
   * The conversion is the other half of the fix: yaw and pitch are angles in the
   * CONTROLLER's frame, and this block used to take them straight off `worldPosition`
   * whatever frame that was stated in. For an ICRF star that is wrong by the
   * obliquity, and for a supergalactic-frame galaxy it is wrong by about 60 degrees.
   */
  /**
   * The star that lights this body: the nearest ancestor that is one.
   *
   * For everything in the solar system this is the Sun, which sits at the origin of
   * every frame the atlas uses, so the arithmetic below is unchanged by it. It matters
   * for a body somewhere else — an invented world around another star is lit by THAT
   * star, and measuring its day side from the Sun eighty-eight light years away gives an
   * angle with no relation to where its light comes from.
   */
  private illuminator(node: SceneNodeHandle): SceneNodeHandle | null {
    let current: SceneNodeHandle | null = node
    const seen = new Set<string>([node.id])
    for (let hops = 0; hops < 8 && current; hops++) {
      const parent = this.engine.node(current.parentId)
      if (!parent || seen.has(parent.id)) return null
      if (parent.objectClass === 'star') return parent
      seen.add(parent.id)
      current = parent
    }
    return null
  }

  private readonly scratchArrival = vec3d()

  private orientArrival(node: SceneNodeHandle): void {
    convertFrame(this.scratchWorld, node.worldPosition, node.frame, this.controls.frame)
    // Measured FROM the star that lights this body, not from the frame's origin. The two
    // are the same vector for anything orbiting the Sun, which is why this changes
    // nothing about arriving at Europa; they are nothing like each other for a world
    // around another star, which used to be approached at whatever phase the geometry
    // between here and there happened to produce. Measured at Sabik d: a phase angle of
    // 162 degrees, 2 per cent of the disc lit, which reads on screen as having flown to
    // a planet that is not there.
    const star = this.illuminator(node)
    if (star) {
      convertFrame(this.scratchArrival, star.worldPosition, star.frame, this.controls.frame)
      this.scratchWorld.x -= this.scratchArrival.x
      this.scratchWorld.y -= this.scratchArrival.y
      this.scratchWorld.z -= this.scratchArrival.z
    }
    const { x, y, z } = this.scratchWorld
    const length = Math.hypot(x, y, z)
    // The Sun itself, and the galactic catalogue's copy of it, sit at the origin of
    // the controller's frame: there is no direction to derive, so a FIXED pose is
    // used. Inheriting whatever pose the camera happened to hold is the obvious
    // alternative and it leaks the previous destination into the new view — arriving
    // at the Sun from Earth gave yaw -2.2468, and arriving at it again six simulated
    // months later gave yaw +0.9152, for the same two bodies in the same relation.
    // The pose below is the controller's own opening pose, so the atlas still opens on
    // the view it always did.
    if (length === 0) {
      this.controls.setOrbit(ORIGIN_ARRIVAL_YAW, ORIGIN_ARRIVAL_PITCH)
      return
    }

    const yaw = Math.atan2(-y, -x)
    const pitch = Math.asin(Math.min(Math.max(-z / length, -1), 1))
    const sunlit = node.radiusMetres > 0 && length < SUNLIT_REACH_M
    if (sunlit) this.controls.setOrbit(yaw + 0.49, pitch + 0.22)
    else this.controls.setOrbit(yaw, pitch)
  }

  /** Pause or resume the simulation clock. */
  setPaused(paused: boolean): void {
    this.paused = paused
    // Rate 0 is the ladder's way of spelling "stopped" and it sets both fields, so
    // resuming has to undo both: flipping the boolean alone left {rate 0, paused
    // false}, a clock that is still frozen with nothing on screen acknowledging the
    // keypress. The space bar is never a no-op.
    if (!paused && this.timeRate === 0) this.timeRate = 1
  }

  /** Set simulated seconds per real second. Zero pauses. */
  setTimeRate(rate: number): void {
    this.timeRate = rate
    this.paused = rate === 0
  }

  /**
   * Is the clock showing the present?
   *
   * Not the same question as "is the rate 1x", which is what the footer's live dot
   * and the URL writer both used to ask. Run the clock at a year a second for six
   * seconds and step the ladder back to Real time and the rate is 1 again while the
   * epoch is five years out: the dot lit green beside a date in 2031, and the URL
   * dropped `t=` altogether, so the link the app wrote for its own view reopened in
   * the present. Comparing the two clocks answers it directly and needs no state.
   *
   * The tolerance is one frame of slack at 1x plus a margin: the simulated clock is
   * integrated from `delta`, which is clamped, so it drifts from the wall clock by a
   * few milliseconds per slow frame even while it is faithfully tracking real time.
   */
  get trackingNow(): boolean {
    return !this.paused && this.timeRate === 1 && Math.abs(this.epochMs - Date.now()) < 2000
  }

  /** Snap the clock back to the real current instant and run at real time. */
  resumeLive(): void {
    this.epochMs = Date.now()
    this.timeRate = 1
    this.paused = false
  }

  /** Jump the camera to a given view span without changing the anchor. */
  setViewSpanMetres(span: number): void {
    this.controls.setDistance(this.distanceForSpan(span))
  }

  /** Anchor distance at which the viewport is `span` metres wide. */
  private distanceForSpan(span: number): number {
    return span / this.spanPerMetre()
  }

  /** Metres the viewport spans at `distance`. The inverse of `distanceForSpan`. */
  private spanForDistance(distance: number): number {
    return distance * this.spanPerMetre()
  }

  /** Viewport width in metres per metre of anchor distance. */
  private spanPerMetre(): number {
    return 2 * Math.tan((this.engine.fovDegrees * Math.PI) / 360) * this.aspect()
  }

  private aspect(): number {
    return Math.max(this.canvas.clientWidth, 1) / Math.max(this.canvas.clientHeight, 1)
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  start(): void {
    if (this.rafHandle) return
    this.lastFrameTime = performance.now()
    const tick = (now: number) => {
      this.rafHandle = requestAnimationFrame(tick)
      this.frame(now)
    }
    this.rafHandle = requestAnimationFrame(tick)
  }

  stop(): void {
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle)
    this.rafHandle = 0
  }

  private frame(now: number): void {
    // Clamp delta so a backgrounded tab does not resume by integrating a 30-second
    // step through every orbit in the system.
    const rawDelta = (now - this.lastFrameTime) / 1000
    const delta = Math.min(rawDelta, 0.1)
    this.lastFrameTime = now

    if (!this.paused) this.epochMs += delta * 1000 * this.timeRate
    // A clamped frame is real time the simulated clock did not get, so a clock that
    // was showing the present no longer is — background the tab for a minute and it
    // comes back a minute behind, which turns the live dot off and starts writing a
    // `t=` the user never asked for. Put it back on the wall clock, but only if it
    // was already there: a clock deliberately left in 2031 has to stay in 2031.
    if (this.clockWasLive && rawDelta > 0.1 && !this.paused && this.timeRate === 1) {
      this.epochMs = Date.now()
    }
    this.clockWasLive = this.trackingNow
    // The clock is user-driven and has no upper stop, and a few hours at a year a
    // second walks it past the 8.64e15 ms that `new Date` can represent — after
    // which every `toISOString` in the UI throws, taking the address-bar sync out
    // silently and the Inspector's React tree out loudly. Clamp it where it is
    // written, once, instead of guarding each reader.
    this.epochMs = Math.min(Math.max(this.epochMs, -MAX_EPOCH_MS), MAX_EPOCH_MS)

    // The order of the next four steps is the frame, and it is load-bearing.
    //
    // It used to run controller, tracker, modules — so the camera was built from an
    // anchor position written on the previous frame, and then the modules moved that
    // body again before it was drawn. The camera lagged the scene by two frames, which
    // is nothing at live rate and catastrophic at any other: the error is two times the
    // anchor's orbital speed times the simulated seconds per frame, so it grows
    // linearly with the time rate. At a month per second the camera-to-Jupiter distance
    // was 330% over the anchor distance it was supposed to be holding, and Earth sat 77
    // degrees off an optical axis with a 39-degree horizontal half-FOV — the planet you
    // had just flown to was simply not on screen.
    //
    // 0. a flight that has ended may not have ended where it was aimed.
    //
    // Interrupt one with the wheel or a drag and `endFlight` commits to whichever
    // endpoint the camera is actually beside, which for an early interrupt is the
    // body you left. `currentAnchorId` was moved to the destination the moment the
    // flight was ordered and nothing moved it back, so the tracker below used to drag
    // the camera to the destination on the next frame regardless — measured at
    // 1.7e26 m on an interrupted Earth -> M87*, a black screen with no way back. The
    // controller decides where the camera ended up; everything else follows it. This
    // runs before the modules so no frame is ever built against the stale id.
    if (!this.controls.flying && this.controls.anchorId !== this.currentAnchorId) {
      this.currentAnchorId = this.controls.anchorId
      this.engine.setAnchor(this.currentAnchorId)
      this.onSelect?.(this.currentAnchorId)
    }

    // 1. modules move every body to this epoch, knowing nothing of the camera;
    this.engine.anchorId = this.currentAnchorId
    // Transit state is published BEFORE the modules run, not only before `draw`.
    // `update` is where a module builds and tears down a close-range stand-in, and on
    // the frame a flight is ordered it used to be handed `anchorId` already moved to
    // the destination with `inTransit` still false — a pair that is wrong in both
    // halves and reads as "we have arrived". Measured: the proxy for M87* was torn
    // down on exactly that frame and the black hole filling the screen was replaced
    // by empty sky. The orbit point used here is the controller's pre-update one,
    // which at t=0 of a flight is the departure body itself, so it is also the right
    // geometry for this half of the frame.
    this.syncTransitAnchor()
    this.engine.advance(this.epochMs, delta)

    // The module that owns a body's rotation is the only code that knows its period, so
    // it decides whether this frame's step has outrun the spin; the viewer only relays
    // the verdict to the UI. Any module may raise it, so this is an OR, not an assign.
    this.rotationAliased = this.engine.modules.some(
      (module) => (module as { rotationAliased?: boolean }).rotationAliased === true,
    )

    // 2. the controller's anchor is re-glued to where its body now is;
    //
    // Never during a flight. The controller owns its orbit point then — it is
    // interpolating one between the departure body and the destination — and writing
    // the DESTINATION's position and radius into it on the first frame of the flight
    // clamps the altitude floor against a body that is still light years away: Earth
    // to the Sun took `anchorRadiusMetres` to 6.96e8 m while the camera was still
    // 2.7e7 m from Earth.
    if (!this.controls.flying) {
      const anchor = this.engine.node(this.currentAnchorId)
      if (anchor) {
        copy3d(this.scratchWorld, anchor.worldPosition)
        this.controls.trackAnchor(this.scratchWorld, anchor.frame)
        this.controls.anchorRadiusMetres = anchor.radiusMetres
        // Without this the floor reverts to the mean radius one frame after arrival
        // and the wheel walks the camera back inside an oblate planet.
        this.controls.anchorShapeRatio = anchor.shapeRatio ?? 1
      }
    }

    // 3. the controller rebuilds the camera pose around that anchor;
    this.controls.update(delta)

    // Geometry is measured from the point the camera is ACTUALLY orbiting, which for
    // the length of a flight is neither endpoint. Handing the engine the destination
    // instead measured the anchor distance 1.7e26 m out while the camera was in the
    // inner solar system, which switched every band off and left the middle of every
    // intergalactic flight black. Identity still belongs to the destination, so
    // `anchorId` is untouched; see Engine.transitAnchorWorld.
    // ... and again, now with the orbit point the controller has just interpolated,
    // which is the one `draw` measures and re-origins against.
    this.syncTransitAnchor()

    copy3d(this.engine.cameraWorld, this.controls.cameraWorld)
    this.engine.cameraFrame = this.controls.frame
    this.engine.cameraQuaternion.copy(this.controls.quaternion)

    this.lastViewSpanMetres = this.spanForDistance(this.controls.distanceMetres)

    // 4. and only now is anything measured against the anchor and the camera together.
    this.engine.renderTarget = this.post.sceneTarget
    // A module may have registered or unregistered nodes during `advance`. Rebuild the
    // label set before drawing when it has, so a node that appears mid-session gets a
    // marker on the frame it appears -- and with it a pick target, which is the only
    // way anything in this atlas can be clicked.
    if (this.engine.registryVersion !== this.labelledVersion) this.refreshLabels()

    this.engine.draw()
    this.elapsed += delta
    this.post.render(this.elapsed)
    this.labels.selectedId = this.selectedId
    this.labels.anchorId = this.currentAnchorId
    this.hits = this.labels.render(this.engine, this.lastViewSpanMetres).hits

    this.frameAccumulator += delta
    this.frameCount += 1
    if (this.frameAccumulator >= 0.5) {
      this.fps = this.frameCount / this.frameAccumulator
      this.frameAccumulator = 0
      this.frameCount = 0
    }

    if (now - this.lastSnapshotTime >= SNAPSHOT_INTERVAL_MS) {
      this.lastSnapshotTime = now
      this.publish()
    }
  }

  /**
   * Hand the engine the point the camera is actually orbiting, and the body it is
   * leaving, for as long as a flight is in progress.
   *
   * Geometry is measured from that point and from neither endpoint. Handing the engine
   * the destination instead measured the anchor distance 1.7e26 m out while the camera
   * was in the inner solar system, which switched every band off and left the middle
   * of every intergalactic flight black. Identity still belongs to the destination, so
   * `anchorId` is untouched; see `Engine.transitAnchorWorld` and
   * `FrameContext.transitFromId`. The controller's own `anchorId` is the departure
   * body: it adopts the destination only when the flight lands.
   */
  private syncTransitAnchor(): void {
    this.engine.setTransitAnchor(
      this.controls.flying ? this.controls.anchorWorld : null,
      this.controls.frame,
      this.controls.anchorId,
    )
  }

  private publish(): void {
    if (!this.onSnapshot) return
    // The name and the distance have to describe the SAME object, and during a flight
    // `currentAnchorId` is where the camera is going, not where it is. Pairing the
    // destination's name with the controller's distance made the HUD read "0.000 m
    // above M87*" ten frames into an Earth → M87 flight, with the camera still inside
    // the orbit of Mars, and "1.22e21 m above M87*" twenty frames later when the true
    // distance was 5.17e23 m. So the HUD reports where the camera IS; the destination
    // takes over at the crossover, which is where it starts being the nearer truth.
    const anchor = this.controls.flying ? this.nearerEndpoint() : this.engine.node(this.currentAnchorId)
    // Measured camera-to-body, not `controls.distanceMetres`: in transit the controller
    // measures against an interpolated point in empty space that no node names, so the
    // two diverge by most of the trip.
    const distanceMetres = anchor ? this.distanceToNode(anchor) : this.controls.distanceMetres
    const stats = this.engine.stats()

    this.onSnapshot({
      anchorId: anchor?.id ?? null,
      anchorName: anchor?.name ?? 'Space',
      distanceMetres,
      altitudeMetres: Math.max(distanceMetres - (anchor?.radiusMetres ?? 0), 0),
      // Span stays on the controller's distance even in transit, because span is what
      // the eye actually sees: the camera's own orbit radius about whatever it is
      // circling is the width of the frame, whichever body that point is near.
      viewSpanMetres: this.spanForDistance(this.controls.distanceMetres),
      epochMs: this.epochMs,
      fps: this.fps,
      drawCalls: stats.drawCalls,
      registered: stats.registered,
      activeLayers: stats.activeLayers,
      addressPath: this.addressPath(anchor?.id ?? null),
      rotationAliased: this.rotationAliased,
      trackingNow: this.trackingNow,
    })
  }

  /**
   * Which end of a flight the camera is actually nearer to.
   *
   * A flight orbits a point interpolated between the two bodies, and no node names
   * that point, so there is no single body the HUD can honestly measure against for
   * the whole trip. Naming the destination from the first frame reads "0.000 m above
   * M87*" with the camera still inside the orbit of Mars; naming the departure body
   * all the way reads "54.8 Mly above Earth" at the far end, which is true and useless.
   * The nearer of the two is the one the view is about, and because the two distances
   * are equal at the crossover the number on screen does not jump when the name does.
   */
  private nearerEndpoint(): SceneNodeHandle | null {
    const from = this.engine.node(this.controls.anchorId)
    const to = this.engine.node(this.currentAnchorId)
    if (!from || from === to) return to
    if (!to) return from
    return this.distanceToNode(from) <= this.distanceToNode(to) ? from : to
  }

  /** Camera-to-node distance in metres, measured in the camera's own frame. */
  private distanceToNode(node: SceneNodeHandle): number {
    convertFrame(this.scratchWorld, node.worldPosition, node.frame, this.engine.cameraFrame)
    return distance3d(this.engine.cameraWorld, this.scratchWorld)
  }

  /** Walk the containment hierarchy from the anchor outward, then reverse it. */
  private addressPath(fromId: string | null): { id: string; name: string }[] {
    const path: { id: string; name: string }[] = []
    let current = this.engine.node(fromId)
    const guard = new Set<string>()
    while (current && !guard.has(current.id)) {
      guard.add(current.id)
      path.push({ id: current.id, name: current.name })
      current = this.engine.node(current.parentId)
    }
    // The root of the chain is whatever structure actually contains the object, and
    // for most of the atlas that is not the solar system: pushing 'Solar System'
    // unconditionally put TON 618 — a quasar 18 billion light years away — inside
    // it, which is the breadcrumb asserting something false. Containment is not
    // catalogued for most nodes, but the layer that draws one is a true statement
    // about where it sits, and that is enough for the top of the address.
    const anchor = this.engine.node(fromId)
    const root = addressRoot(anchor)
    // The registry contains some of these structures as real, flyable nodes — the
    // Milky Way is one — so a chain that already climbed to one must not have it
    // pushed on top of itself: the breadcrumb read "Milky Way > Milky Way > Sgr A*".
    const top = path[path.length - 1]
    if (!top || (top.id !== root.id && top.name !== root.name)) path.push(root)
    return path.reverse()
  }

  /**
   * Hit-test a click against the marker glyphs the label engine just drew.
   *
   * Markers are the right pick target rather than the meshes: at true scale most
   * bodies are sub-pixel, so raycasting geometry would make the solar system almost
   * entirely unclickable. Picking what the user can actually see is both easier and
   * more correct.
   */
  private pick(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    let best: string | null = null
    let bestDistance = Infinity
    for (const hit of this.hits) {
      const d = Math.hypot(hit.x - x, hit.y - y)
      // A generous floor keeps tiny MARKERS tappable on touch. It is not extended to
      // the unmarked hits: those have no ring on screen, and a 14 px grab radius on an
      // object the user cannot see turns a click on empty sky into a selection.
      const reach = hit.touch ? Math.max(hit.r, 14) : hit.r
      if (d <= reach && d < bestDistance) {
        bestDistance = d
        best = hit.id
      }
    }
    return best
  }

  private handlePointerDown = (event: PointerEvent) => {
    this.pointerDownAt = { x: event.clientX, y: event.clientY, time: performance.now() }
  }

  private handlePointerUp = (event: PointerEvent) => {
    const moved = Math.hypot(event.clientX - this.pointerDownAt.x, event.clientY - this.pointerDownAt.y)
    if (moved > 5 || performance.now() - this.pointerDownAt.time > 600) return
    const id = this.pick(event.clientX, event.clientY)
    this.selectedId = id
    this.onSelect?.(id)
  }

  /**
   * Double-click flies.
   *
   * Single-click selects and opens the inspector; getting there required a second
   * trip to a "Fly here" button, which is a lot of ceremony for the single most
   * common thing anyone wants to do in an atlas. Double-click is the convention every
   * map application already taught people.
   */
  private handleDoubleClick = (event: MouseEvent) => {
    const id = this.pick(event.clientX, event.clientY)
    if (!id) return
    event.preventDefault()
    this.selectedId = id
    this.onSelect?.(id)
    this.focus(id)
  }

  /**
   * Move the camera to this object's parent — out of a moon to its planet, out of a
   * planet to the Sun. The counterpart to flying in, and the thing a user reaches for
   * when they are lost.
   */
  focusParent(): boolean {
    const current = this.engine.node(this.currentAnchorId)
    const parentId = current?.parentId
    if (!parentId || !this.engine.node(parentId)) return false
    this.focus(parentId)
    this.selectedId = parentId
    this.onSelect?.(parentId)
    return true
  }

  /** The object the user has selected, which is not necessarily the camera anchor. */
  selectedId: string | null = null

  /**
   * True when the time rate is spinning a visible body faster than the frame rate can
   * show it, so its rotation is aliased: at more than half a turn per frame the spin
   * direction a viewer reads off the screen is not the direction the body is turning.
   *
   * Written by the module that owns the rotation, which is the only code that knows
   * the periods of the bodies in frame; published in the snapshot so the UI can say so
   * rather than letting the atlas quietly show Jupiter spinning backwards.
   */
  rotationAliased = false

  /** Whether the clock was tracking the present on the previous frame; see `frame`. */
  private clockWasLive = true

  /**
   * The object the camera is focused on. Changes the instant a flight is ordered, not
   * when it lands — the destination is what the engine re-anchors onto.
   */
  get anchorId(): string | null {
    return this.currentAnchorId
  }

  private resize(): void {
    const width = this.canvas.clientWidth || window.innerWidth
    const height = this.canvas.clientHeight || window.innerHeight
    this.renderer.setSize(width, height, false)
    this.engine.setSize(width, height)
    const dpr = Math.min(window.devicePixelRatio, 2)
    this.labels.setSize(width, height, dpr)
    this.post.setSize(width, height, dpr)
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    this.resizeObserver.disconnect()
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown)
    this.canvas.removeEventListener('pointerup', this.handlePointerUp)
    this.canvas.removeEventListener('dblclick', this.handleDoubleClick)
    this.controls.dispose()
    this.post.dispose()
    this.engine.dispose()
    this.renderer.dispose()
  }
}
