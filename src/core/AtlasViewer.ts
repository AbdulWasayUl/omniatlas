import * as THREE from 'three'
import { Engine, type AtlasModule } from './Engine'
import { AtlasControls } from './camera/AtlasControls'
import { LabelEngine } from './labels/LabelEngine'
import { PostStack } from './render/PostStack'
import { classStyle } from '../data/objectClasses'
import { AU_M, type Vec3d, copy3d, vec3d } from './world'

/**
 * Owns the renderer, the engine, the camera controller and the animation loop.
 *
 * Deliberately framework-agnostic: React mounts it and reads from it, but never drives
 * a frame. The old architecture called the ephemeris three times a second from three
 * separate components and re-reconciled the entire R3F tree on every tick; here the
 * hot path touches no React state at all, and the chrome subscribes to a throttled
 * snapshot instead.
 */

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
  private hits: { id: string; x: number; y: number; r: number }[] = []
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
    this.renderer.setClearColor(0x05070a, 1)

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
    this.focus('sun', { instant: true, distanceMetres: 3.4 * AU_M })
    options.onReady?.()
    this.start()
  }

  /** Rebuild the label set from the registry. Call after modules add objects. */
  refreshLabels(): void {
    this.labels.setItems(
      [...this.engine.registry.values()].map((node) => ({
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
    const radius = Math.max(node.radiusMetres, 1)
    const distance = options.distanceMetres ?? (node.radiusMetres > 0 ? radius * 4.2 : 1e9)

    // Arrive on the lit side.
    //
    // A body's day side is where the surface detail is, and arriving at a black disc
    // is both ugly and uninformative. The Sun sits at the origin of the heliocentric
    // frame, so the sunward direction from any body is simply the negated normalised
    // position. Offsetting by about 28 degrees keeps a crescent of night in frame, so
    // the terminator still reads and the globe still looks like a sphere rather than a
    // flat lit disc.
    if (id !== 'sun' && node.radiusMetres > 0) {
      const { x, y, z } = node.worldPosition
      const length = Math.hypot(x, y, z)
      if (length > 0) {
        const sunwardYaw = Math.atan2(-y, -x)
        const sunwardPitch = Math.asin(Math.min(Math.max(-z / length, -1), 1))
        this.controls.setOrbit(sunwardYaw + 0.49, sunwardPitch + 0.22)
      }
    }

    this.controls.flyTo(
      {
        anchorWorld: node.worldPosition,
        radiusMetres: node.radiusMetres,
        distanceMetres: distance,
        anchorId: id,
      },
      { instant: options.instant },
    )
    this.engine.setAnchor(id)
  }

  /** Pause or resume the simulation clock. */
  setPaused(paused: boolean): void {
    this.paused = paused
  }

  /** Set simulated seconds per real second. Zero pauses. */
  setTimeRate(rate: number): void {
    this.timeRate = rate
    this.paused = rate === 0
  }

  /** Snap the clock back to the real current instant and run at real time. */
  resumeLive(): void {
    this.epochMs = Date.now()
    this.timeRate = 1
    this.paused = false
  }

  /** Jump the camera to a given view span without changing the anchor. */
  setViewSpanMetres(span: number): void {
    const halfFov = (this.engine.fovDegrees * Math.PI) / 360
    const aspect = Math.max(this.canvas.clientWidth, 1) / Math.max(this.canvas.clientHeight, 1)
    this.controls.setDistance(span / (2 * Math.tan(halfFov) * aspect))
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
    const delta = Math.min((now - this.lastFrameTime) / 1000, 0.1)
    this.lastFrameTime = now

    if (!this.paused) this.epochMs += delta * 1000 * this.timeRate

    this.controls.update(delta)

    // Keep the anchor glued to its body as that body moves along its own orbit.
    const anchor = this.engine.node(this.controls.anchorId)
    if (anchor) {
      copy3d(this.scratchWorld, anchor.worldPosition)
      this.controls.trackAnchor(this.scratchWorld, anchor.frame)
      this.controls.anchorRadiusMetres = anchor.radiusMetres
    }

    copy3d(this.engine.cameraWorld, this.controls.cameraWorld)
    this.engine.cameraFrame = this.controls.frame
    this.engine.cameraQuaternion.copy(this.controls.quaternion)
    this.engine.anchorId = this.controls.anchorId

    const halfFov = (this.engine.fovDegrees * Math.PI) / 360
    const aspect = Math.max(this.canvas.clientWidth, 1) / Math.max(this.canvas.clientHeight, 1)
    this.lastViewSpanMetres = 2 * Math.tan(halfFov) * aspect * this.controls.distanceMetres

    this.engine.renderTarget = this.post.sceneTarget
    this.engine.renderFrame(this.epochMs, delta)
    this.elapsed += delta
    this.post.render(this.elapsed)
    this.labels.selectedId = this.selectedId
    this.labels.anchorId = this.controls.anchorId
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

  private publish(): void {
    if (!this.onSnapshot) return
    const anchor = this.engine.node(this.controls.anchorId)
    const stats = this.engine.stats()
    const halfFov = (this.engine.fovDegrees * Math.PI) / 360
    const aspect = Math.max(this.canvas.clientWidth, 1) / Math.max(this.canvas.clientHeight, 1)

    this.onSnapshot({
      anchorId: this.controls.anchorId,
      anchorName: anchor?.name ?? 'Space',
      distanceMetres: this.controls.distanceMetres,
      altitudeMetres: Math.max(this.controls.distanceMetres - (anchor?.radiusMetres ?? 0), 0),
      viewSpanMetres: 2 * Math.tan(halfFov) * aspect * this.controls.distanceMetres,
      epochMs: this.epochMs,
      fps: this.fps,
      drawCalls: stats.drawCalls,
      registered: stats.registered,
      activeLayers: stats.activeLayers,
      addressPath: this.addressPath(),
    })
  }

  /** Walk the containment hierarchy from the anchor outward, then reverse it. */
  private addressPath(): { id: string; name: string }[] {
    const path: { id: string; name: string }[] = []
    let current = this.engine.node(this.controls.anchorId)
    const guard = new Set<string>()
    while (current && !guard.has(current.id)) {
      guard.add(current.id)
      path.push({ id: current.id, name: current.name })
      current = this.engine.node(current.parentId)
    }
    path.push({ id: 'solar-system', name: 'Solar System' })
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
      // A generous floor keeps tiny markers tappable on touch.
      if (d <= Math.max(hit.r, 14) && d < bestDistance) {
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
    const current = this.engine.node(this.controls.anchorId)
    const parentId = current?.parentId
    if (!parentId || !this.engine.node(parentId)) return false
    this.focus(parentId)
    this.selectedId = parentId
    this.onSelect?.(parentId)
    return true
  }

  /** The object the user has selected, which is not necessarily the camera anchor. */
  selectedId: string | null = null

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
