import * as THREE from 'three'
import type { AtlasModule, Engine, FrameContext, SceneNodeHandle } from '../../core/Engine'
import { AU_M, type Vec3d, convertFrame, sphericalToCartesian, vec3d } from '../../core/world'
import { spanVisibility } from '../../core/render/spanFade'

/**
 * The heliosphere: the bubble the solar wind blows in the interstellar medium.
 *
 * ## What is actually known
 *
 * Four numbers. Two spacecraft have crossed these boundaries, each one twice, and
 * every one of those crossings happened at a single point on a surface that wraps the
 * whole sky:
 *
 *     Voyager 1  termination shock  2004-12-16   94 AU   30 deg from the nose
 *     Voyager 2  termination shock  2007-08-30   84 AU   54 deg from the nose
 *     Voyager 1  heliopause         2012-08-25  121.6 AU 30 deg from the nose
 *     Voyager 2  heliopause         2018-11-05  119.0 AU 54 deg from the nose
 *
 * That is the entire in-situ record of where this object is. Everything else drawn
 * here is a model, and the model is not very good: see `FIT` below.
 *
 * ## Why the surface is drawn the way it is
 *
 * As a wireframe, faded by how far each part of it sits from a place a spacecraft
 * actually went. A smooth shaded bubble would be the wrong picture — it would look
 * like a photograph of a thing, and this is a surface known at four points and
 * extrapolated over four pi steradians. The grid says "model" the way a solid surface
 * cannot, and the confidence fade says WHERE the model is anchored: bright along the
 * two Voyager bearings, ghostly across the whole tail, which no instrument has ever
 * been near.
 *
 * ## The shape, and why it is wrong
 *
 * The form is the classic axisymmetric one about the interstellar-wind axis,
 * `r(theta) = rNose * sqrt(2 / (1 + cos theta))`: a blunt nose into the wind, opening
 * into a tail downstream. It is fitted to Voyager 1 and nothing else, because fitting
 * it to both Voyagers is not possible — which is the interesting part.
 *
 * Voyager 2 crossed the heliopause FURTHER from the nose and CLOSER to the Sun than
 * Voyager 1 did. An axisymmetric surface cannot do that: r must grow with theta. So
 * the model fitted to Voyager 1 puts the heliopause at about 132 AU along Voyager 2's
 * bearing, where Voyager 2 measured 119.0. The 13 AU it misses by is not noise in the
 * measurement, it is the shape being wrong — the southern heliosphere is pushed in,
 * most likely by the interstellar magnetic field, and no nose-aligned model of this
 * kind can express that.
 *
 * The residual is computed here rather than quoted, and it is in the inspector. A
 * model that is visibly wrong by a stated amount is worth more than a prettier one
 * that hides it.
 *
 * ## Honesty
 *
 * The four crossings are MEASURED: date, heliocentric distance, and the instrument
 * that saw it. Both surfaces are DERIVED and say so. Nothing here is illustration —
 * there is no invention, only a model with its error reported.
 */

const LAYER = 'helio' as const
/** Where the spacecraft schematics are drawn; see `addSpacecraft` for why not `helio`. */
const CRAFT_LAYER = 'system' as const
const FRAME = 'ecliptic' as const

/**
 * Where the interstellar wind comes from, in ecliptic longitude and latitude.
 *
 * IBEX neutral-helium inflow, Swaczyna et al. (2023), ApJ 953, 107. The heliosphere's
 * nose points into this; the whole axisymmetric form below is built about it.
 */
const NOSE_LON_DEG = 255.7
const NOSE_LAT_DEG = 5.04

/**
 * A boundary crossing: one spacecraft, one surface, one instant, one distance.
 *
 * `raDeg`/`decDeg` are the spacecraft's escape asymptote rather than its exact
 * position on the day. Both Voyagers are on hyperbolic orbits well past the planets,
 * so the asymptote and the true bearing at the crossing agree to within about a
 * degree — far inside the uncertainty on the surface this is used to anchor.
 */
interface Crossing {
  id: string
  name: string
  spacecraft: string
  boundary: 'termination-shock' | 'heliopause'
  dateIso: string
  distanceAu: number
  raDeg: number
  decDeg: number
  /** What saw it. A crossing is an instrument reading, not a position report. */
  instrument: string
  source: string
}

