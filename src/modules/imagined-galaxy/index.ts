import * as THREE from 'three'
import type { AtlasModule, Engine, FrameContext, SceneNodeHandle } from '../../core/Engine'
import { type Vec3d, convertFrame, vec3d } from '../../core/world'
import {
  type GeneratedGalaxy,
  type GeneratedLandmark,
  galaxyStarField,
  type InteriorForm,
  generateInterior,
  publishedMorphology,
  shapeFromMorphology,
} from '../../generators/galaxy'

/**
 * Standing inside a galaxy nobody has ever stood inside.
 *
 * The atlas draws 950 galaxies, 216 clusters and 71 nebulae, and every one of them was a
 * point or an ellipse you could look at and not enter. That is the honest state of the
 * measurement: nobody has resolved the stars in most of these. Immersive mode is where
 * the atlas is allowed to imagine one, and this module is what it imagines.
 *
 * Everything here is INVENTED, it is off unless the viewer asks for it, and every node it
 * registers says so. The arrangement is the same bargain the system generator makes: the
 * host's measured size sets the scale, and the seed does the rest, so M51 has the same
 * arms and the same named places every time anyone opens it.
 *
 * ## Why this needs its own layer
 *
 * `galactic` has the right unit and the wrong origin. It is fixed on the Sun and reaches
 * a megaparsec, so inside M51 it is centred on nothing useful and asked to hold kiloparsec
 * detail against a number eight million times larger. `galaxyInterior` is anchor-local
 * and this module owns its origin, exactly as `imagined` works for planetary systems.
 */

const LAYER = 'galaxyInterior' as const
const FRAME = 'icrf' as const
const KPC_M = 3.0856775814913673e19

/** Classes that have an inside worth imagining. */
const EXPLORABLE = new Set(['galaxy', 'nebula', 'cluster'])

const STAR_VERTEX = /* glsl */ `
  attribute vec3 starOffset;   // kiloparsecs, in the galaxy's frame
  attribute float starSeed;    // 0..1, for colour and brightness variation

  uniform float uPixelWidth;
  uniform float uPixelHeight;
  uniform float uTanHalfFov;
  uniform float uFade;
  uniform float uCoreRadius;

  varying float vIntensity;
  varying vec3 vColor;
  varying vec2 vQuad;

  void main() {
    vQuad = position.xy;
    vec4 viewPosition = modelViewMatrix * vec4(starOffset, 1.0);
    if (viewPosition.z > -1e-6) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    float d = max(length(viewPosition.xyz), 1e-5);

    // Old and red towards the middle, young and blue out in the arms: the one piece of
    // colour structure a galaxy has that a viewer will recognise without being told.
    float r = length(starOffset.xy) / max(uCoreRadius, 1e-4);
    float youth = clamp(r * 0.55 + starSeed * 0.45, 0.0, 1.0);
    vColor = mix(vec3(1.0, 0.80, 0.55), vec3(0.72, 0.82, 1.0), youth);

    // Constant screen size, so the cloud reads as stars rather than as a textured blob
    // whichever distance it is seen from. Brightness is NOT constant: it falls off hard
    // enough that the stars near wherever you are standing stand out from the rest of
    // the galaxy behind them. A near-flat falloff made every star in the disc equally
    // dim, so standing at a place inside the galaxy looked like standing outside it in
    // empty space.
    float radiusPx = mix(0.9, 2.1, starSeed);
    float near = 1.0 / (1.0 + d * d * 0.06);
    vIntensity = uFade * mix(0.35, 1.0, starSeed) * (0.22 + 1.9 * near);

    vec4 clip = projectionMatrix * viewPosition;
    // The viewport's OWN width. A hardcoded 1.6 here stretched every billboard
    // vertically by 1.6/aspect, which on a square-ish canvas is about 1.45 and turns
    // every glow in the atlas into an egg.
    clip.xy += position.xy * (2.0 * radiusPx / vec2(uPixelWidth, uPixelHeight)) * clip.w;
    gl_Position = clip;
  }
`

