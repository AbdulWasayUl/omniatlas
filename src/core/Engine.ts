import * as THREE from 'three'
import { Layer, LAYER_CONFIGS, type LayerConfig, type LayerId } from './Layer'
import { type FrameId, type Vec3d, clone3d, convertFrame, copy3d, distance3d, vec3d } from './world'

/**
 * The frame context handed to every module each tick. Deliberately a single mutable
 * object that is reused — modules run 60 times a second and must not allocate.
 */
export interface FrameContext {
  /** Milliseconds since the Unix epoch for the simulated instant being drawn. */
  epochMs: number
  /** Real seconds since the previous frame, clamped. */
  delta: number
  /** Camera position in world metres, in `cameraFrame`. */
  cameraWorld: Readonly<Vec3d>
  cameraFrame: FrameId
  /** Distance in metres from the camera to the current anchor. */
  anchorDistanceMetres: number
  /** The id of the object the camera is anchored to. */
  anchorId: string | null
  /** Vertical field of view, degrees. */
  fovDegrees: number
  /** Canvas size in device-independent pixels. */
  width: number
  height: number
  /** Metres subtended by the full viewport width at the anchor distance. */
  viewSpanMetres: number
  /**
   * True while the camera is in transit, i.e. orbiting an interpolated point that is
   * not `anchorId`'s position.
   *
   * It matters to any module that treats `anchorDistanceMetres` as the distance to the
   * anchor NODE: in transit it is the distance to the orbit point instead, and the two
   * differ by up to eleven orders of magnitude. Measure against the node's own position
   * while this is true, or wait for it to clear. An apparent-size fade computed from
   * `anchorDistanceMetres` in transit is not a small error but a meaningless one: a
   * frame into Earth → TON 618 it is 3.6e7 m, the altitude above EARTH, against a
   * destination radius of 1.95e14 m, so the fade saturates and the module concludes the
   * quasar fills the screen while it is 1.7e26 m away.
   */
  inTransit: boolean
  /**
   * The node the camera is flying AWAY from, while `inTransit`; `null` otherwise.
   *
   * `anchorId` names the destination from the click, because that is what the atlas is
   * focused on. That is the right answer for identity and the wrong one for geometry:
   * a module that builds a close-range stand-in for whatever the camera is looking at
   * has to keep building it for the departure body until the camera is nearer the
   * destination, or the object filling the screen vanishes on the first frame of the
   * flight. Pick between the two the way the HUD does — whichever is nearer — or
   * simply hold the departure body for the whole flight; do not read `anchorId` alone.
   */
  transitFromId: string | null
  engine: Engine
}

/**
 * A content module. Modules own objects, not React components — a star field or an
 * asteroid belt has no business in a reconciler. They are loaded dynamically and
 * failure-isolated: one module throwing never stops the others.
 */
export interface AtlasModule {
  id: string
  /** Build geometry, request data, register nodes. May be slow; runs once. */
  init(engine: Engine): Promise<void> | void
  /** Move things. Runs every frame, before any camera-dependent work. */
  update?(ctx: FrameContext): void
  /** Camera-dependent work: LOD selection, fades, shader uniforms. Runs after `update`. */
  preRender?(ctx: FrameContext): void
  dispose?(): void
}