const CROSSINGS: readonly Crossing[] = [
  {
    id: 'helio:v1-termination-shock',
    name: 'Voyager 1 · termination shock',
    spacecraft: 'Voyager 1',
    boundary: 'termination-shock',
    dateIso: '2004-12-16',
    distanceAu: 94,
    raDeg: 259.25,
    decDeg: 12.42,
    instrument: 'Magnetometer (the plasma instrument had failed in 1980)',
    source: 'Burlaga et al. (2005), Science 309, 2027',
  },
  {
    id: 'helio:v2-termination-shock',
    name: 'Voyager 2 · termination shock',
    spacecraft: 'Voyager 2',
    boundary: 'termination-shock',
    dateIso: '2007-08-30',
    distanceAu: 84,
    raDeg: 302.75,
    decDeg: -59.8,
    instrument: 'Plasma Science Experiment and magnetometer',
    source: 'Burlaga et al. (2008), Nature 454, 75',
  },
  {
    id: 'helio:v1-heliopause',
    name: 'Voyager 1 · heliopause',
    spacecraft: 'Voyager 1',
    boundary: 'heliopause',
    dateIso: '2012-08-25',
    distanceAu: 121.6,
    raDeg: 259.25,
    decDeg: 12.42,
    instrument: 'Plasma Wave Subsystem, from the electron density',
    source: 'Gurnett et al. (2013), Science 341, 1489',
  },
  {
    id: 'helio:v2-heliopause',
    name: 'Voyager 2 · heliopause',
    spacecraft: 'Voyager 2',
    boundary: 'heliopause',
    dateIso: '2018-11-05',
    distanceAu: 119.0,
    raDeg: 302.75,
    decDeg: -59.8,
    instrument: 'Plasma Science Experiment, still working on this one',
    source: 'Stone et al. (2019), Nature Astronomy 3, 1007',
  },
]

/** How far down the tail the wireframe is drawn before it is simply cut off. */
const TAIL_LIMIT_DEG = 150

/**
 * Rings and meridians in the grid.
 *
 * Enough to read as a surface, few enough to see through. The number is set by the
 * worst case rather than the best: at the rung's own thousand-AU view almost any
 * density looks fine, but at 150 AU the camera is just outside the heliopause and the
 * grid covers the entire sky, where 22x36 read as a mesh screen over the planets.
 */
const RINGS = 16
const MERIDIANS = 24

/**
 * Angular distance from a measured bearing at which the surface is drawn at full
 * strength, and the one past which it is nearly gone.
 *
 * Not a published number — there is no published number, because the question "how far
 * from a crossing does a crossing tell you anything" has no measured answer. It is a
 * drawing decision, stated here rather than buried in a shader: 25 degrees of full
 * confidence around each Voyager bearing, falling to a floor by 90.
 */
const CONFIDENCE_FULL_DEG = 25
const CONFIDENCE_GONE_DEG = 90
/** The tail never reaches zero, or the structure would look open rather than unknown. */
const CONFIDENCE_FLOOR = 0.12

/** `r(theta)` for the axisymmetric form, normalised to 1 at the nose. */
function shapeFactor(thetaRad: number): number {
  return Math.sqrt(2 / (1 + Math.cos(thetaRad)))
}

/** 1 AU per year, in km/s. The Voyager speeds are published in km/s and used in AU/yr. */
const KM_S_PER_AU_YEAR = 4.740570