const STAR_FRAGMENT = /* glsl */ `
  varying float vIntensity;
  varying vec3 vColor;
  varying vec2 vQuad;

  void main() {
    float r2 = dot(vQuad, vQuad);
    if (r2 > 1.0) discard;
    // Falls to exactly zero at the quad's rim. A bare exponential is still 5 per cent of
    // peak where the quad is cut, and that leaves a visible circular seam on every point.
    float fall = (exp(-3.0 * r2) - 0.0498) / 0.9502;
    gl_FragColor = vec4(vColor * vIntensity * max(fall, 0.0), 1.0);
  }
`

const GLOW_VERTEX = /* glsl */ `
  uniform float uPixelWidth;
  uniform float uPixelHeight;
  uniform float uTanHalfFov;
  uniform float uRadiusKpc;
  uniform float uFade;
  varying vec2 vQuad;
  varying float vFade;

  void main() {
    vQuad = position.xy;
    vFade = uFade;
    vec4 viewPosition = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    if (viewPosition.z > -1e-6) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    float d = max(length(viewPosition.xyz), 1e-5);
    // Real angular size, with a floor so a distant landmark is still a visible mark
    // rather than disappearing between pixels.
    float extentPx = (uRadiusKpc / d) / uTanHalfFov * uPixelHeight * 0.5;
    float radiusPx = max(extentPx, 3.0);
    vec4 clip = projectionMatrix * viewPosition;
    clip.xy += position.xy * (2.0 * radiusPx / vec2(uPixelWidth, uPixelHeight)) * clip.w;
    gl_Position = clip;
  }
`

const GLOW_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying vec2 vQuad;
  varying float vFade;

  void main() {
    float r2 = dot(vQuad, vQuad);
    if (r2 > 1.0) discard;
    // Clouds and crowds, not discs with edges. The subtraction is what makes that true:
    // exp(-2.2) is still eleven per cent of peak at the rim, so the old falloff gave
    // every landmark a hard elliptical outline and turned a nebula into a pastel egg.
    float fall = (exp(-3.4 * r2) - 0.0334) / 0.9666;
    gl_FragColor = vec4(uColor * max(fall, 0.0) * uIntensity * vFade, 1.0);
  }
