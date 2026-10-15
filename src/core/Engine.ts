import * as THREE from 'three'
import { Layer, LAYER_CONFIGS, type LayerConfig, type LayerId } from './Layer'
import { type FrameId, type Vec3d, clone3d, convertFrame, distance3d, vec3d } from './world'

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
  /** Mean radius in metres; 0 for point-like objects. */
  radiusMetres: number
  /** Which layer draws it, for label and picking routing. */
  layer: LayerId
  /** Object class, for glyph and colour. */
  objectClass: string
  /** Display name. */
  name: string
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
 * lets a crater and a galaxy cluster share a frame without sharing a depth range — and
 * it is why `logarithmicDepthBuffer` is off. Log depth writes `gl_FragDepth`, which
 * disables early-Z on every GPU, and it only addresses depth precision, not the
 * position precision that actually breaks at these magnitudes.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer
  readonly layers: Map<LayerId, Layer> = new Map()
  readonly layersByOrder: Layer[] = []
  readonly registry: Map<string, SceneNodeHandle> = new Map()

  readonly modules: AtlasModule[] = []
  readonly failedModules: { id: string; error: unknown }[] = []

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
  }

  unregister(id: string): void {
    this.registry.delete(id)
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
        await module.init(this)
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

  /** Re-anchor the near layers onto a new focus object. */
  setAnchor(id: string | null): void {
    this.anchorId = id
    const node = this.node(id)
    if (!node) return
    convertFrame(this.anchorWorld, node.worldPosition, node.frame, this.cameraFrame)
    const radius = Math.max(node.radiusMetres, 1)
    this.layer('system').setOrigin(node.worldPosition, node.frame, id)
    this.layer('surface').setOrigin(node.worldPosition, node.frame, id)
    void radius
  }

  /**
   * Advance and draw one frame.
   *
   * Three strictly ordered passes. `update` moves things without knowing where the
   * camera is; layers then rebase; `preRender` does camera-dependent work against a
   * camera that is already final. Mixing those produces a one-frame lag in every LOD
   * and fade decision, which reads as shimmer.
   */
  renderFrame(epochMs: number, delta: number): void {
    const anchor = this.node(this.anchorId)
    // Into the CAMERA's frame, not the node's. A node states the frame its position is
    // expressed in, and copying an ICRF vector into an ecliptic-frame field silently
    // rotates it by the obliquity: anchoring on Betelgeuse, 152 pc away, measured the
    // distance to it as 62 pc, and every consumer of that number — the near plane, the
    // scale ladder, the layer bands, the proxy's size fade — was wrong by that much.
    if (anchor) convertFrame(this.anchorWorld, anchor.worldPosition, anchor.frame, this.cameraFrame)

    const ctx = this.ctx
    ctx.epochMs = epochMs
    ctx.delta = delta
    ctx.cameraFrame = this.cameraFrame
    ctx.anchorId = this.anchorId
    ctx.fovDegrees = this.fovDegrees
    ctx.width = this.width
    ctx.height = this.height
    ctx.anchorDistanceMetres = anchor ? distance3d(this.cameraWorld, this.anchorWorld) : 0
    // Horizontal span of the viewport at the anchor distance. This is the number the
    // scale ladder tracks, because span is what a person actually perceives.
    const halfFov = (this.fovDegrees * Math.PI) / 360
    const aspect = this.width / this.height
    ctx.viewSpanMetres = 2 * Math.tan(halfFov) * aspect * Math.max(ctx.anchorDistanceMetres, 1)

    for (const module of this.modules) {
      try {
        module.update?.(ctx)
      } catch (error) {
        console.error(`[omniatlas] module "${module.id}" threw in update`, error)
      }
    }

    // Keep the near layers glued to their anchor as it moves along its orbit.
    if (anchor) {
      this.layer('system').setOrigin(anchor.worldPosition, anchor.frame, anchor.id)
      this.layer('surface').setOrigin(anchor.worldPosition, anchor.frame, anchor.id)
    }

    // Altitude above the anchor's surface: the nearest thing the user is looking at,
    // and therefore what the near plane must clear.
    const nearHint = anchor
      ? Math.max(ctx.anchorDistanceMetres - anchor.radiusMetres, ctx.anchorDistanceMetres * 1e-4, 1)
      : Infinity

    for (const layer of this.layersByOrder) {
      layer.rebase(this.cameraWorld, this.cameraFrame, this.cameraQuaternion, this.fovDegrees, aspect, nearHint)
      layer.updateSpanOpacity(ctx.viewSpanMetres)
      // A layer must be both within reach AND at a scale where its content belongs.
      layer.active = (layer.inBand() || layer.anchorId === this.anchorId) && layer.spanOpacity > 0.004
    }

    for (const module of this.modules) {
      try {
        module.preRender?.(ctx)
      } catch (error) {
        console.error(`[omniatlas] module "${module.id}" threw in preRender`, error)
      }
    }

    this.composite()
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
  stats(): { activeLayers: string[]; registered: number; failed: number; drawCalls: number; triangles: number } {
    return {
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
