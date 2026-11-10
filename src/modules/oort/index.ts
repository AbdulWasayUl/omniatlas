import * as THREE from 'three'
import type { AtlasModule, Engine, FrameContext, SceneNodeHandle } from '../../core/Engine'
import { AU_M, PC_M, type Vec3d, vec3d } from '../../core/world'
import { type KeplerianElements, sampleOrbit } from '../../astronomy/orbit'
import { assetUrl } from '../../data/assetUrl'
import { OORT_REACHING_APHELION_AU } from '../../data/constants'
import { spanVisibility } from '../../core/render/spanFade'

/**
 * The Oort cloud: the one structure in this atlas nobody has ever seen.
 *
 * ## The claim, stated carefully
 *
 * No object has ever been observed IN the Oort cloud. Not one. Everything known about
 * it comes from the handful of bodies that fell OUT of it, into the few tens of AU
 * where a telescope can reach, and from the shape of their orbits once they got there.
 * The cloud is an inference from those orbits and nothing else, and it has been one
 * since Oort made it in 1950.
 *
 * So this rung draws the inference and the evidence as two visibly different things:
 *
 * - The SHELL is an illustration. A seeded point cloud between 2,000 and 100,000 AU,
 *   isotropic, with the density falling off as r^-3.5 that the standard picture
 *   assumes. Every one of those points is invented. The count is a drawing decision
 *   and the radii are a model; neither is a catalogue and the inspector says so.
 *
 * - The ORBITS are measurements. Twenty-six bodies in the atlas's own small-body
 *   catalogue have aphelia beyond 500 AU — long-period comets reaching as far as
 *   94,133 AU, plus Sedna, Leleākūhonua and Alicanto, whose perihelia sit far outside
 *   Neptune's reach. Those are real orbit solutions from JPL, drawn at the distances
 *   they actually reach.
 *
 * ## Why the orbits are the point
 *
 * They are not decoration around the shell, they are the argument FOR it. Two features
 * of this set are the whole case:
 *
 *   - the aphelia pile up in the thousands-to-tens-of-thousands of AU, which says
 *     there is a reservoir out there rather than a scatter of one-off visitors;
 *   - the inclinations are all over the sky — 11, 40, 62, 95, 104, 162 degrees — where
 *     everything that formed in the disc orbits within a few degrees of it. An
 *     isotropic set of incoming orbits is what makes the cloud a SPHERE rather than a
 *     belt, and it is visible here directly: the orbits go every way.
 *
 * Drawing the shell without them would be asserting a conclusion. Drawing them is
 * showing the reader the data the conclusion rests on, which is the entire point of
 * the project.
 *
 * ## What this does not claim
 *
 * That the shell's inner and outer radii are known (they are not: 2,000 and 100,000 AU
 * are round numbers from a range of published estimates spanning a factor of several),
 * that its density profile is measured (it is assumed), or that its total mass or
 * population is anything but an order-of-magnitude guess.
 */

/** Parsecs, because the outer cloud is half of one and the stellar layer's unit is right. */
const LAYER = 'stellar' as const
/** The orbital elements are heliocentric J2000 ecliptic, which is not the layer's frame. */
const ELEMENTS_FRAME = 'ecliptic' as const
const DATA = '/data/smallbodies/named.json'

/**
 * Beyond this aphelion a body is reaching into, or out of, the Oort region.
 *
 * Shared with `smallbodies`, which uses the same line to decide what to keep a node
 * for. The two must not disagree: see `loadEvidence`.
 */
const OORT_REACHING_AU = OORT_REACHING_APHELION_AU

/**
 * The shell's inner and outer radii, AU.
 *
 * Round numbers off a range of published estimates that disagree by a factor of
 * several — the inner edge is variously put at 2,000 to 20,000 AU and the outer at
 * 50,000 to 200,000. Nothing here is measured, and the shape of the fade at both ends
 * is doing the honest work: there is no edge, and drawing a crisp one would invent the
 * one property of this object most obviously unknown.
 */
const INNER_AU = 2_000
const OUTER_AU = 100_000

/**
 * Points in the illustrated shell.
 *
 * A drawing decision, not an estimate. The real population is guessed at somewhere
 * around 1e12 bodies, which is six orders of magnitude more than any renderer will
 * draw and seven more than is useful to look at.
 */
const SHELL_POINTS = 24_000