/** A registered, selectable thing in the atlas. */
export interface SceneNodeHandle {
  id: string
  /** Current world position in metres. */
  worldPosition: Vec3d
  frame: FrameId
  /** Mean radius in metres; 0 when the catalogue records no size. */
  radiusMetres: number
  /**
   * A size to FRAME the camera with, in metres, for an object whose radius is unknown.
   *
   * Strictly not a measurement, and strictly not a substitute for one: `radiusMetres`
   * stays 0 so the inspector keeps reporting the catalogue's silence and the apparent-
   * size fades keep treating the node as point-like. The deep-sky shell is the case
   * that forced the separation — a 100 kpc placeholder distance is a DIRECTION, and a
   * radius derived from it is not a radius, but the camera still has to stop somewhere
   * sensible when you fly there.
   */
  framingRadiusMetres?: number
  /**
   * Equatorial over mean radius of the body as it is DRAWN, for a flattened world.
   *
   * Like `framingRadiusMetres` this is a rendering fact, not a measurement: the
   * catalogue's number is `radiusMetres`, and the inspector reports that. This one
   * exists because SphereBody draws an oblate planet at `mean / cbrt(polarRatio)`
   * across the equator, so a camera floor measured from the mean radius parks 3.5%
   * inside Saturn's own silhouette — near plane first, then the camera itself.
   * Absent or 1 means a sphere.
   */
  shapeRatio?: number
  /** Which layer draws it, for label and picking routing. */
  layer: LayerId
  /** Object class, for glyph and colour. */
  objectClass: string
  /** Display name. */
  name: string
  /**
   * Effective temperature in kelvin, where the catalogue supports one.
   *
   * Set by the module that knows the spectral type, so anything downstream can use the
   * measured value instead of inferring one from the radius. Immersive mode is the first
   * consumer: a star's luminosity decides where its habitable zone falls, and deriving
   * the temperature from the radius put Sabik 2,800 K too hot.
   */
  temperatureK?: number
  /**
   * Other catalogue designations this node answers to, for identity across catalogues.
   *
   * `oneLabelPerObject` reads the designation out of the id, which settles the common
   * case — `ungc:ngc5128` and `ngc:NGC5128` are one galaxy — but not the one where two
   * tables number the same object out of two different catalogues. The Local Group
   * table calls it `lg:messier031` and OpenNGC calls it `ngc:NGC0224`, and nothing in
   * either id says those are the same galaxy. OpenNGC's rows carry the Messier number,
   * so the module that has it states it here rather than leaving the dedupe to guess.
   */
  designations?: readonly string[]
  /** Parent in the containment hierarchy, for the cosmic address. */
  parentId: string | null
  /** Three.js object, when the node has one. */
  object3D?: THREE.Object3D
  /**
   * Colour for the close-range stand-in the proxy module builds for nodes with no
   * `object3D`. Set it where the catalogue knows the colour — a star's from its
   * colour index, say — and leave it off to take the class default.
   */
  proxyColor?: string
}

/**
 * Is the view wide enough that a layer's content is about to be worth having?
 *
 * For datasets that are large, purely visual, and meaningless until the camera reaches
 * a particular rung. The Milky Way's disc field is 3.5 MB of points that say nothing at
 * any view narrower than a galaxy, and the 2MRS field is 0.6 MB that says nothing
 * narrower than the cosmic web, yet both were fetched during module init, before the
 * first frame, for every visitor including the ones who never leave the inner system.
 *
 * The test is deliberately one decade EARLIER than the span band that actually draws
 * the layer, because the fetch has to finish before the content is wanted rather than
 * when it is: a 3.5 MB download started at the moment the galactic layer switches on
 * is a hole in the view for as long as it takes to arrive.
 *
 * Only for content that registers no nodes. Anything searchable has to exist in the
 * registry from the start, because the viewer snapshots it into the label engine once
 * after module load, and because a catalogue you can only find by flying to it first is
 * not a catalogue. That rules out CF4 and UNGC, whose rows are destinations.
 */
export function layerApproaching(engine: Engine, layerId: LayerId, viewSpanMetres: number, decades = 1): boolean {
  const floor = engine.layer(layerId).config.spanBandMetres[0]
  return viewSpanMetres > floor / 10 ** decades
}

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())

/** Which module's `init` is currently running, so `timeDecode` knows who to bill. */
let currentModule: string | null = null
const decodeMs = new Map<string, number>()

/**
 * Time a synchronous decode and bill it to the module currently initialising.
 *
 * Wrap the loop that turns a downloaded buffer into typed arrays, not the fetch around
 * it: the question this answers is how much CPU the main thread spends before the first
 * frame, and an await is not CPU. Outside module init it is a plain call with a timer,
 * which costs two `performance.now()` reads.
 */