/**
 * The two spacecraft themselves, as opposed to the four events they caused.
 *
 * ## Where they are
 *
 * Propagated from the heliopause crossing, because that is the most recent moment at
 * which somebody published a heliocentric distance for these two with a date attached
 * to it. The widely quoted current figures — 172.5 AU for Voyager 1, 143 AU for
 * Voyager 2 — are distances from EARTH, which is a different number by up to an AU
 * depending on the time of year, and neither is a citation with an epoch on it.
 *
 * So: start at the crossing distance on the crossing date, travel outward along the
 * escape asymptote at the speed published for that same instant. Both spacecraft are
 * far past every planet, so there is nothing left to perturb them.
 *
 * ## What that costs
 *
 * The Sun still pulls. At 150 AU it decelerates them by about 2.6e-7 m/s^2, which over
 * the fourteen years since Voyager 1's crossing is roughly 0.1 km/s of speed and 0.2 AU
 * of distance — the model runs about a fifth of an AU ahead of the truth, or one part
 * in eight hundred. That is far below the width of the marker drawn for them, and it
 * is why the position is badged DERIVED rather than measured.
 *
 * ## What they look like
 *
 * A schematic: a 3.66 m high-gain antenna, the bus behind it, and the booms. Those are
 * published dimensions, not a shape model, and `shapeIsIllustration` is what makes the
 * inspector say so. The alternative was to leave them as the proxy module's hashed
 * irregular blob, which is the right answer for an asteroid of unknown shape and an
 * absurd one for a spacecraft whose engineering drawings are public.
 */
interface Spacecraft {
  id: string
  name: string
  /** The crossing this one's position is propagated from. */
  anchorCrossingId: string
  /** Heliocentric speed at that instant, km/s. */
  speedKmS: number
  speedSource: string
  /** Half the high-gain antenna, in metres: the largest real dimension. */
  radiusMetres: number
  launchedIso: string
}

const SPACECRAFT: readonly Spacecraft[] = [
  {
    id: 'helio:voyager-1',
    name: 'Voyager 1',
    anchorCrossingId: 'helio:v1-heliopause',
    speedKmS: 17.043,
    speedSource: 'JPL, September 2012',
    radiusMetres: 1.83,
    launchedIso: '1977-09-05',
  },
  {
    id: 'helio:voyager-2',
    name: 'Voyager 2',
    anchorCrossingId: 'helio:v2-heliopause',
    speedKmS: 15.341,
    speedSource: 'JPL, at the 2018 crossing',
    radiusMetres: 1.83,
    launchedIso: '1977-08-20',
  },
]

const MS_PER_YEAR = 365.25 * 86_400_000

/** The Sun, which is this layer's own origin in world terms. Reused, never mutated. */
const SUN_WORLD: Readonly<Vec3d> = vec3d()

const DEG = Math.PI / 180

export class HeliosphereModule implements AtlasModule {
  readonly id = 'heliosphere'
  private engine!: Engine
  private readonly nodeIds: string[] = []
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.ShaderMaterial[] = []
  /** One per boundary, faded together by `preRender`. */
  private readonly surfaces: { object: THREE.LineSegments; sizeMetres: number; baseOpacity: number }[] = []
  /** One per spacecraft: the schematic, the node it moves, and what it is propagated from. */
  private readonly craft: {
    group: THREE.Group
    node: SceneNodeHandle
    bearing: Vec3d
    anchorMs: number
    anchorAu: number
    auPerYear: number
    materials: { material: THREE.Material & { opacity: number }; baseOpacity: number }[]
  }[] = []
  /** Materials owned by the schematics, disposed with the module. */
  private readonly disposables: THREE.Material[] = []

  /** Scratch, reused: `preRender` runs every frame and must not allocate. */
  private readonly scratchWorld: Vec3d = vec3d()
  private readonly scratchLocal = new THREE.Vector3()
  private readonly scratchSun = new THREE.Vector3()

