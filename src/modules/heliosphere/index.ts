import * as THREE from 'three'
import type { AtlasModule, Engine, FrameContext, SceneNodeHandle } from '../../core/Engine'
import { AU_M, type Vec3d, convertFrame, sphericalToCartesian, vec3d } from '../../core/world'
import { spanVisibility } from '../../core/render/spanFade'
import { escapingSpacecraft } from '../../data/escapingSpacecraft'

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
 * The bearing comes from `data/escapingSpacecraft.ts` — the spacecraft's escape
 * asymptote, shared with the module that draws the craft themselves so the two cannot
 * drift apart. It is the CURRENT bearing rather than the one on the day: both Voyagers
 * are on hyperbolic orbits well past the planets, so the two agree to within about a
 * degree, far inside the uncertainty on the surface this is used to anchor.
 */
interface Crossing {
  id: string
  name: string
  spacecraft: string
  boundary: 'termination-shock' | 'heliopause'
  dateIso: string
  distanceAu: number
  /** Which craft's escape bearing this crossing lies along; see `escapingSpacecraft`. */
  craftId: string
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
    craftId: 'craft:voyager-1',
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
    craftId: 'craft:voyager-2',
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
    craftId: 'craft:voyager-1',
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
    craftId: 'craft:voyager-2',
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

const DEG = Math.PI / 180

export class HeliosphereModule implements AtlasModule {
  readonly id = 'heliosphere'
  private engine!: Engine
  private readonly nodeIds: string[] = []
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.ShaderMaterial[] = []
  /** One per boundary, faded together by `preRender`. */
  private readonly surfaces: { object: THREE.LineSegments; sizeMetres: number; baseOpacity: number }[] = []

  /** Scratch, reused: `preRender` runs every frame and must not allocate. */
  private readonly scratchWorld: Vec3d = vec3d()
  private readonly scratchLocal = new THREE.Vector3()

  init(engine: Engine): void {
    this.engine = engine

    const noseDirection = this.unitFromEcliptic(NOSE_LON_DEG, NOSE_LAT_DEG)
    const bearings = new Map<string, Vec3d>()
    for (const crossing of CROSSINGS) {
      if (!bearings.has(crossing.spacecraft)) {
        const craft = escapingSpacecraft(crossing.craftId)
        if (!craft) continue
        bearings.set(crossing.spacecraft, this.unitFromIcrf(craft.raDeg, craft.decDeg))
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
  // Frame
  // -------------------------------------------------------------------------

  preRender(ctx: FrameContext): void {
    const layer = this.engine.layer(LAYER)
    for (const surface of this.surfaces) {
      const visibility = spanVisibility(ctx.viewSpanMetres, surface.sizeMetres)
      surface.object.visible = visibility > 0.004
      const material = surface.object.material as THREE.ShaderMaterial
      material.uniforms.uOpacity.value = surface.baseOpacity * visibility * layer.renderOpacity
    }

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