export function timeDecode<T>(label: string, run: () => T): T {
  const started = now()
  try {
    return run()
  } finally {
    const spent = now() - started
    if (currentModule) decodeMs.set(currentModule, (decodeMs.get(currentModule) ?? 0) + spent)
    if (spent > 50) console.info(`[omniatlas] decode "${label}" took ${spent.toFixed(0)} ms on the main thread`)
  }
}

/** Below this a layer contributes nothing a viewer could see, so it is skipped. */
const ACTIVE_EPSILON = 0.004

/**
 * Opacity a layer standing in as the backdrop draws at.
 *
 * Low enough that a distant star field reads as sky rather than as the subject, high
 * enough to be unmistakably present on an OLED panel after the tone curve.
 */
const BACKDROP_OPACITY = 0.35

/**
 * Span opacity at which a layer stops being the backdrop, once it has become one.
 *
 * Only the ROLE is hysteretic; the opacity is not, because `BACKDROP_OPACITY` is a floor
 * rather than a fixed value and the floor simply stops binding once the span band rises
 * above it. The flag needs the dead band for its own reason: the galaxy module reads it
 * to drop the disc field from 300,000 instances to 30,000, and a flag that flipped on an
 * exact threshold would swap the instance count back and forth on a camera that merely
 * sat near it.
 */
const BACKDROP_RELEASE = BACKDROP_OPACITY * 1.3

export interface EngineOptions {
  renderer: THREE.WebGLRenderer
  /** Overridden in tests. */
  layerConfigs?: readonly LayerConfig[]
}

/**
 * Owns the layers, the module lifecycle and the per-frame render.
 *
 * The render is a multi-pass composite: layers are drawn from farthest to nearest with
 * the depth buffer cleared between passes and the colour buffer preserved. That is what
 * lets a crater and a galaxy cluster share a frame without sharing a depth range.
 *
 * Layering solves POSITION precision, which is the thing that actually breaks at these
 * magnitudes. It does not solve depth precision *within* one pass, so
 * `logarithmicDepthBuffer` is ON — see the note above `NEAR_RATIO` in `Layer.ts` for
 * why a planet and its moons in a single pass need it. This comment used to claim the
 * opposite and cost a shader author an afternoon: anything writing `gl_FragDepth` or
 * reasoning about the depth encoding must assume log depth.
 */
export class Engine {
  /**
   * Whether invented content may be drawn.
   *
   * Off by default and never set by a module: the viewer sets it when the person asks
   * for immersive mode. Everything it enables is made up, so the flag exists to make
   * that a decision somebody took rather than a default they inherited.
   */
  immersive = false

  /**
   * Bumped whenever the registry gains or loses a node.
   *
   * The label set is built from the registry, and it used to be built exactly once, at
   * the end of boot — which was fine while every module registered everything it would
   * ever have during init. A module that registers later got no marker, and markers are
   * the only pick targets the atlas has, so its objects were invisible AND unclickable.
   * The viewer watches this number instead of guessing.
   */
  registryVersion = 0

  readonly renderer: THREE.WebGLRenderer
  readonly layers: Map<LayerId, Layer> = new Map()
  readonly layersByOrder: Layer[] = []
  readonly registry: Map<string, SceneNodeHandle> = new Map()

  readonly modules: AtlasModule[] = []
  readonly failedModules: { id: string; error: unknown }[] = []

  /**
   * Wall-clock milliseconds each module spent in `init`, in completion order.
   *
   * Boot cost had no attribution at all before this: Lighthouse reported 4.4 s of
   * main-thread work and fifteen long tasks, and nothing in the project could say which
   * of eight modules they belonged to. Guessing from record counts is how you end up
   * optimising the second most expensive thing.
   *
   * Modules load concurrently, so these overlap and include time spent awaiting fetches
   * as well as decoding. That makes the figure an upper bound per module rather than CPU
   * time, which is the right shape for deciding WHAT to look at and the wrong one for
   * claiming how much was saved. `decodeMs` is the CPU half.
   */
  readonly moduleTimings: { id: string; initMs: number; decodeMs: number }[] = []

