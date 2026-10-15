import * as THREE from 'three'
import type { AtlasModule, Engine, FrameContext, SceneNodeHandle } from '../../core/Engine'
import type { LayerId } from '../../core/Layer'

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
 * are off-screen forever.
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
 * a few hundred kilometres.
 */
function lumpySphere(random: () => number, irregularity: number): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(1, 5)
  const axes: THREE.Vector3[] = []
  const frequencies: number[] = []
  for (let i = 0; i < 6; i++) {
    axes.push(new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize())
    frequencies.push(1.4 + random() * 3.6)
  }
  const position = geometry.attributes.position as THREE.BufferAttribute
  const v = new THREE.Vector3()
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i)
    let displacement = 0
    for (let a = 0; a < axes.length; a++) displacement += Math.sin(v.dot(axes[a]) * frequencies[a] + a) / axes.length
    v.multiplyScalar(1 + displacement * irregularity)
    position.setXYZ(i, v.x, v.y, v.z)
  }
  geometry.computeVertexNormals()
  return geometry
}

/** Additive points from a position list, as one draw call. */
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

/** Everything a built proxy needs for its lifetime. */
interface Proxy {
  nodeId: string
  layerId: LayerId
  group: THREE.Group
  /** Materials whose opacity the apparent-size fade drives. */
  fading: { material: THREE.Material & { opacity: number }; base: number }[]
  dispose: () => void
}

/**
 * Apparent radius in pixels below which a proxy says nothing a point has not already
 * said, and above which it is the only thing that can say it.
 */
const FADE_IN_PX = 3
const FADE_FULL_PX = 14

export class ProxyModule implements AtlasModule {
  readonly id = 'proxy'
  private engine!: Engine
  private proxy: Proxy | null = null
  private readonly scratch = new THREE.Vector3()

  init(engine: Engine): void {
    this.engine = engine
  }

  /** True when the anchored object is being drawn as an illustration, not an observation. */
  isProxy(nodeId: string | null): boolean {
    return this.proxy !== null && this.proxy.nodeId === nodeId
  }

  preRender(ctx: FrameContext): void {
    const node = this.engine.node(ctx.anchorId)
    const wanted = node && !node.object3D && node.radiusMetres > 0 ? node : null

    if (this.proxy && (!wanted || this.proxy.nodeId !== wanted.id)) this.clear()
    if (!wanted) return
    if (!this.proxy) this.proxy = this.build(wanted)
    if (!this.proxy) return

    const layer = this.engine.layer(this.proxy.layerId)
    layer.toLocal(this.scratch, node!.worldPosition, node!.frame)
    this.proxy.group.position.copy(this.scratch)
    this.proxy.group.scale.setScalar(layer.toLocalLength(node!.radiusMetres))

    // Fade on apparent size, so the proxy takes over from the catalogue point exactly
    // where the point stops being able to represent the object.
    const halfFov = Math.tan((ctx.fovDegrees * Math.PI) / 360)
    const radiusPx = (node!.radiusMetres / Math.max(ctx.anchorDistanceMetres, 1) / halfFov) * (ctx.height / 2)
    const fade = THREE.MathUtils.clamp((radiusPx - FADE_IN_PX) / (FADE_FULL_PX - FADE_IN_PX), 0, 1)
    this.proxy.group.visible = fade > 0.002
    for (const entry of this.proxy.fading) entry.material.opacity = entry.base * fade
  }

  dispose(): void {
    this.clear()
  }

  private clear(): void {
    if (!this.proxy) return
    this.engine.layer(this.proxy.layerId).scene.remove(this.proxy.group)
    this.proxy.dispose()
    this.proxy = null
  }