/** Density ~ r^-3.5, the exponent the standard picture assumes. Sampled by inversion. */
const DENSITY_EXPONENT = 3.5

interface SmallBodyElements {
  epochJdTdb: number
  aAu: number
  e: number
  iDeg: number
  omDeg: number
  wDeg: number
  maDeg: number
  adAu: number
  periodYr: number
}

interface SmallBody {
  id: string
  name?: string | null
  fullName?: string
  orbitClass?: string
  elements?: SmallBodyElements
}

/** mulberry32, the same PRNG the galaxy field and the asteroid belt use. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class OortModule implements AtlasModule {
  readonly id = 'oort'
  private engine!: Engine
  private readonly nodeIds: string[] = []
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  /** Ids of the bodies whose orbits are drawn; `smallbodies` owns their nodes. */
  private drawnBodyIds: string[] = []
  private shell: THREE.Points | null = null
  private orbits: THREE.LineSegments | null = null
  private shellMaterial: THREE.PointsMaterial | null = null
  private orbitMaterial: THREE.LineBasicMaterial | null = null
  private readonly scratchLocal = new THREE.Vector3()
  private readonly scratchWorld: Vec3d = vec3d()

  readonly manifest = {
    shellPoints: 0,
    orbitsDrawn: 0,
    /** Orbits whose body is not in the registry. Must be zero; see `loadEvidence`. */
    orbitsWithoutNode: 0,
    farthestAphelionAu: 0,
    /** Spread of orbital inclinations, degrees. The case for a sphere rather than a belt. */
    inclinationRange: [0, 0] as [number, number],
  }

  async init(engine: Engine): Promise<void> {
    this.engine = engine
    this.buildShell()
    this.registerCloud()
    await this.loadEvidence()
    const m = this.manifest
    console.info(
      `[omniatlas] oort: ${m.shellPoints} illustrated points, ` +
        `${m.orbitsDrawn} measured orbits reaching past ${OORT_REACHING_AU} AU ` +
        `(farthest aphelion ${Math.round(m.farthestAphelionAu).toLocaleString()} AU, ` +
        `inclinations ${m.inclinationRange[0].toFixed(0)}-${m.inclinationRange[1].toFixed(0)} degrees)`,
      m,
    )
  }

  // -------------------------------------------------------------------------
  // The inference
  // -------------------------------------------------------------------------

  /**
   * The shell, as an isotropic seeded point cloud.
   *
   * Sampled by inversion from `r^-3.5`: pick a uniform number, invert the cumulative
   * distribution, get a radius. Directions are uniform ON THE SPHERE, which means
   * sampling `cos(theta)` uniformly rather than `theta` — the lazy version piles points
   * at the poles and would draw a cloud with two lumps in it that no model predicts.
   *
   * Seeded, so the cloud is identical on every visit and in every shared link. An
   * illustration that reshuffles itself is a worse illustration, not a more honest one.
   */
  private buildShell(): void {
    const random = mulberry32(0x0012_0750)
    const positions = new Float32Array(SHELL_POINTS * 3)
    const sizes = new Float32Array(SHELL_POINTS)
    const inner = INNER_AU * AU_M
    const outer = OUTER_AU * AU_M
    // For a number density n(r) ~ r^-a, the count inside r goes as r^(3-a): the
    // volume element contributes the r^2. Using (1 - a) instead — which is what this
    // did first — samples n(r) ~ r^-5.5 and draws a tight ball with a wisp around it
    // rather than a cloud.
    const power = 3 - DENSITY_EXPONENT

    const innerPow = inner ** power
    const outerPow = outer ** power
    for (let i = 0; i < SHELL_POINTS; i++) {
      const u = random()
      const radius = (innerPow + u * (outerPow - innerPow)) ** (1 / power)
      // Uniform on the sphere: cos(theta) uniform in [-1, 1], phi uniform in [0, 2pi).
      const cosTheta = random() * 2 - 1
      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta))
      const phi = random() * Math.PI * 2
      const metres = radius
      this.scratchWorld.x = sinTheta * Math.cos(phi) * metres
      this.scratchWorld.y = sinTheta * Math.sin(phi) * metres
      this.scratchWorld.z = cosTheta * metres
      const layer = this.engine.layer(LAYER)
      layer.toLocal(this.scratchLocal, this.scratchWorld, ELEMENTS_FRAME)
      positions[i * 3] = this.scratchLocal.x
      positions[i * 3 + 1] = this.scratchLocal.y
      positions[i * 3 + 2] = this.scratchLocal.z
      sizes[i] = 0.4 + random() * 0.6
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('aScale', new THREE.BufferAttribute(sizes, 1))
    const material = new THREE.PointsMaterial({
      color: 0x8fb3d9,
      size: 0.0016,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const points = new THREE.Points(geometry, material)
    points.name = 'oort:shell'
    points.frustumCulled = false
    points.renderOrder = -6
    this.engine.layer(LAYER).scene.add(points)

    this.shell = points
    this.shellMaterial = material
    this.geometries.push(geometry)
    this.materials.push(material)
    this.manifest.shellPoints = SHELL_POINTS
  }

  private registerCloud(): void {
    const node: SceneNodeHandle & { provenance: string; provenanceNote: string; caveat: string } = {
      id: 'oort:cloud',
      name: 'Oort cloud',
      // The Sun's own position: this is a shell around it, and its centre is the only
      // point of it anybody can name.
      worldPosition: vec3d(),
      frame: ELEMENTS_FRAME,
      // Not measured, and not nearly. The radius it is DRAWN at is a round number off
      // a range of estimates spanning a factor of several.
      radiusMetres: 0,
      framingRadiusMetres: OUTER_AU * AU_M,
      layer: LAYER,
      objectClass: 'region',
      parentId: null,
      provenance: 'illustration',
      caveat:
        'No object has ever been observed in the Oort cloud. Everything known about it is ' +
        'inferred from the orbits of the bodies that have fallen out of it — the long-period ' +
        'comets drawn here, whose aphelia reach tens of thousands of AU and whose inclinations ' +
        'cover the whole sky.',
      provenanceNote:
        `The shell is drawn between ${INNER_AU.toLocaleString()} and ${OUTER_AU.toLocaleString()} AU ` +
        `with density falling as r^-${DENSITY_EXPONENT}. Those are round numbers from a range of ` +
        `published estimates that disagree by a factor of several, and the profile is an assumption, ` +
        `not a measurement — one that puts about two thirds of the cloud inside 10,000 AU, so what you ` +
        `are looking at is far denser at the middle than at the edge. The ${SHELL_POINTS.toLocaleString()} points are a drawing decision: the ` +
        `real population is guessed at around a trillion bodies.`,
    }
    this.engine.register(node)
    this.nodeIds.push(node.id)
  }

  // -------------------------------------------------------------------------
  // The evidence
  // -------------------------------------------------------------------------

  /**
   * Every catalogued orbit that reaches past 500 AU, drawn where it actually goes.
   *
   * Reads the same file the small-bodies module does. That module ranks by notability
   * and keeps 160, which is right for the inner system and drops almost all of these:
   * of the twenty-six bodies out here, it registers five. The rest are the most
   * distant orbits in the atlas and had nothing drawn for them at all.
   */
  private async loadEvidence(): Promise<void> {
    let payload: { objects?: SmallBody[] } | null = null
    try {
      const response = await fetch(assetUrl(DATA))
      if (response.ok) payload = (await response.json()) as { objects?: SmallBody[] }
    } catch {
      payload = null
    }
    if (this.engine.isDisposed) return
    if (!payload?.objects?.length) {
      console.warn('[omniatlas] small-body catalogue unavailable; the Oort evidence will not be drawn')
      return
    }

    const reaching = payload.objects.filter(
      (object) => Number.isFinite(object.elements?.adAu) && (object.elements as SmallBodyElements).adAu > OORT_REACHING_AU,
    )
    if (reaching.length === 0) return

    const layer = this.engine.layer(LAYER)
    const points: number[] = []
    let lowestInclination = Infinity
    let highestInclination = -Infinity

    for (const object of reaching) {
      const e = object.elements as SmallBodyElements
      if (!(e.aAu > 0) || !(e.periodYr > 0)) continue
      const elements: KeplerianElements = {
        semiMajorAxisKm: (e.aAu * AU_M) / 1000,
        eccentricity: e.e,
        inclinationDeg: e.iDeg,
        nodeDeg: e.omDeg,
        periapsisDeg: e.wDeg,
        meanAnomalyDegAtEpoch: e.maDeg,
        epoch: new Date((e.epochJdTdb - 2440587.5) * 86_400_000),
        periodDays: e.periodYr * 365.25,
      }

      // 512 samples, uniform in eccentric anomaly. Uniform in TIME would spend every
      // vertex within a few AU of aphelion and draw a 94,000 AU orbit as a dot.
      const samples = sampleOrbit(elements, 512)
      let drawn = 0
      for (let i = 0; i < samples.length - 1; i++) {
        const a = this.toLocal(layer, samples[i])
        const b = this.toLocal(layer, samples[i + 1])
        if (!a || !b) continue
        points.push(a[0], a[1], a[2], b[0], b[1], b[2])
        drawn++
      }
      if (drawn === 0) continue

      this.manifest.orbitsDrawn++
      this.manifest.farthestAphelionAu = Math.max(this.manifest.farthestAphelionAu, e.adAu)
      lowestInclination = Math.min(lowestInclination, e.iDeg)
      highestInclination = Math.max(highestInclination, e.iDeg)

    }

    // Drawn implies clickable — but NOT by registering anything here. Module init runs
    // concurrently (`Engine.loadModules` uses Promise.allSettled), so a node this
    // module and `smallbodies` both wanted would go to whichever won the race, and the
    // first version of this did exactly that: it took Sedna and filed it as a comet
    // with no radius. Ownership belongs in one place, so `smallbodies` keeps every body
    // past OORT_REACHING_APHELION_AU regardless of its notability cap, and this module
    // only draws the paths. `update` checks that the two agree.
    if (points.length === 0) return
    this.manifest.inclinationRange = [lowestInclination, highestInclination]
    this.drawnBodyIds = reaching.map((object) => object.id)

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3))
    const material = new THREE.LineBasicMaterial({
      color: 0x7fd4c4,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    })
    const lines = new THREE.LineSegments(geometry, material)
    lines.name = 'oort:orbits'
    lines.frustumCulled = false
    lines.renderOrder = -5
    layer.scene.add(lines)

    this.orbits = lines
    this.orbitMaterial = material
    this.geometries.push(geometry)
    this.materials.push(material)
  }

  /** Orbit sample (km, ecliptic) to layer-local units; null if the maths went bad. */
  private toLocal(layer: ReturnType<Engine['layer']>, point: Vec3d): [number, number, number] | null {
    this.scratchWorld.x = point.x * 1000
    this.scratchWorld.y = point.y * 1000
    this.scratchWorld.z = point.z * 1000
    layer.toLocal(this.scratchLocal, this.scratchWorld, ELEMENTS_FRAME)
    const { x, y, z } = this.scratchLocal
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
    return [x, y, z]
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /**
   * How many drawn orbits have no body in the registry. Must be zero.
   *
   * Checked every frame rather than once at init, because `smallbodies` may still have
   * been loading when this module finished: concurrent init means the registry is not
   * complete until the first frame, and an assertion made before then is meaningless.
   */
  update(): void {
    if (this.drawnBodyIds.length === 0) return
    let missing = 0
    for (const id of this.drawnBodyIds) if (!this.engine.registry.has(id)) missing++
    this.manifest.orbitsWithoutNode = missing
  }

  preRender(ctx: FrameContext): void {
    const layer = this.engine.layer(LAYER)
    // The cloud is about a light-year across. Inside the planets it is the whole sky
    // and says nothing; out past the nearest stars it is a dot.
    const visibility = spanVisibility(ctx.viewSpanMetres, OUTER_AU * 2 * AU_M)
    if (this.shell && this.shellMaterial) {
      this.shell.visible = visibility > 0.004
      this.shellMaterial.opacity = 0.5 * visibility * layer.renderOpacity
    }
    if (this.orbits && this.orbitMaterial) {
      this.orbits.visible = visibility > 0.004
      this.orbitMaterial.opacity = 0.4 * visibility * layer.renderOpacity
    }
  }

  dispose(): void {
    this.shell?.removeFromParent()
    this.orbits?.removeFromParent()
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
    this.geometries.length = 0
    this.materials.length = 0
    this.drawnBodyIds.length = 0
    this.shell = null
    this.orbits = null
    for (const id of this.nodeIds) this.engine?.unregister(id)
    this.nodeIds.length = 0
  }
}

/** Exported for the test, which checks the shell is a shell and not a ball. */
export const OORT_SHELL_BOUNDS = { innerAu: INNER_AU, outerAu: OUTER_AU, points: SHELL_POINTS, pcPerAu: AU_M / PC_M }