  /**
   * Set by `dispose`. Module loading is asynchronous and React StrictMode mounts,
   * unmounts and remounts every effect in development, so a boot started by the first
   * mount can still be in flight when the second mount tears its engine down. Without
   * this flag the in-flight module initialises against an engine whose layers have
   * already been cleared, and the whole scene silently fails to appear.
   */
  private disposed = false

  /** Camera pose in world metres. The single source of truth; layers derive from it. */
  readonly cameraWorld: Vec3d = vec3d()
  cameraFrame: FrameId = 'ecliptic'
  readonly cameraQuaternion = new THREE.Quaternion()
  fovDegrees = 50

  /** Where the camera is anchored — the object it orbits and measures against. */
  anchorId: string | null = null
  readonly anchorWorld: Vec3d = vec3d()

  /**
   * The point the camera is actually orbiting while it is in transit, if any.
   *
   * A flight interpolates its orbit point between the departure body and the
   * destination, so for the length of the flight the camera circles a place in empty
   * space that no node names. Measuring against either endpoint instead is wrong by
   * most of the trip: thirty-five percent of the way from Earth to TON 618 the camera
   * is 6.8e15 m from the point it is orbiting and 1.7e26 m from the destination, and
   * feeding the latter to the bands switched the star field off and left eleven
   * seconds of black screen in the middle of every intergalactic flight.
   *
   * `anchorId` keeps naming the DESTINATION throughout, because that is what the atlas
   * is focused on and what the labels and the breadcrumb must read. This is only the
   * geometry.
   */
  private transitAnchorWorld: Vec3d | null = null
  private transitAnchorFrame: FrameId = 'ecliptic'
  private readonly transitAnchorStore: Vec3d = vec3d()
  /** The body being left behind, for the length of the flight. See `FrameContext.transitFromId`. */
  private transitFromId: string | null = null

  private width = 1
  private height = 1
  /** When set, layers composite into this target instead of the default framebuffer. */
  renderTarget: THREE.WebGLRenderTarget | null = null

  /**
   * Draw calls and triangles for the SCENE passes only, captured before any
   * post-processing runs. Reading `renderer.info` at snapshot time instead reports
   * whatever the last pass was, which for us is a single fullscreen quad — the stats
   * overlay cheerfully claimed the whole solar system cost one draw call.
   */
  private sceneDrawCalls = 0
  private sceneTriangles = 0
  private readonly ctx: FrameContext