  init(engine: Engine): void {
    this.engine = engine

    const noseDirection = this.unitFromEcliptic(NOSE_LON_DEG, NOSE_LAT_DEG)
    const bearings = new Map<string, Vec3d>()
    for (const crossing of CROSSINGS) {
      if (!bearings.has(crossing.spacecraft)) {
        bearings.set(crossing.spacecraft, this.unitFromIcrf(crossing.raDeg, crossing.decDeg))
      }
    }

    const measured = [...bearings.values()]
    const fits = new Map<Crossing['boundary'], { noseAu: number; residualAu: number; residualAt: string }>()

    for (const boundary of ['termination-shock', 'heliopause'] as const) {
      const rows = CROSSINGS.filter((c) => c.boundary === boundary)
      // Fit to Voyager 1 alone. Two points cannot both sit on an axisymmetric surface
      // when the further-from-nose one is the nearer to the Sun, and pretending
      // otherwise by least-squares would split the difference and be wrong about both.
      const anchor = rows.find((c) => c.spacecraft === 'Voyager 1') ?? rows[0]
      const anchorBearing = bearings.get(anchor.spacecraft) as Vec3d
      const noseAu = anchor.distanceAu / shapeFactor(angleBetween(anchorBearing, noseDirection))

      const other = rows.find((c) => c !== anchor)
      let residualAu = 0
      let residualAt = ''
      if (other) {
        const predicted = noseAu * shapeFactor(angleBetween(bearings.get(other.spacecraft) as Vec3d, noseDirection))
        residualAu = predicted - other.distanceAu
        residualAt = other.spacecraft
      }
      fits.set(boundary, { noseAu, residualAu, residualAt })

      this.buildSurface(boundary, noseAu, noseDirection, measured)
      this.registerBoundary(boundary, noseAu, noseDirection, residualAu, residualAt)
    }

    for (const crossing of CROSSINGS) {
      this.registerCrossing(crossing, bearings.get(crossing.spacecraft) as Vec3d)
    }

    for (const craft of SPACECRAFT) {
      this.addSpacecraft(craft, bearings.get(craft.name) as Vec3d)
    }

    const heliopause = fits.get('heliopause')
    console.info(
      `[omniatlas] heliosphere: 4 measured crossings, 2 modelled surfaces. ` +
        `Heliopause fitted to Voyager 1 gives a ${heliopause?.noseAu.toFixed(1)} AU nose and misses ` +
        `Voyager 2 by ${heliopause?.residualAu.toFixed(1)} AU.`,
    )
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  /**
   * One boundary as a grid of rings and meridians about the wind axis.
   *
   * Static geometry in layer-local units, built once: `helio` has a FIXED origin at
   * the Sun, which is what makes that legal here — see the `starSystem` note in
   * Layer.ts for what happens to static geometry in a layer that re-origins.
   *
   * The largest coordinate is the tail cutoff, about 480 AU, so the whole buffer sits
   * three orders of magnitude inside the float32 range that `Layer` guarantees.
   */
  private buildSurface(
    boundary: Crossing['boundary'],
    noseAu: number,
    noseDirection: Readonly<Vec3d>,
    measured: readonly Vec3d[],
  ): void {
    const layer = this.engine.layer(LAYER)
    // An orthonormal basis with the wind axis as its pole, so a (theta, phi) grid can
    // be swept without ever needing a rotation matrix at draw time.
    const pole = new THREE.Vector3(noseDirection.x, noseDirection.y, noseDirection.z).normalize()
    const seed = Math.abs(pole.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)
    const right = new THREE.Vector3().crossVectors(seed, pole).normalize()
    const up = new THREE.Vector3().crossVectors(pole, right).normalize()

    const positions: number[] = []
    const confidences: number[] = []
    const direction = vec3d()

    const pointAt = (thetaDeg: number, phiDeg: number): [number, number, number, number] => {
      const theta = thetaDeg * DEG
      const phi = phiDeg * DEG
      const sinTheta = Math.sin(theta)
      // Unit direction at (theta, phi) about the wind axis.
      direction.x = pole.x * Math.cos(theta) + (right.x * Math.cos(phi) + up.x * Math.sin(phi)) * sinTheta
      direction.y = pole.y * Math.cos(theta) + (right.y * Math.cos(phi) + up.y * Math.sin(phi)) * sinTheta
      direction.z = pole.z * Math.cos(theta) + (right.z * Math.cos(phi) + up.z * Math.sin(phi)) * sinTheta
      const radiusAu = noseAu * shapeFactor(theta)
      this.scratchWorld.x = direction.x * radiusAu * AU_M
      this.scratchWorld.y = direction.y * radiusAu * AU_M
      this.scratchWorld.z = direction.z * radiusAu * AU_M
      layer.toLocal(this.scratchLocal, this.scratchWorld, FRAME)
      return [this.scratchLocal.x, this.scratchLocal.y, this.scratchLocal.z, confidenceAt(direction, measured)]
    }

    const push = (a: [number, number, number, number], b: [number, number, number, number]): void => {
      positions.push(a[0], a[1], a[2], b[0], b[1], b[2])
      confidences.push(a[3], b[3])
    }

    const thetaStep = TAIL_LIMIT_DEG / RINGS
    const phiStep = 360 / MERIDIANS
    // Rings of constant theta.
    for (let r = 1; r <= RINGS; r++) {
      const theta = r * thetaStep
      for (let m = 0; m < MERIDIANS; m++) {
        push(pointAt(theta, m * phiStep), pointAt(theta, (m + 1) * phiStep))
      }
    }
    // Meridians of constant phi, from the nose back to the cutoff.
    for (let m = 0; m < MERIDIANS; m++) {
      const phi = m * phiStep
      for (let r = 0; r < RINGS; r++) {
        push(pointAt(r * thetaStep, phi), pointAt((r + 1) * thetaStep, phi))
      }
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
    geometry.setAttribute('aConfidence', new THREE.BufferAttribute(new Float32Array(confidences), 1))

    const heliopause = boundary === 'heliopause'
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(heliopause ? 0x7fb6ff : 0xffb074) },
        uOpacity: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute float aConfidence;
        varying float vConfidence;
        void main() {
          vConfidence = aConfidence;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vConfidence;
        void main() {
          gl_FragColor = vec4(uColor, uOpacity * vConfidence);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })

    const lines = new THREE.LineSegments(geometry, material)
    lines.name = `heliosphere:${boundary}`
    lines.frustumCulled = false
    lines.renderOrder = -4
    layer.scene.add(lines)

    this.geometries.push(geometry)
    this.materials.push(material)
    this.surfaces.push({
      object: lines,
      sizeMetres: noseAu * 2 * AU_M,
      baseOpacity: heliopause ? 0.5 : 0.36,
    })
  }

  // -------------------------------------------------------------------------
  // Registry
  // -------------------------------------------------------------------------

  private registerBoundary(
    boundary: Crossing['boundary'],
    noseAu: number,
    noseDirection: Readonly<Vec3d>,
    residualAu: number,
    residualAt: string,
  ): void {
    const heliopause = boundary === 'heliopause'
    const worldPosition = vec3d()
    worldPosition.x = noseDirection.x * noseAu * AU_M
    worldPosition.y = noseDirection.y * noseAu * AU_M
    worldPosition.z = noseDirection.z * noseAu * AU_M

    const node: SceneNodeHandle & { provenance: string; provenanceNote: string } = {
      id: `helio:${boundary}`,
      name: heliopause ? 'Heliopause' : 'Termination shock',
      worldPosition,
      frame: FRAME,
      // Not a body and not a sphere: nobody has published a radius for this, because
      // it does not have one. The marker sits on the nose, the frame opens on the
      // whole structure, and `radiusMetres` stays silent.
      radiusMetres: 0,
      framingRadiusMetres: noseAu * AU_M,
      layer: LAYER,
      objectClass: 'region',
      parentId: null,
      provenance: 'derived',
      provenanceNote:
        `Fitted to the Voyager 1 crossing and nothing else, as an axisymmetric surface about the ` +
        `interstellar wind. It misses ${residualAt} by ${Math.abs(residualAu).toFixed(1)} AU — ` +
        `predicting ${residualAu > 0 ? 'further out' : 'closer in'} than the spacecraft measured. ` +
        `A nose-aligned model cannot do better: ${residualAt} crossed further from the nose and ` +
        `nearer the Sun, which an axisymmetric shape forbids.`,
    }
    this.engine.register(node)
    this.nodeIds.push(node.id)
  }

  private registerCrossing(crossing: Crossing, bearing: Readonly<Vec3d>): void {
    const worldPosition = vec3d()
    worldPosition.x = bearing.x * crossing.distanceAu * AU_M
    worldPosition.y = bearing.y * crossing.distanceAu * AU_M
    worldPosition.z = bearing.z * crossing.distanceAu * AU_M

    const node: SceneNodeHandle & { provenance: string; provenanceNote: string } = {
      id: crossing.id,
      name: crossing.name,
      worldPosition,
      frame: FRAME,
      radiusMetres: 0,
      // A crossing is an EVENT, not an object: nothing is there, and nothing is drawn
      // there. The spacecraft passed through this point and kept going — Voyager 1 is
      // some 45 AU beyond this marker now — so a model of a spacecraft sitting on it
      // would be a lie about where the spacecraft is.
      //
      // That leaves the arrival distance doing real work. At an AU the camera lands in
      // empty space looking at a dot, which reads as a bug and is the first thing
      // anyone flying here reported. The boundary this event happened ON is the thing
      // worth seeing, and its curvature radius is of order 100 AU, so stop far enough
      // out that the wireframe wraps the view with the marker sitting on it.
      framingRadiusMetres: 20 * AU_M,
      layer: LAYER,
      objectClass: 'spacecraft',
      parentId: null,
      provenance: 'measured',
      provenanceNote:
        `${crossing.dateIso}, at ${crossing.distanceAu} AU. ${crossing.instrument}. ` +
        `${crossing.source}. The bearing is the spacecraft's escape asymptote.`,
    }
    this.engine.register(node)
    this.nodeIds.push(node.id)
  }

  // -------------------------------------------------------------------------
  // The spacecraft
  // -------------------------------------------------------------------------

  private addSpacecraft(craft: Spacecraft, bearing: Readonly<Vec3d>): void {
    const anchor = CROSSINGS.find((c) => c.id === craft.anchorCrossingId)
    if (!anchor) return

    const group = this.buildSchematic(craft)
    const node: SceneNodeHandle & {
      provenance: string
      provenanceNote: string
      shapeIsIllustration: boolean
    } = {
      id: craft.id,
      name: craft.name,
      worldPosition: vec3d(),
      frame: FRAME,
      // The high-gain antenna is 3.66 m across and that is a published dimension, so
      // this one IS a measurement, unlike almost everything else in this module.
      radiusMetres: craft.radiusMetres,
      layer: LAYER,
      objectClass: 'spacecraft',
      parentId: null,
      // Owning an object3D is what keeps the proxy module from standing in with its
      // hashed irregular blob, which would be the wrong shape rather than no shape.
      object3D: group,
      provenance: 'derived',
      shapeIsIllustration: true,
      provenanceNote:
        `Propagated from the heliopause crossing on ${anchor.dateIso} at ${anchor.distanceAu} AU, ` +
        `outward along the escape asymptote at ${craft.speedKmS} km/s (${craft.speedSource}). ` +
        `Solar gravity still decelerates it, which this ignores: about 0.2 AU of accumulated ` +
        `error per decade at this range. The shape is a schematic from published dimensions — ` +
        `a 3.66 m antenna, the bus, the booms — and not a shape model. Launched ${craft.launchedIso}.`,
    }

    // NOT the helio layer, where everything else in this module lives.
    //
    // A layer's near plane cannot go below MIN_NEAR of its own unit, and helio's unit
    // is the AU: 1e-9 AU is 150 metres. A 3.66 m spacecraft is therefore INSIDE the
    // near plane at every distance from which you could see it, and flying to one
    // showed empty space — the inspector describing an object the renderer had
    // clipped. `system` is anchor-local and its unit is 1000 km, which puts the same
    // floor at a millimetre.
    this.engine.layer(CRAFT_LAYER).scene.add(group)
    this.engine.register(node)
    this.nodeIds.push(node.id)
    this.craft.push({
      group,
      node,
      bearing: vec3d(bearing.x, bearing.y, bearing.z),
      anchorMs: Date.parse(`${anchor.dateIso}T00:00:00Z`),
      anchorAu: anchor.distanceAu,
      auPerYear: craft.speedKmS / KM_S_PER_AU_YEAR,
      materials: [],
    })
    const entry = this.craft[this.craft.length - 1]
    group.traverse((object) => {
      const material = (object as THREE.Mesh | THREE.LineSegments).material
      if (!material || Array.isArray(material)) return
      const typed = material as THREE.Material & { opacity: number }
      // Capture the author's opacity ONCE, here. Reading it back inside the frame loop
      // reads whatever the previous frame's fade left behind, and the surface ratchets
      // to zero over a few seconds.
      entry.materials.push({ material: typed, baseOpacity: typed.opacity })
    })
  }

  /**
   * A Voyager, at true scale, from the published dimensions and nothing else.
   *
   * Built at unit size and scaled by the group, so the vertex buffer holds numbers
   * near 1 while the object sits 170 AU from the layer origin — the split the whole
   * floating-origin scheme depends on.
   */
  private buildSchematic(craft: Spacecraft): THREE.Group {
    const group = new THREE.Group()
    // Deliberately NOT the `heliosphere:` prefix the two boundary surfaces use: these
    // are objects in the heliosphere, not parts of it, and anything scanning the layer
    // for the modelled surfaces must not pick up a spacecraft.
    group.name = `spacecraft:${craft.id.replace('helio:', '')}`

    // Built facing -Z, so `lookAt` the Sun turns the antenna the way the real one is
    // turned. The high-gain antenna has pointed back at Earth continuously since the
    // planetary encounters ended; at 170 AU the Sun and the Earth are the same
    // direction to well within the width of the dish.
    const shell = new THREE.MeshBasicMaterial({ color: 0xcfd9e4, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
    const edge = new THREE.LineBasicMaterial({ color: 0xeaf2fb, transparent: true, opacity: 0.95 })
    const strut = new THREE.LineBasicMaterial({ color: 0x9fb4c8, transparent: true, opacity: 0.8 })

    // Every dimension below is in units of the node's own radius, 1.83 m, which is
    // HALF the 3.66 m antenna. Getting that wrong once drew a Voyager seven metres
    // across — so: the dish is radius 1.0, not 2.
    const dishGeometry = new THREE.ConeGeometry(1, 0.31, 28, 1, true)
    const dish = new THREE.Mesh(dishGeometry, shell)
    dish.rotation.x = -Math.PI / 2
    dish.position.z = 0.16
    group.add(dish)

    // Its rim, as a bright circle, because an unlit cone from the side is a triangle
    // and from the front is a disc, and neither says "dish" on its own.
    const rim: number[] = []
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2
      const b = ((i + 1) / 48) * Math.PI * 2
      rim.push(Math.cos(a), Math.sin(a), 0, Math.cos(b), Math.sin(b), 0)
    }
    const rimGeometry = new THREE.BufferGeometry()
    rimGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rim), 3))
    group.add(new THREE.LineSegments(rimGeometry, edge))