  private build(node: SceneNodeHandle): Proxy | null {
    const random = mulberry32(hashId(node.id))
    const group = new THREE.Group()
    const disposables: { dispose: () => void }[] = []
    const fading: Proxy['fading'] = []

    switch (node.objectClass) {
      case 'asteroid':
      case 'comet':
      case 'dwarf-planet':
      case 'moon':
      case 'planet':
        this.buildRockyBody(node, random, group, disposables)
        break
      case 'nebula':
        this.buildNebula(random, group, disposables, fading)
        break
      case 'cluster':
        this.buildCluster(random, group, disposables, fading)
        break
      case 'galaxy':
        this.buildGalaxy(random, group, disposables, fading)
        break
      case 'black-hole':
        this.buildBlackHole(group, disposables, fading)
        break
      case 'star':
        this.buildStar(node, group, disposables)
        break
      default:
        return null
    }

    // renderOrder keeps the additive clouds behind nothing in particular but after the
    // opaque pass, which is what their blend mode assumes.
    group.renderOrder = 3
    this.engine.layer(node.layer).scene.add(group)
    return {
      nodeId: node.id,
      layerId: node.layer,
      group,
      fading,
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
  ): void {
    // Below about 300 km, self-gravity loses to material strength and shapes stay
    // irregular; above it they relax towards a sphere.
    const irregularity = THREE.MathUtils.clamp(0.26 * (1 - node.radiusMetres / 4e5), 0.02, 0.26)
    const geometry = lumpySphere(random, irregularity)
    const isComet = node.objectClass === 'comet'
    const tint = isComet ? 0x6e7a80 : 0x8a7f72
    const material =
      node.layer === 'helio' || node.layer === 'system'
        ? new THREE.MeshStandardMaterial({ color: tint, roughness: 0.96, metalness: 0 })
        : new THREE.MeshBasicMaterial({ color: tint })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.rotation.set(random() * Math.PI, random() * Math.PI, random() * Math.PI)
    group.add(mesh)
    disposables.push(geometry, material)
  }

  /**
   * A star as a self-lit sphere in its own colour.
   *
   * Driven above 1.0 so the bloom in the post stack produces the glare, rather than
   * the disc being painted with a halo it does not have.
   */
  private buildStar(node: SceneNodeHandle, group: THREE.Group, disposables: { dispose: () => void }[]): void {
    const geometry = new THREE.SphereGeometry(1, 64, 32)
    // AgX desaturates highlights hard, and a photosphere driven to 3x reaches the
    // screen as white whatever colour it started. Deepen the hue first so a red
    // supergiant still reads as one after tone mapping.
    const colour = new THREE.Color(node.proxyColor ?? '#fff3e0')
    const hsl = { h: 0, s: 0, l: 0 }
    colour.getHSL(hsl)
    colour.setHSL(hsl.h, Math.min(hsl.s * 3.4, 1), hsl.l)
    colour.multiplyScalar(2.3)
    const material = new THREE.MeshBasicMaterial({ color: colour })
    group.add(new THREE.Mesh(geometry, material))
    disposables.push(geometry, material)
  }

  /**
   * An emission nebula as a clump of soft billboards.
   *
   * Real nebulae are filamentary, so the cloud is built as a handful of elongated
   * strands rather than one isotropic blob — at the measured angular size, and with
   * nothing in it that claims to be a specific structure.
   */
  private buildNebula(
    random: () => number,
    group: THREE.Group,
    disposables: { dispose: () => void }[],
    fading: Proxy['fading'],
  ): void {
    const count = 900
    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const strands = 7
    const strandDir: THREE.Vector3[] = []
    const strandOrigin: THREE.Vector3[] = []
    for (let s = 0; s < strands; s++) {
      strandDir.push(new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize())
      strandOrigin.push(new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).multiplyScalar(0.7))
    }
    const hot = new THREE.Color('#ffd8dd')
    const cool = new THREE.Color('#5f7fd8')
    const colour = new THREE.Color()
    for (let i = 0; i < count; i++) {
      const s = i % strands
      const t = random() * 2 - 1
      const spread = 0.26 * (1 - Math.abs(t) * 0.5)
      positions[i * 3] = strandOrigin[s].x + strandDir[s].x * t + (random() - 0.5) * spread
      positions[i * 3 + 1] = strandOrigin[s].y + strandDir[s].y * t + (random() - 0.5) * spread
      positions[i * 3 + 2] = strandOrigin[s].z + strandDir[s].z * t + (random() - 0.5) * spread
      // Hotter towards the middle, where the ionising stars of a real H II region are.
      const r = Math.hypot(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
      colour.copy(cool).lerp(hot, THREE.MathUtils.clamp(1 - r, 0, 1))
      colors[i * 3] = colour.r
      colors[i * 3 + 1] = colour.g
      colors[i * 3 + 2] = colour.b
    }
    const points = pointCloud(positions, colors, 0.5, 0.2)
    group.add(points)
    disposables.push(points.geometry, points.material as THREE.Material)
    fading.push({ material: points.material as THREE.PointsMaterial, base: 0.2 })
  }

  /**
   * A star cluster as a Plummer-like swarm.
   *
   * The radial profile is the one thing about a cluster that a proxy can get right
   * from a single number: concentrated core, sparse halo, truncated at the measured
   * radius.
   */
  private buildCluster(
    random: () => number,
    group: THREE.Group,
    disposables: { dispose: () => void }[],
    fading: Proxy['fading'],
  ): void {
    const count = 1400
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
    const points = pointCloud(positions, colors, 0.035, 0.95)
    group.add(points)
    disposables.push(points.geometry, points.material as THREE.Material)
    fading.push({ material: points.material as THREE.PointsMaterial, base: 0.95 })
  }

  /** A galaxy as an exponential disc plus a bulge, at the catalogue radius. */
  private buildGalaxy(
    random: () => number,
    group: THREE.Group,
    disposables: { dispose: () => void }[],
    fading: Proxy['fading'],
  ): void {
    const count = 9000
    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const bulgeFraction = 0.22
    const arms = 2 + Math.floor(random() * 3)
    const pitch = 0.22 + random() * 0.16
    const young = new THREE.Color('#9fc4ff')
    const old = new THREE.Color('#ffd9a0')
    const colour = new THREE.Color()
    for (let i = 0; i < count; i++) {
      if (random() < bulgeFraction) {
        // Bulge: a mildly flattened ellipsoid.
        const r = 0.26 * random() ** 1.8
        const cosTheta = random() * 2 - 1
        const sinTheta = Math.sqrt(1 - cosTheta * cosTheta)
        const phi = random() * Math.PI * 2
        positions[i * 3] = r * sinTheta * Math.cos(phi)
        positions[i * 3 + 1] = r * sinTheta * Math.sin(phi)
        positions[i * 3 + 2] = r * cosTheta * 0.72
        colour.copy(old)
      } else {
        // Disc: exponential in radius, with stars gathered towards log-spiral arms.
        const r = Math.min(-0.34 * Math.log(1 - random() * 0.98), 1)
        const arm = Math.floor(random() * arms)
        const armPhase = (arm / arms) * Math.PI * 2 + Math.log(Math.max(r, 0.02)) / pitch
        const phi = armPhase + (random() - 0.5) * 0.9
        positions[i * 3] = r * Math.cos(phi)
        positions[i * 3 + 1] = r * Math.sin(phi)
        positions[i * 3 + 2] = (random() - 0.5) * 0.06 * (1 - r * 0.6)
        colour.copy(old).lerp(young, THREE.MathUtils.clamp(r * 1.3, 0, 1))
      }
      const brightness = 0.3 + random() ** 2
      colors[i * 3] = colour.r * brightness
      colors[i * 3 + 1] = colour.g * brightness
      colors[i * 3 + 2] = colour.b * brightness
    }
    const points = pointCloud(positions, colors, 0.028, 0.8)
    group.add(points)
    disposables.push(points.geometry, points.material as THREE.Material)
    fading.push({ material: points.material as THREE.PointsMaterial, base: 0.8 })
  }

  /**
   * A black hole: the shadow, the photon ring, and an accretion disc.
   *
   * The node radius is the Schwarzschild radius, so the shadow is drawn at 2.6 r_s —
   * the apparent size of the horizon to a distant observer, which is the thing an
   * image of one actually shows. No lensing: this is a schematic, and a wrong lensing
   * model would be a worse claim than none.
   */
  private buildBlackHole(
    group: THREE.Group,
    disposables: { dispose: () => void }[],
    fading: Proxy['fading'],
  ): void {
    const shadowGeometry = new THREE.SphereGeometry(2.6, 48, 24)
    const shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 })
    group.add(new THREE.Mesh(shadowGeometry, shadowMaterial))
    disposables.push(shadowGeometry, shadowMaterial)