`

/** `ngc:NGC5194` and `ungc:ngc5194` both reduce to NGC5194. */
function designationKey(id: string): string | null {
  const body = id.slice(id.indexOf(':') + 1)
  const match = /^(NGC|IC|UGCA|UGC|PGC|DDO|ESO|MESSIER)[\s_-]*0*(\d+[A-Za-z]*(?:-\d+)?)$/i.exec(body)
  return match ? `${match[1].toUpperCase()}${match[2].toUpperCase()}` : null
}

interface LandmarkEntry {
  landmark: GeneratedLandmark
  node: SceneNodeHandle
  mesh: THREE.Mesh
}

interface ImaginedGalaxyNode extends SceneNodeHandle {
  provenance: 'illustration'
  provenanceNote: string
  caveat: string
}

export class ImaginedGalaxyModule implements AtlasModule {
  readonly id = 'imagined-galaxy'
  private engine!: Engine
  private builtFor: string | null = null
  private galaxy: GeneratedGalaxy | null = null
  private hostNode: SceneNodeHandle | null = null
  private cloud: THREE.Mesh | null = null
  private quad: THREE.BufferGeometry | null = null
  private readonly landmarks = new Map<string, LandmarkEntry>()
  private readonly materials: THREE.ShaderMaterial[] = []
  private readonly hostWorld = vec3d()
  private readonly scratch = vec3d()
  private readonly local = new THREE.Vector3()

  init(engine: Engine): void {
    this.engine = engine
    this.quad = new THREE.BufferGeometry()
    this.quad.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    )
    this.quad.setIndex([0, 1, 2, 0, 2, 3])
  }

  update(ctx: FrameContext): void {
    const wanted = this.engine.immersive ? this.host(ctx) : null
    if (wanted !== this.builtFor) {
      this.teardown()
      if (wanted) this.build(wanted)
    }
    if (!this.galaxy || !this.hostNode) return
    this.place(ctx)
  }

  /** The generated galaxy currently standing, for the stats panel. */
  current(): GeneratedGalaxy | null {
    return this.galaxy
  }

  /**
   * Which galaxy the camera is in, if any.
   *
   * Reads the anchor and the body being left, so a flight between two landmarks of one
   * galaxy does not tear the galaxy down halfway across. The Milky Way is excluded: it
   * has real contents, and inventing a second set inside it is the one case where a
   * generated place could be taken for a measured one.
   */
  private host(ctx: FrameContext): string | null {
    for (const id of [this.engine.anchorId, ctx.transitFromId]) {
      if (!id) continue
      const hostId = id.startsWith('gen:') ? id.slice(4).split('/')[0] : id
      if (hostId === 'milky-way' || hostId === 'galactic-centre') continue
      const node = this.engine.node(hostId)
      if (node && EXPLORABLE.has(node.objectClass) && node.radiusMetres > 0) return hostId
    }
    return null
  }

  private build(hostId: string): void {
    const host = this.engine.node(hostId)
    if (!host) return
    this.builtFor = hostId
    this.hostNode = host
    const layer = this.engine.layer(LAYER)
    const form: InteriorForm =
      host.objectClass === 'galaxy' ? 'galaxy' : host.objectClass === 'cluster' ? 'cluster' : 'nebula'
    const galaxy = generateInterior(hostId, host.radiusMetres, form, shapeFromMorphology(this.morphologyFor(host)))
    this.galaxy = galaxy
    layer.setOrigin(host.worldPosition, host.frame, hostId)

    // The star cloud.
    const field = galaxyStarField(galaxy)
    const seeds = new Float32Array(galaxy.starCount)
    for (let i = 0; i < galaxy.starCount; i++) seeds[i] = ((i * 2654435761) % 1000) / 1000

    const geometry = new THREE.InstancedBufferGeometry()
    geometry.index = this.quad!.index
    geometry.setAttribute('position', this.quad!.getAttribute('position'))
    geometry.setAttribute('starOffset', new THREE.InstancedBufferAttribute(field, 3))
    geometry.setAttribute('starSeed', new THREE.InstancedBufferAttribute(seeds, 1))
    geometry.instanceCount = galaxy.starCount

    const cloudMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uPixelWidth: { value: 1920 },
        uPixelHeight: { value: 1080 },
        uTanHalfFov: { value: 0.466 },
        uFade: { value: 1 },
        uCoreRadius: { value: galaxy.radiusKpc },
      },
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    })
    this.materials.push(cloudMaterial)
    const cloud = new THREE.Mesh(geometry, cloudMaterial)
    cloud.frustumCulled = false
    cloud.renderOrder = -6
    cloud.name = `gen:cloud:${hostId}`
    layer.scene.add(cloud)
    this.cloud = cloud

    for (const landmark of galaxy.landmarks) this.addLandmark(landmark, hostId)

    console.info(
      `[omniatlas] imagined interior of ${host.name} (${form}): ${galaxy.description.split('.')[0]}, ` +
        `${galaxy.radiusKpc < 0.1 ? `${(galaxy.radiusKpc * 1000).toFixed(1)} pc` : `${galaxy.radiusKpc.toFixed(1)} kpc`}, ` +
        `${galaxy.starCount.toLocaleString('en-GB')} stars, ${galaxy.landmarks.length} places`,
    )
  }

  /**
   * The host's morphological type, from the host or from its twin in another catalogue.
   *
   * The Whirlpool is in the atlas twice: `ngc:NGC5194` from OpenNGC, which records no
   * type, and `ungc:ngc5194` from the Local Volume catalogue, which does. Generated
   * from the first alone it came out elliptical, which is wrong in a way a reader
   * notices at once. The two rows describe the same galaxy and agree on a designation,
   * so the type is there to be found; it is just not on the node that was anchored.
   */
  private morphologyFor(host: SceneNodeHandle): number | undefined {
    const published = publishedMorphology(host.id)
    if (typeof published === 'number') return published
    if (typeof host.morphologyT === 'number') return host.morphologyT
    const key = designationKey(host.id)
    if (!key) return undefined
    for (const node of this.engine.registry.values()) {
      if (typeof node.morphologyT !== 'number' || node.id === host.id) continue
      if (designationKey(node.id) === key) return node.morphologyT
    }
    return undefined
  }

  private addLandmark(landmark: GeneratedLandmark, hostId: string): void {
    const layer = this.engine.layer(LAYER)
    const colour = new THREE.Color(landmark.color)
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelWidth: { value: 1920 },
        uPixelHeight: { value: 1080 },
        uTanHalfFov: { value: 0.466 },
        uRadiusKpc: { value: landmark.radiusKpc },
        uColor: { value: new THREE.Vector3(colour.r, colour.g, colour.b) },
        uIntensity: { value: landmark.intensity },
        uFade: { value: 1 },
      },
      vertexShader: GLOW_VERTEX,
      fragmentShader: GLOW_FRAGMENT,
      transparent: true,
      blending: landmark.kind === 'void' ? THREE.NormalBlending : THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    })
    this.materials.push(material)
    const mesh = new THREE.Mesh(this.quad!, material)
    mesh.frustumCulled = false
    mesh.renderOrder = landmark.kind === 'void' ? -5 : -4
    mesh.name = `gen:${landmark.id}`
    layer.scene.add(mesh)

    const node: ImaginedGalaxyNode = {
      id: `gen:${landmark.id}`,
      worldPosition: vec3d(),
      frame: FRAME,
      radiusMetres: landmark.radiusKpc * KPC_M,
      layer: LAYER,
      objectClass:
        landmark.kind === 'cluster'
          ? 'cluster'
          : landmark.kind === 'core'
            ? 'region'
            : landmark.kind === 'member' || landmark.kind === 'pulsar'
              ? 'star'
              : 'nebula',
      name: landmark.name,
      parentId: hostId,
      provenance: 'illustration',
      caveat: landmark.description,
      provenanceNote:
        `Invented, not observed. ${this.hostNode?.name ?? 'This galaxy'} is real and its size is ` +
        'measured; nothing inside it here is. The arrangement was generated from the ' +
        'galaxy’s own catalogue identifier, so it is the same arrangement for everyone, ' +
        'every time.',
    }
    this.engine.register(node)
    this.landmarks.set(landmark.id, { landmark, node, mesh })
  }

  private place(ctx: FrameContext): void {
    const layer = this.engine.layer(LAYER)
    const host = this.hostNode
    if (!host) return
    convertFrame(this.hostWorld, host.worldPosition, host.frame, FRAME)

    // Follow the anchor, as `system` and `surface` do: the engine waives a layer's
    // distance band only while its `anchorId` matches the camera's, and the precision is
    // better measured from whatever the viewer is standing next to.
    const anchored = this.engine.anchorId
    const entry = anchored?.startsWith('gen:') ? this.landmarks.get(anchored.slice(4)) : undefined
    const originWorld = entry ? this.landmarkWorld(entry.landmark, this.scratch) : this.hostWorld
    layer.setOrigin(originWorld, FRAME, anchored ?? this.builtFor)

    for (const { landmark, node, mesh } of this.landmarks.values()) {
      this.landmarkWorld(landmark, node.worldPosition)
      layer.toLocal(this.local, node.worldPosition, FRAME)
      mesh.position.copy(this.local)
    }
    if (this.cloud) {
      layer.toLocal(this.local, this.hostWorld, FRAME)
      this.cloud.position.copy(this.local)
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    for (const material of this.materials) {
      material.uniforms.uPixelWidth.value = ctx.width * dpr
      material.uniforms.uPixelHeight.value = ctx.height * dpr
      material.uniforms.uTanHalfFov.value = Math.tan((ctx.fovDegrees * Math.PI) / 360)
    }
  }

  /** A landmark's world position: the galaxy's, plus its offset in kiloparsecs. */
  private landmarkWorld(landmark: GeneratedLandmark, out: Vec3d): Vec3d {
    out.x = this.hostWorld.x + landmark.x * KPC_M
    out.y = this.hostWorld.y + landmark.y * KPC_M
    out.z = this.hostWorld.z + landmark.z * KPC_M
    return out
  }

  private teardown(): void {
    const layer = this.engine.layer(LAYER)
    const had = this.builtFor !== null
    for (const { node, mesh } of this.landmarks.values()) {
      this.engine.unregister(node.id)
      mesh.removeFromParent()
    }
    this.landmarks.clear()
    if (this.cloud) {
      this.cloud.removeFromParent()
      this.cloud.geometry.dispose()
      this.cloud = null
    }
    for (const material of this.materials) material.dispose()
    this.materials.length = 0
    if (had) layer.setOrigin(vec3d(), layer.config.frame, null)
    this.galaxy = null
    this.hostNode = null
    this.builtFor = null
  }

  dispose(): void {
    this.teardown()
    this.quad?.dispose()
    this.quad = null
  }
}