    // The bus: the ten-sided box of electronics behind the dish, 1.78 m across.
    const busGeometry = new THREE.CylinderGeometry(0.49, 0.49, 0.26, 10)
    const bus = new THREE.Mesh(busGeometry, shell)
    bus.rotation.x = Math.PI / 2
    bus.position.z = -0.2
    group.add(bus)

    // The booms. The magnetometer boom is 13 m — three and a half times the width of
    // the dish, and the thing that makes the silhouette a spacecraft rather than a
    // saucer. The other two carry the science scan platform and the RTGs.
    const booms = new Float32Array([
      0, 0, -0.2, 0, 7.1, -0.2,
      0, 0, -0.2, -1.3, -0.55, -0.3,
      0, 0, -0.2, 1.2, -0.65, -0.3,
    ])
    const boomGeometry = new THREE.BufferGeometry()
    boomGeometry.setAttribute('position', new THREE.BufferAttribute(booms, 3))
    group.add(new THREE.LineSegments(boomGeometry, strut))

    // The three RTGs, as a short stack on the end of their boom.
    const rtgGeometry = new THREE.CylinderGeometry(0.11, 0.11, 0.82, 8)
    const rtg = new THREE.Mesh(rtgGeometry, shell)
    rtg.position.set(-1.3, -0.55, -0.3)
    rtg.rotation.z = Math.PI / 3
    group.add(rtg)