  constructor(options: EngineOptions) {
    this.renderer = options.renderer
    for (const config of options.layerConfigs ?? LAYER_CONFIGS) {
      const layer = new Layer(config)
      this.layers.set(config.id, layer)
      this.layersByOrder.push(layer)
    }
    // Farthest content first: descending order, so nearer layers composite on top.
    this.layersByOrder.sort((a, b) => b.config.order - a.config.order)

    this.ctx = {
      epochMs: 0,
      delta: 0,
      cameraWorld: this.cameraWorld,
      cameraFrame: this.cameraFrame,
      anchorDistanceMetres: 0,
      anchorId: null,
      fovDegrees: this.fovDegrees,
      width: 1,
      height: 1,
      viewSpanMetres: 0,
      inTransit: false,
      transitFromId: null,
      engine: this,
    }
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  layer(id: LayerId): Layer {
    const layer = this.layers.get(id)
    if (!layer) {
      throw new Error(
        this.disposed ? `Engine disposed while resolving layer "${id}"` : `Unknown layer: ${id}`,
      )
    }
    return layer
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
  }

  register(node: SceneNodeHandle): void {
    this.registry.set(node.id, node)
    this.registryVersion++
  }

  unregister(id: string): void {
    if (this.registry.delete(id)) this.registryVersion++
  }

  node(id: string | null): SceneNodeHandle | null {
    return id ? (this.registry.get(id) ?? null) : null
  }

  /**
   * Load modules concurrently, isolating failures. A module that throws is recorded and
   * skipped; the atlas still opens. This matters more than it sounds: a single bad
   * fetch in the deep-sky module should not cost the user the solar system.
   */
  async loadModules(loaders: { id: string; load: () => Promise<AtlasModule> }[]): Promise<void> {
    const settled = await Promise.allSettled(
      loaders.map(async ({ id, load }) => {
        const module = await load()
        // The dynamic import above yields; re-check before touching the scene graph.
        if (this.disposed) return null
        const started = now()
        decodeMs.set(id, 0)
        currentModule = id
        await module.init(this)
        currentModule = null
        this.moduleTimings.push({ id, initMs: now() - started, decodeMs: decodeMs.get(id) ?? 0 })
        return { id, module }
      }),
    )
    if (this.disposed) return
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        if (result.value) this.modules.push(result.value.module)
      } else {
        this.failedModules.push({ id: loaders[index].id, error: result.reason })
        console.error(`[omniatlas] module "${loaders[index].id}" failed to load`, result.reason)
      }
    })
  }

  /**
   * Hand the engine the point the camera is orbiting while it is in transit, or `null`
   * once it has arrived and `anchorId` names that point again. See `transitAnchorWorld`.
   *
   * `fromId` is the body the flight started at, which is the only other thing in the
   * frame with a claim on being the subject while the camera is between the two — see
   * `FrameContext.transitFromId`.
   */
  setTransitAnchor(worldPosition: Readonly<Vec3d> | null, frame: FrameId, fromId: string | null = null): void {
    if (!worldPosition) {
      this.transitAnchorWorld = null
      this.transitFromId = null
      return
    }
    copy3d(this.transitAnchorStore, worldPosition)
    this.transitAnchorWorld = this.transitAnchorStore
    this.transitAnchorFrame = frame
    this.transitFromId = fromId
  }

  /** Re-anchor the near layers onto a new focus object. */
  setAnchor(id: string | null): void {
    this.anchorId = id
    const node = this.node(id)
    if (!node) return
    convertFrame(this.anchorWorld, node.worldPosition, node.frame, this.cameraFrame)
    this.layer('system').setOrigin(node.worldPosition, node.frame, id)
    this.layer('surface').setOrigin(node.worldPosition, node.frame, id)
  }

  /**
   * Advance and draw one frame.
   *
   * Kept for callers and tests that want both halves in one call. The animation loop
   * uses `advance` and `draw` separately, because the camera controller has to run
   * BETWEEN them — see `advance`.
   */
  renderFrame(epochMs: number, delta: number): void {
    this.advance(epochMs, delta)
    this.draw()
  }

  /**
   * Pass one: move things to `epochMs`, knowing nothing about where the camera is.
   *
   * This is half of a frame, and the split is load-bearing. The loop used to advance
   * the clock, run the camera controller, and only then run the modules, so the camera
   * was placed against positions two frames old: the controller rebuilt its pose from
   * an anchor written during the PREVIOUS frame, and the body it was tracking then
   * moved again inside the same frame. The off-axis error is two times the anchor's
   * orbital speed times the simulated seconds per frame, so it is invisible at live
   * rate and ruinous at any other — anchored on Earth at a day per second the planet
   * sat 50 degrees off the optical axis, against a horizontal half-FOV of 39, and at a
   * month per second 77 degrees. The object you had just flown to was off screen.
   *
   * The fix is ordering, not interpolation: modules move first, the controller then
   * tracks the anchor where it now is, and `draw` measures against both.
   *
   * What the caller owes this half: `anchorId` and the transit anchor, both set before
   * the call. `update` is where a module builds and tears down the stand-in for
   * whatever the camera is looking at, so a context that names the destination while
   * still claiming not to be in transit tells it the flight is already over.
   */
  advance(epochMs: number, delta: number): void {
    const ctx = this.ctx
    ctx.epochMs = epochMs
    ctx.delta = delta
    this.syncViewContext()

    for (const module of this.modules) {
      try {
        module.update?.(ctx)
      } catch (error) {
        console.error(`[omniatlas] module "${module.id}" threw in update`, error)
      }
    }
  }

  /**
   * Pass two: place the cameras and composite.
   *
   * Everything derived from the anchor AND the camera together is computed here and
   * nowhere else — the anchor's position in the camera frame, the distance to it, the
   * view span, the near-plane hint, which layers are active. Those are the numbers the
   * reorder exists to get right, so computing any of them in `advance` would reinstate
   * the bug in a quieter form: the body would be centred while the near plane, the
   * scale ladder and the layer bands still used a distance 2.6e9 m out on a 2.7e7 m
   * anchor distance, clipping the planet and pushing the system layer out of band.
   */
  draw(): void {
    const ctx = this.ctx
    const anchor = this.node(this.anchorId)
    // Into the CAMERA's frame, not the node's. A node states the frame its position is
    // expressed in, and copying an ICRF vector into an ecliptic-frame field silently
    // rotates it by the obliquity: anchoring on Betelgeuse, 152 pc away, measured the
    // distance to it as 62 pc, and every consumer of that number — the near plane, the
    // scale ladder, the layer bands, the proxy's size fade — was wrong by that much.
    const transit = this.transitAnchorWorld
    if (transit) {
      convertFrame(this.anchorWorld, transit, this.transitAnchorFrame, this.cameraFrame)
      // The near layers re-origin onto the orbit point too. Left on the destination
      // they sit 1.7e26 m away, which is 1.7e20 of the system layer's units — nine
      // decades past what a float32 vertex attribute can hold, so anything drawn into
      // them mid-flight is noise.
      this.layer('system').setOrigin(this.anchorWorld, this.cameraFrame, null)
      this.layer('surface').setOrigin(this.anchorWorld, this.cameraFrame, null)
    } else if (anchor) {
      convertFrame(this.anchorWorld, anchor.worldPosition, anchor.frame, this.cameraFrame)
      // Keep the near layers glued to their anchor as it moves along its orbit. Here
      // and only here: `advance` ran the same two lines a few microseconds earlier,
      // which cost two convertFrame calls a frame and bought nothing, because nothing
      // moves the anchor between the two halves. It also skipped the frame a flight
      // LANDS on — `advance` saw the flight still in progress, the anchor clause goes
      // by the layer's id, and so both near layers blinked off for one frame on every
      // arrival. Doing it once, after `update` and after the transit test, is what
      // makes both the moving anchor and the arrival frame come out right.
      this.layer('system').setOrigin(anchor.worldPosition, anchor.frame, anchor.id)
      this.layer('surface').setOrigin(anchor.worldPosition, anchor.frame, anchor.id)
    }

    this.syncViewContext()
    ctx.anchorDistanceMetres = transit || anchor ? distance3d(this.cameraWorld, this.anchorWorld) : 0
    // Horizontal span of the viewport at the anchor distance. This is the number the
    // scale ladder tracks, because span is what a person actually perceives.
    const halfFov = (this.fovDegrees * Math.PI) / 360
    const aspect = this.width / this.height
    ctx.viewSpanMetres = 2 * Math.tan(halfFov) * aspect * Math.max(ctx.anchorDistanceMetres, 1)

    // Altitude above the anchor's surface: the nearest thing the user is looking at,
    // and therefore what the near plane must clear.
    // In transit the orbit point is empty space, so there is no surface to clear and
    // the altitude is the whole distance.
    const anchorRadius = transit ? 0 : (anchor?.radiusMetres ?? 0)
    const nearHint =
      transit || anchor
        ? Math.max(ctx.anchorDistanceMetres - anchorRadius, ctx.anchorDistanceMetres * 1e-4, 1)
        : Infinity

    this.activateLayers(aspect, nearHint, ctx.viewSpanMetres)

    for (const module of this.modules) {
      try {
        module.preRender?.(ctx)
      } catch (error) {
        console.error(`[omniatlas] module "${module.id}" threw in preRender`, error)
      }
    }

    this.composite()
  }

  /** Copy the camera-independent view state into the shared frame context. */
  private syncViewContext(): void {
    const ctx = this.ctx
    ctx.cameraFrame = this.cameraFrame
    ctx.anchorId = this.anchorId
    ctx.inTransit = this.transitAnchorWorld !== null
    ctx.transitFromId = ctx.inTransit ? this.transitFromId : null
    ctx.fovDegrees = this.fovDegrees
    ctx.width = this.width
    ctx.height = this.height
  }

  /**
   * Rebase every layer and decide which of them draw, and how strongly.
   *
   * Worked from the NEAREST layer outward, which is the part that matters. A layer
   * belongs on its own merits when it is both within reach of its origin and at a view
   * span where its content means something — but those two tests are measured against
   * different things (the layer's origin, and the anchor), so they can disagree, and
   * when they disagree about the OUTERMOST layer the result is an empty sky. Anchored
   * on a star 8.4 kpc out the galactic layer was well inside its distance band and was
   * blanked by a span floor six decades above the view; at M87 the same happened to
   * the cosmic layer. Both times the span floor was doing its real job — keeping 43k
   * galaxies off a planetary close-up — on a view that had no close-up in it.
   *
   * So the floor is conditional. If nothing nearer is drawing the sky, the first layer
   * still within reach stands in as a BACKDROP at a floor opacity instead of
   * vanishing. One layer takes that role, never two, and the anchor-local layers never
   * take it: they hold the single object the camera is pointed at, not a sky.
   */
  private activateLayers(aspect: number, nearHint: number, viewSpanMetres: number): void {
    let covered = false
    // `layersByOrder` is farthest-first, which is the composite order; walk it backwards.
    for (let i = this.layersByOrder.length - 1; i >= 0; i--) {
      const layer = this.layersByOrder[i]
      layer.rebase(this.cameraWorld, this.cameraFrame, this.cameraQuaternion, this.fovDegrees, aspect, nearHint)
      layer.updateSpanOpacity(viewSpanMetres)

      const band = layer.bandOpacity()
      // A layer with no distance band re-origins onto the anchor, so it holds the
      // subject rather than a sky. Two things follow: it can never be the backdrop,
      // and it can never COVER one — a planet filling the system layer says nothing
      // about whether there is a sky behind it.
      const anchorLocal = layer.config.bandMetres === null
      // In transit the near layers are re-origined onto the orbit point, which no node
      // names, so there is no id to match — but the origin IS the thing the camera is
      // circling, which is the condition the id match stands in for. Without this the
      // body you are leaving switches off on the first frame of every flight, which is
      // a worse pop than the one the transit anchor exists to fix.
      const anchored =
        (this.anchorId !== null && layer.anchorId === this.anchorId) ||
        (anchorLocal && this.transitAnchorWorld !== null)

      // Anchoring waives the DISTANCE band and only that. The band asks "is the camera
      // within reach of this layer's origin", which is unanswerable for a layer whose
      // origin IS the camera's anchor; the span band asks "is this content the right
      // size for this view", which is a real question even about the subject. This
      // clause was briefly promoted to "active at opacity 1, unconditionally", and the
      // effect was that system and surface were on in every frame the atlas drew,
      // listed in the stats overlay, with nothing in them.
      let opacity = anchored ? layer.spanOpacity : Math.min(band, layer.spanOpacity)
      let active = opacity > ACTIVE_EPSILON
      let backdrop = false

      // The rescue engages while the layer is still FADING, not after it has gone out.
      //
      // It used to be the `else` to `active`, so it could only fire on a layer already
      // under `ACTIVE_EPSILON` — which meant the sky fell to 0.004, then jumped to 0.35
      // on the next frame, and jumped back down again the moment the span band lifted it
      // past the epsilon. A camera dollying near that point flashed the whole backdrop on
      // and off. Treating `BACKDROP_OPACITY` as a FLOOR the layer meets on its way down
      // makes both crossings continuous: at the threshold the floor and the span band are
      // the same number, and above it the floor stops binding on its own.
      //
      // The role is still exclusive and still earned the same way. Only a layer blanked by
      // its span FLOOR is rescued — "this content is too big for the view" is the case
      // where the content is nevertheless the only sky there is. A layer faded out by its
      // span CEILING is too SMALL to matter, and reviving it draws the solar system's
      // orbits as a backdrop behind a star.
      const release = layer.isBackdrop ? BACKDROP_RELEASE : BACKDROP_OPACITY
      if (
        !covered &&
        !anchorLocal &&
        band > ACTIVE_EPSILON &&
        viewSpanMetres < layer.config.spanBandMetres[0] &&
        opacity < release
      ) {
        opacity = Math.max(opacity, BACKDROP_OPACITY)
        active = true
        backdrop = true
      }

      if (active) covered = covered || !anchorLocal

      // The one remaining unconditional escape hatch, for the subject that is out of
      // every band the atlas has: a 1,300 AU black hole. The proxy module sets it on
      // whichever layer it drew the stand-in into.
      if (layer.forceActive) {
        active = true
        // Waives the DISTANCE band and only that, on the same terms as `anchored`: the
        // camera is out of reach of this layer's origin, which is exactly the condition
        // a stand-in exists to survive, while "is this content the right size for this
        // view" remains a real question about everything else in the layer.
        //
        // This used to read `opacity = 1`, which cost nothing it was meant to buy. The
        // proxy module does not fade its materials by `renderOpacity` at all — it only
        // needs `active`, since `composite` skips on that alone — but `smallbodies` DOES,
        // so anchoring on a comet snapped the entire asteroid cloud to full brightness
        // and dropped it again the moment the proxy went away.
        opacity = Math.max(opacity, layer.spanOpacity)
        backdrop = false
        // And it counts as covering the sky, on the same terms as any other layer:
        // today the only forced layer is `system`, which is anchor-local and could
        // not cover anyway, but the moment a stand-in is forced into `stellar` or
        // `galactic` a layer drawing the whole subject at opacity 1 would otherwise
        // still let an outer layer light up at BACKDROP_OPACITY behind it.
        if (!anchorLocal) covered = true
      }

      layer.active = active
      layer.renderOpacity = active ? opacity : 0
      layer.isBackdrop = active && backdrop
    }
  }

  /**
   * The multi-pass composite. Colour is cleared once; depth is cleared between every
   * layer so that each pass owns a fresh depth range. Depth clears are close to free on
   * both tiled and immediate-mode GPUs.
   */
  private composite(): void {
    const gl = this.renderer
    gl.setRenderTarget(this.renderTarget)
    gl.autoClear = false
    gl.clear(true, true, true)

    for (const layer of this.layersByOrder) {
      if (!layer.active || layer.scene.children.length === 0) continue
      gl.clearDepth()
      gl.render(layer.scene, layer.camera)
    }

    this.sceneDrawCalls = gl.info.render.calls
    this.sceneTriangles = gl.info.render.triangles
  }

  /** Snapshot for the stats overlay. */
  stats(): {
    moduleTimings: readonly { id: string; initMs: number; decodeMs: number }[]
    activeLayers: string[]
    registered: number
    failed: number
    drawCalls: number
    triangles: number
  } {
    return {
      moduleTimings: this.moduleTimings,
      activeLayers: this.layersByOrder.filter((l) => l.active).map((l) => l.id),
      registered: this.registry.size,
      failed: this.failedModules.length,
      drawCalls: this.sceneDrawCalls,
      triangles: this.sceneTriangles,
    }
  }

  dispose(): void {
    this.disposed = true
    for (const module of this.modules) {
      try {
        module.dispose?.()
      } catch (error) {
        console.error(`[omniatlas] module "${module.id}" threw in dispose`, error)
      }
    }
    this.modules.length = 0
    for (const layer of this.layers.values()) layer.dispose()
    this.layers.clear()
    this.layersByOrder.length = 0
    this.registry.clear()
  }
}

/** Convenience for modules: a registered node with its own Three.js group. */
export function createNode(
  engine: Engine,
  spec: Omit<SceneNodeHandle, 'worldPosition'> & { worldPosition?: Vec3d },
): SceneNodeHandle {
  const node: SceneNodeHandle = {
    ...spec,
    worldPosition: spec.worldPosition ? clone3d(spec.worldPosition) : vec3d(),
  }
  engine.register(node)
  return node
}