    const ringGeometry = new THREE.RingGeometry(2.7, 3.1, 160, 1)
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xffe2b0,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const photonRing = new THREE.Mesh(ringGeometry, ringMaterial)
    group.add(photonRing)
    disposables.push(ringGeometry, ringMaterial)
    fading.push({ material: ringMaterial, base: 0.9 })

    const discGeometry = new THREE.RingGeometry(3.4, 13, 220, 1)
    // Colour the disc by radius: the inner edge is the hottest material in the galaxy.
    const colors = new Float32Array(discGeometry.attributes.position.count * 3)
    const position = discGeometry.attributes.position
    const inner = new THREE.Color('#fff4e0')
    const outer = new THREE.Color('#ff7a2a')
    const colour = new THREE.Color()
    const v = new THREE.Vector3()
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i)
      colour.copy(inner).lerp(outer, THREE.MathUtils.clamp((v.length() - 3.4) / 9.6, 0, 1))
      colors[i * 3] = colour.r
      colors[i * 3 + 1] = colour.g
      colors[i * 3 + 2] = colour.b
    }
    discGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const discMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.62,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const disc = new THREE.Mesh(discGeometry, discMaterial)
    disc.rotation.x = Math.PI / 2.35
    group.add(disc)
    disposables.push(discGeometry, discMaterial)
    fading.push({ material: discMaterial, base: 0.62 })
  }
}