    this.geometries.push(dishGeometry, rimGeometry, busGeometry, boomGeometry, rtgGeometry)
    this.disposables.push(shell, edge, strut)
    group.visible = false
    return group
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(ctx: FrameContext): void {
    // Both spacecraft move with the clock, so the time controls carry them outward.
    for (const entry of this.craft) {
      const years = (ctx.epochMs - entry.anchorMs) / MS_PER_YEAR
      const au = entry.anchorAu + entry.auPerYear * years
      entry.node.worldPosition.x = entry.bearing.x * au * AU_M
      entry.node.worldPosition.y = entry.bearing.y * au * AU_M
      entry.node.worldPosition.z = entry.bearing.z * au * AU_M
    }
  }

  preRender(ctx: FrameContext): void {
    const layer = this.engine.layer(LAYER)
    for (const surface of this.surfaces) {
      const visibility = spanVisibility(ctx.viewSpanMetres, surface.sizeMetres)
      surface.object.visible = visibility > 0.004
      const material = surface.object.material as THREE.ShaderMaterial
      material.uniforms.uOpacity.value = surface.baseOpacity * visibility * layer.renderOpacity
    }

    const craftLayer = this.engine.layer(CRAFT_LAYER)
    let anyCraftVisible = false
    for (const entry of this.craft) {
      // A 3.7 m object seen from anywhere the solar system is legible is far smaller
      // than one pixel; the marker glyph is what represents it there. The schematic
      // only earns its place once the view is a few spacecraft wide.
      const visibility = spanVisibility(ctx.viewSpanMetres, entry.node.radiusMetres * 2)
      entry.group.visible = visibility > 0.01
      if (!entry.group.visible) continue
      anyCraftVisible = true
      craftLayer.toLocal(this.scratchLocal, entry.node.worldPosition, FRAME)
      entry.group.position.copy(this.scratchLocal)
      entry.group.scale.setScalar(craftLayer.toLocalLength(entry.node.radiusMetres))
      // Turn the antenna back towards the Sun, which is where Earth is from out here.
      craftLayer.toLocal(this.scratchSun, SUN_WORLD, FRAME)
      entry.group.lookAt(this.scratchSun)
      for (const { material, baseOpacity } of entry.materials) {
        material.opacity = baseOpacity * visibility * craftLayer.renderOpacity
      }
    }
    if (anyCraftVisible) craftLayer.forceActive = true
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** A unit vector in the layer's frame, from an ICRS right ascension and declination. */
  private unitFromIcrf(raDeg: number, decDeg: number): Vec3d {
    const icrf = sphericalToCartesian(vec3d(), raDeg, decDeg, 1)
    return convertFrame(vec3d(), icrf, 'icrf', FRAME)
  }

  /** A unit vector in the layer's frame, from an ecliptic longitude and latitude. */
  private unitFromEcliptic(lonDeg: number, latDeg: number): Vec3d {
    return sphericalToCartesian(vec3d(), lonDeg, latDeg, 1)
  }

  dispose(): void {
    for (const entry of this.craft) entry.group.removeFromParent()
    if (this.engine) this.engine.layer(CRAFT_LAYER).forceActive = false
    for (const material of this.disposables) material.dispose()
    this.craft.length = 0
    this.disposables.length = 0
    for (const surface of this.surfaces) surface.object.removeFromParent()
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
    this.surfaces.length = 0
    this.geometries.length = 0
    this.materials.length = 0
    for (const id of this.nodeIds) this.engine?.unregister(id)
    this.nodeIds.length = 0
  }
}

/** Angle between two unit vectors, clamped so float error cannot produce a NaN. */
function angleBetween(a: Readonly<Vec3d>, b: Readonly<Vec3d>): number {
  const dot = Math.min(Math.max(a.x * b.x + a.y * b.y + a.z * b.z, -1), 1)
  return Math.acos(dot)
}

/**
 * How much of this direction a spacecraft has actually told us about.
 *
 * 1 along either Voyager bearing, falling to `CONFIDENCE_FLOOR` once the direction is
 * a right angle or more from both. This is the whole honesty argument of the module
 * expressed as an alpha channel: the parts of the surface that look solid are the
 * parts something flew through.
 */
function confidenceAt(direction: Readonly<Vec3d>, measured: readonly Vec3d[]): number {
  let nearest = Infinity
  for (const bearing of measured) nearest = Math.min(nearest, angleBetween(direction, bearing) / DEG)
  if (nearest <= CONFIDENCE_FULL_DEG) return 1
  if (nearest >= CONFIDENCE_GONE_DEG) return CONFIDENCE_FLOOR
  const t = (nearest - CONFIDENCE_FULL_DEG) / (CONFIDENCE_GONE_DEG - CONFIDENCE_FULL_DEG)
  // Smoothstep, so the edge of the known region does not read as a drawn boundary.
  const eased = t * t * (3 - 2 * t)
  return 1 - eased * (1 - CONFIDENCE_FLOOR)
}
