import * as THREE from 'three'
import type { AtlasModule, Engine, FrameContext, SceneNodeHandle } from '../../core/Engine'
import { SphereBody } from '../../core/render/SphereBody'
import { spanVisibility } from '../../core/render/spanFade'
import { orientationFromPole, orientationTidallyLocked } from '../../core/render/orientation'
import { AU_M, type Vec3d, copy3d, length3d, normalize3d, sub3d, vec3d } from '../../core/world'
import {
  bodyOrientation,
  galileanMoonOffsets,
  heliocentricPosition,
  keplerianOffset,
  rotationPeriodSeconds,
} from '../../astronomy/ephemeris'

import { DWARF_PLANETS, EARTH_MOON, MOONS, PLANETS, SUN } from '../../data/catalog'
import { MOON_COLORS } from '../../data/moons'
import type { AtlasEntity } from '../../data/types'
import { SUN_RADIUS_M } from '../../core/world'

/**
 * The solar system.
 *
 * Everything here lives in the `helio` layer: one unit is one astronomical unit, the
 * origin is the Sun, and the frame is the J2000 ecliptic — which is the correct frame
 * for heliocentric orbits and did not exist in the codebase before the overhaul. The
 * old scene oriented asteroid orbits against the Sun's *rotation* pole, 7.25 degrees
 * off the ecliptic.
 *
 * Bodies are placed by writing float64 metres into `node.worldPosition` and letting the
 * layer do the one conversion to render units. Object positions may be large; what
 * matters is that each body's *geometry* stays local to its own origin, which it does —
 * every body is a unit sphere scaled by its radius.
 */

const LAYER = 'helio' as const
const FRAME = 'ecliptic' as const

interface BodyEntry {
  entity: AtlasEntity
  node: SceneNodeHandle
  body: SphereBody
  /** Parent body id for satellites. */
  parentId: string | null
  /** Resolved every frame: position relative to the Sun, in metres. */
  readonly world: Vec3d
  /** Signed sidereal rotation period in seconds, or null with no rotation model. */
  rotationPeriod: number | null
  /** Prime-meridian angle actually drawn. Equals the true one unless it is aliasing. */
  displayedSpin: number
  /** displayedSpin - trueSpin, wrapped. Relaxes to zero once sampling is sound again. */
  spinOffset: number
  lastTrueSpin: number
  /** True while this body is on the capped branch, i.e. its true spin cannot be shown. */
  spinCapped: boolean
}

/**
 * Per-frame spin advance past which absolute sampling is no longer recoverable.
 *
 * Anything below real aliasing is correctly sampled and must be left exactly where the
 * ephemeris puts it. 150 degrees is comfortably inside the 180 a point sample can
 * carry, and it leaves alone every body that is merely spinning *fast*: at 1 year per
 * second the Moon advances 80 degrees a frame, cleanly, and capping there would
 * decouple its spin from its orbit and stop it keeping its near side toward Earth.
 */
const SPIN_ALIAS_STEP = (150 * Math.PI) / 180

/**
 * The capped spin rate, in radians of REAL time. Not per frame: a per-frame cap makes
 * the same rung spin 2.4x faster on a 144 Hz monitor than on 60 Hz, and turns a
 * dropped frame into a 20-degree jump instead of a pause.
 */
const SPIN_RATE_CAP = 2.0

/** Time constant for easing the displayed spin back onto the true one. */
const SPIN_RELAX_SECONDS = 0.35

/** Shortest signed representative of an angle. */
function wrapPi(angle: number): number {
  return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI))
}

/**
 * Polar radius over equatorial radius, for the bodies whose flattening is visible.
 *
 * Saturn is 9.8% flattened and Jupiter 6.5%; at the sizes these are drawn that is tens
 * of pixels, and Saturn's squash is one of the first things anyone recognises in a
 * photograph of it. The squash is applied about the MEAN radius inside SphereBody, so
 * `radiusKm` keeps meaning the mean radius for arrival distance, the approach floor,
 * label sizing and the proxy sphere. Earth's 0.34% and Mars's 0.59% are under a pixel
 * at any framing this atlas offers, so they are left out rather than carried as noise.
 */
const FLATTENING: Record<string, number> = {
  jupiter: 0.93513,
  saturn: 0.90204,
  uranus: 0.97707,
  neptune: 0.98292,
}

/**
 * Exposure correction for a mosaic that does not match its body's measured albedo.
 *
 * Voyager 2's Triton and Titania mosaics are uncalibrated and sit well under the
 * albedo the flat unimaged fill beside them is set from, so the imaged half and the
 * unimaged half read as two different objects with a seam between them. The map is
 * matched up to the fill rather than the fill down to the map: the fill is the body's
 * measured colour and the mosaic's absolute level is arbitrary.
 */
const MAP_GAIN: Record<string, number> = {
  // Triton is absent on purpose: its map is a processed, albedo-matched product rather
  // than a raw mosaic, so the 2.6 stops that used to sit here clipped the nitrogen
  // frost to flat white.
  titania: 1.8,
}

/** Atmosphere colours, by body. Airless bodies are absent and get no shell. */
const ATMOSPHERES: Record<string, string> = {
  earth: '#4a87d8',
  mars: '#c9846a',
  venus: '#e8d9a8',
  jupiter: '#d9b48c',
  saturn: '#e2cfa4',
  uranus: '#7fd3df',
  neptune: '#4a6fd8',
  titan: '#d9a44c',
  pluto: '#c8b8d8',
}

/** Per-planet orbit colours, so the system reads as a set of distinct paths. */
const ORBIT_COLORS: Record<string, string> = {
  mercury: '#9a8c7a',
  venus: '#d8c48c',
  earth: '#5f9edb',
  mars: '#d07a52',
  jupiter: '#d9a86a',
  saturn: '#d8c48c',
  uranus: '#7fd3df',
  neptune: '#5f7fdb',
  pluto: '#a68cc8',
  ceres: '#8c8c8c',
  eris: '#9c9cb0',
  haumea: '#b0a890',
  makemake: '#c08c70',
}

export class SolarModule implements AtlasModule {
  id = 'solar'

  private engine!: Engine
  private readonly entries = new Map<string, BodyEntry>()
  private readonly orbitLines: THREE.LineSegments[] = []
  /** Orbit line paired with the diameter of the orbit it draws, for the span fade. */
  private readonly orbitSizes: { line: THREE.LineSegments; sizeMetres: number; baseOpacity: number }[] = []
  private sunLight!: THREE.PointLight
  private readonly scratch = vec3d()
  private readonly scratchB = vec3d()
  private readonly localPosition = new THREE.Vector3()
  private readonly quaternion = new THREE.Quaternion()
  private readonly sunDirection = new THREE.Vector3()
  /** Simulated epoch of the previous update, for the per-frame spin advance. */
  private lastEpochMs = Number.NaN
  /**
   * True while a body you can actually see is on the capped spin branch, i.e. the
   * clock is running too fast for its true rotation to be drawn. The viewer publishes
   * this so the time bar can say so rather than letting the globe look broken.
   */
  rotationAliased = false

  async init(engine: Engine): Promise<void> {
    this.engine = engine
    const layer = engine.layer(LAYER)

    // --- lighting -----------------------------------------------------------
    // A point light at the Sun gives every body a correct terminator regardless of
    // which side of the system it is on. `decay = 0` is a deliberate readability
    // choice, not a claim about irradiance: true inverse-square falloff makes Neptune
    // about 900 times dimmer than Earth, which is accurate and useless.
    this.sunLight = new THREE.PointLight(0xfff1d9, 3.2, 0, 0)
    layer.scene.add(this.sunLight)
    // Just enough fill to keep night sides legible without erasing the terminator.
    layer.scene.add(new THREE.AmbientLight(0x22304a, 0.055))

    // --- the Sun ------------------------------------------------------------
    // The photosphere is 5,772 K and it has to read as a star, not as a planet that
    // happens to glow. Measured before this: the disc's scene-linear luma was 0.68
    // against PostStack's 1.9 bloom threshold, so the Sun was the one object in the
    // atlas that could not reach the bright pass — background stars a thousandth of
    // its apparent size had visible halos and it had a razor edge. The earlier
    // multipliers (2.0, and 3.4 before that) never cleared the bar either; what was
    // actually capping the disc was the map, whose mean linear luminance is 0.41.
    //
    // 7.5 is chosen against the threshold, not by eye: SphereBody divides the map's
    // own luminance out, so the disc's radiance is 7.5 x the photosphere colour's
    // luma (0.94) = 7.1, a factor of 3.7 over the bar, which is enough for the bloom
    // to read as glare rather than as a rim. It is also deep in AgX's shoulder, which
    // is where a star belongs — limb darkening takes the outer third back down the
    // curve, so the granulation and the limb reddening survive exactly where the eye
    // looks for them.
    this.addBody(SUN, {
      radiusMetres: SUN_RADIUS_M,
      emissive: true,
      emissiveIntensity: 7.5,
      limbDarkened: true,
      textureUrl: '/textures/planets/sun.jpg',
      // The aureole. 2.6 radii and a fifth-power profile puts almost all of it inside
      // the first half-radius above the limb, where the chromosphere and inner corona
      // actually are; the bloom spreads it the rest of the way. These two numbers are
      // what an A/B in the real app settled on, not a guess: with the shell switched
      // off the bloom halo alone fell from 226 to 1 over 110 px and then stopped dead,
      // a visible ring about 1.5 radii out, and the Sun read as a disc with a collar.
      // With it the same ray decays smoothly past 440 px and the edge is gone.
      coronaScale: 2.6,
      coronaColor: '#fff0d4',
      coronaIntensity: 1.3,
      objectClass: 'star',
      parentId: null,
    })

    // --- planets and dwarf planets -----------------------------------------
    for (const planet of [...PLANETS, ...DWARF_PLANETS]) {
      this.addBody(planet, {
        radiusMetres: (planet.radiusKm ?? 1) * 1000,
        // A body whose atmosphere is opaque in visible light is seen as its cloud
        // deck, never as its surface. Venus ships both maps: `textureUrl` is the
        // Magellan radar relief, an image of a planet no eye has ever seen, and
        // `atmosphereTextureUrl` is the pale cloud-top photograph everyone knows.
        // The fallback is a stand-in for the rename this wants in src/data/planets.ts
        // (Venus's `textureUrl` set to the cloud map, `atmosphereTextureUrl` renamed
        // to `surfaceTextureUrl`), after which it reverts to plain `planet.textureUrl`
        // — as written, the field's name says the opposite of what it now selects.
        textureUrl: planet.atmosphereTextureUrl ?? planet.textureUrl,
        cloudTextureUrl: planet.id === 'earth' ? '/textures/earth/clouds.jpg' : undefined,
        ringTextureUrl: planet.ringTextureUrl,
        polarRatio: FLATTENING[planet.id],
        objectClass: planet.kind === 'dwarf-planet' ? 'dwarf-planet' : 'planet',
        parentId: 'sun',
      })
      this.addOrbit(planet)
    }

    // --- moons --------------------------------------------------------------
    for (const moon of [EARTH_MOON, ...MOONS.filter((m) => m.id !== 'moon')]) {
      this.addBody(moon, {
        radiusMetres: (moon.radiusKm ?? 1) * 1000,
        textureUrl: moon.textureUrl,
        unimagedFill: moon.unimagedFill,
        mapGain: MAP_GAIN[moon.id],
        // Titan is an opaque orange haze in visible light; titan.jpg is the Cassini
        // radar/ISS surface mosaic, tile seams and all. Keeping it as faint detail
        // under the haze is both closer to the truth and what hides the seams.
        hazeColor: moon.id === 'titan' ? '#d9a44c' : undefined,
        hazeMix: moon.id === 'titan' ? 0.12 : undefined,
        // The Moon is the one body here where relief shading at the terminator
        // changes what you can read off the globe, and LOLA's map already ships.
        bumpMapUrl: moon.id === 'moon' ? '/textures/moon/lola-elevation-4ppd.jpg' : undefined,
        // 0.5, not the 1.5 this shipped at: LOLA's full range is about 20 km on a
        // 1,737 km body, i.e. 1.2%, and driving the derivative past that made the
        // terminator limb read as golf-ball dimpling rather than as topography.
        bumpScale: moon.id === 'moon' ? 0.5 : undefined,
        objectClass: 'moon',
        parentId: moon.parentId ?? null,
      })
    }

    // Place everything once before the first frame so nothing appears at the origin.
    this.update({ epochMs: Date.now() } as FrameContext)
  }

  private addBody(
    entity: AtlasEntity,
    options: {
      radiusMetres: number
      textureUrl?: string
      unimagedFill?: string
      mapGain?: number
      hazeColor?: string
      hazeMix?: number
      cloudTextureUrl?: string
      bumpMapUrl?: string
      bumpScale?: number
      polarRatio?: number
      ringTextureUrl?: string
      emissive?: boolean
      emissiveIntensity?: number
      limbDarkened?: boolean
      coronaScale?: number
      coronaColor?: string
      coronaIntensity?: number
      objectClass: string
      parentId: string | null
    },
  ): void {
    const layer = this.engine.layer(LAYER)
    const radiusUnits = layer.toLocalLength(options.radiusMetres)

    const body = new SphereBody({
      id: entity.id,
      radius: radiusUnits,
      textureUrl: options.textureUrl,
      unimagedFill: options.unimagedFill,
      mapGain: options.mapGain,
      hazeColor: options.hazeColor,
      hazeMix: options.hazeMix,
      cloudTextureUrl: options.cloudTextureUrl,
      bumpMapUrl: options.bumpMapUrl,
      bumpScale: options.bumpScale,
      polarRatio: options.polarRatio,
      // A 5,772 K blackbody seen outside the atmosphere is white with a faint gold
      // cast, not orange: #ffd9a0 was the colour of the SUNSET Sun, reddened by two
      // airmasses of Rayleigh scattering that are not in this scene. Its chroma is
      // also the only chroma the disc has, because SphereBody takes the false-colour
      // map's luminance and discards the rest.
      color: entity.id === 'sun' ? '#fff3e2' : (entity.baseColor ?? MOON_COLORS[entity.id]),
      emissive: options.emissive,
      emissiveIntensity: options.emissiveIntensity,
      limbDarkened: options.limbDarkened,
      coronaScale: options.coronaScale,
      coronaColor: options.coronaColor,
      coronaIntensity: options.coronaIntensity,
      atmosphereColor: ATMOSPHERES[entity.id],
      ringTextureUrl: options.ringTextureUrl,
      segments: options.radiusMetres > 2e7 ? 96 : 48,
    })
    layer.scene.add(body.group)

    const node: SceneNodeHandle = {
      id: entity.id,
      worldPosition: vec3d(),
      frame: FRAME,
      radiusMetres: options.radiusMetres,
      // The same figure SphereBody expands the equator by, so the camera's floor is
      // measured against the silhouette the user can actually see. See `shapeRatio`.
      shapeRatio: options.polarRatio ? 1 / Math.cbrt(options.polarRatio) : undefined,
      layer: LAYER,
      objectClass: options.objectClass,
      name: entity.name,
      parentId: options.parentId,
      object3D: body.group,
    }
    this.engine.register(node)

    this.entries.set(entity.id, {
      entity,
      node,
      body,
      parentId: options.parentId === 'sun' ? null : options.parentId,
      world: vec3d(),
      // Sampled once: the IAU elements are linear in time, so two samples recover the
      // true rate exactly. The renderer needs to know how fast a body REALLY turns,
      // which is not recoverable from the sampled angle once that angle aliases.
      rotationPeriod: rotationPeriodSeconds(entity.engineBody ?? '', new Date()),
      displayedSpin: 0,
      spinOffset: 0,
      lastTrueSpin: 0,
      spinCapped: false,
    })
  }

  /**
   * A planet's orbit, drawn as a closed polyline.
   *
   * The vertices are generated in the ecliptic frame directly in render units and are
   * local to the Sun-centred layer origin, so the buffer never holds a large coordinate.
   * Sampling is in eccentric anomaly, which concentrates vertices near perihelion where
   * the curvature actually is.
   */
  private addOrbit(planet: AtlasEntity): void {
    const layer = this.engine.layer(LAYER)
    const au = planet.semiMajorAxisAu
    if (!au) return

    // Sample the real path from the ephemeris rather than drawing a circle: a circle at
    // the mean distance is visibly wrong for Mercury and grossly wrong for Pluto.
    const samples = 360
    const points: number[] = []
    const period = orbitalPeriodDays(au)
    const now = Date.now()
    for (let i = 0; i <= samples; i++) {
      const date = new Date(now + (i / samples) * period * 86_400_000)
      const position = heliocentricPosition(planet.engineBody ?? '', date, FRAME)
      if (!position) return
      layer.toLocal(this.localPosition, position, FRAME)
      points.push(this.localPosition.x, this.localPosition.y, this.localPosition.z)
    }

    const positions = new Float32Array((points.length / 3 - 1) * 6)
    for (let i = 0, o = 0; i < points.length / 3 - 1; i++) {
      positions[o++] = points[i * 3]
      positions[o++] = points[i * 3 + 1]
      positions[o++] = points[i * 3 + 2]
      positions[o++] = points[(i + 1) * 3]
      positions[o++] = points[(i + 1) * 3 + 1]
      positions[o++] = points[(i + 1) * 3 + 2]
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const material = new THREE.LineBasicMaterial({
      color: new THREE.Color(ORBIT_COLORS[planet.id] ?? '#5d6b74'),
      transparent: true,
      opacity: planet.kind === 'dwarf-planet' ? 0.26 : 0.38,
      depthWrite: false,
    })
    const line = new THREE.LineSegments(geometry, material)
    line.name = `orbit:${planet.id}`
    line.frustumCulled = false
    layer.scene.add(line)
    this.orbitLines.push(line)
    this.orbitSizes.push({ line, sizeMetres: au * AU_M * 2, baseOpacity: material.opacity })
  }

  update(ctx: FrameContext): void {
    const date = new Date(ctx.epochMs)
    const layer = this.engine.layer(LAYER)
    const simSeconds = Number.isFinite(this.lastEpochMs) ? (ctx.epochMs - this.lastEpochMs) / 1000 : 0
    const realDelta = Number.isFinite(ctx.delta) && ctx.delta > 0 ? ctx.delta : 1 / 60
    this.lastEpochMs = ctx.epochMs

    // Pass 1: heliocentric bodies.
    for (const entry of this.entries.values()) {
      if (entry.parentId) continue
      if (entry.entity.id === 'sun') {
        entry.world.x = 0
        entry.world.y = 0
        entry.world.z = 0
      } else {
        const position = heliocentricPosition(entry.entity.engineBody ?? '', date, FRAME)
        if (position) copy3d(entry.world, position)
      }
      copy3d(entry.node.worldPosition, entry.world)
    }

    // Pass 2: satellites, which need their parent resolved first.
    const galilean = galileanMoonOffsets(date, FRAME)
    for (const entry of this.entries.values()) {
      if (!entry.parentId) continue
      const parent = this.entries.get(entry.parentId)
      if (!parent) continue

      let offset: Vec3d | null = null
      if (entry.entity.id === 'moon') {
        // The Moon has a full engine model; use it rather than mean elements.
        const geo = heliocentricPosition('Moon', date, FRAME)
        if (geo) {
          sub3d(this.scratch, geo, parent.world)
          offset = this.scratch
        }
      } else if (galilean[entry.entity.id]) {
        offset = galilean[entry.entity.id]
      } else if (entry.entity.elements) {
        const parentAxis = bodyOrientation(parent.entity.engineBody ?? '', date)
        offset = keplerianOffset(entry.entity.elements, date, parentAxis?.north ?? { x: 0, y: 0, z: 1 }, FRAME)
      }

      if (offset) {
        entry.world.x = parent.world.x + offset.x
        entry.world.y = parent.world.y + offset.y
        entry.world.z = parent.world.z + offset.z
      }
      copy3d(entry.node.worldPosition, entry.world)
    }

    // Pass 3: write transforms into the scene graph.
    for (const entry of this.entries.values()) {
      layer.toLocal(this.localPosition, entry.world, FRAME)
      entry.body.group.position.copy(this.localPosition)

      const axis = bodyOrientation(entry.entity.engineBody ?? '', date)
      let spinStep = 0
      if (axis) {
        // The pole itself is always sampled exactly -- it moves by arcseconds a
        // century. Only the prime-meridian angle can outrun the frame rate.
        spinStep = this.advanceSpin(entry, axis.spinRadians, simSeconds, realDelta)
        orientationFromPole(this.quaternion, axis.north, entry.displayedSpin, FRAME)
      } else if (entry.parentId) {
        // No rotation model: assume tidal lock, which is true for essentially every
        // major moon. The orbit normal supplies the roll that the parent direction
        // alone leaves free.
        const parent = this.entries.get(entry.parentId)
        if (parent) {
          sub3d(this.scratch, parent.world, entry.world)
          normalize3d(this.scratchB, this.scratch)
          orientationTidallyLocked(this.quaternion, this.scratchB, { x: 0, y: 0, z: 1 }, FRAME)
        }
      }
      entry.body.group.quaternion.copy(this.quaternion)
      entry.body.advanceClouds(spinStep)
    }

    this.sunLight.position.set(0, 0, 0)
  }

  /**
   * The spin actually drawn: exact while the sampling is sound, phase-continuous when
   * it is not.
   *
   * `bodyOrientation` returns the IAU prime-meridian angle at an instant, which is the
   * right answer right up until the clock advances that angle by more than half a turn
   * between frames. Past that the sampled sequence is an alias, and the displayed spin
   * is not merely wrong but unrecoverable: at 1 month per second Earth lands 0.3%
   * BEYOND its own Nyquist frequency, so it appears to creep backwards half a degree a
   * frame while its texture flips hemisphere; at 1 year per second every globe jumps
   * to an unrelated longitude each frame. Measured here before this change: Earth 179
   * degrees a frame at 1 mo/s, Jupiter 113 degrees of pure noise at 1 yr/s.
   *
   * No 60 Hz display can show a true year-per-second spin -- the information is not in
   * the signal -- so above the threshold the renderer stops pretending and integrates
   * its own spin at a capped rate, which at least turns smoothly and in the right
   * direction. `rotationAliased` tells the UI to say so. Orbital positions are
   * untouched and stay exact.
   *
   * The offset is carried, not the angle, so when the rate drops back under the
   * threshold the displayed spin eases onto the true one along the shortest arc
   * instead of leaving a permanent phase error behind.
   */
  private advanceSpin(entry: BodyEntry, trueSpin: number, simSeconds: number, realDelta: number): number {
    const previous = entry.displayedSpin
    if (entry.rotationPeriod === null) {
      entry.spinCapped = false
      entry.spinOffset = 0
      entry.lastTrueSpin = trueSpin
      entry.displayedSpin = trueSpin
      return wrapPi(trueSpin - previous)
    }

    const trueStep = (2 * Math.PI * simSeconds) / entry.rotationPeriod
    // Hysteresis: frame times vary by a factor of two on a loaded machine, so a rung
    // sitting near the threshold would otherwise alternate between a 150-degree true
    // step and a capped crawl from frame to frame, which stutters worse than either.
    const engageAt = entry.spinCapped ? SPIN_ALIAS_STEP * 0.7 : SPIN_ALIAS_STEP
    if (Math.abs(trueStep) > engageAt) {
      entry.spinCapped = true
      const capped = Math.sign(trueStep) * Math.min(Math.abs(trueStep), SPIN_RATE_CAP * realDelta)
      // The sampled difference is garbage on this branch, and subtracting it here is
      // exactly what cancels it: displayed = true + offset collapses to
      // previousDisplayed + capped, so the globe turns by the capped step and nothing
      // else, however the underlying angle jumped.
      entry.spinOffset = wrapPi(entry.spinOffset + capped - wrapPi(trueSpin - entry.lastTrueSpin))
    } else {
      entry.spinCapped = false
      entry.spinOffset = wrapPi(entry.spinOffset) * Math.exp(-realDelta / SPIN_RELAX_SECONDS)
    }
    entry.lastTrueSpin = trueSpin
    entry.displayedSpin = trueSpin + entry.spinOffset
    return wrapPi(entry.displayedSpin - previous)
  }

  preRender(ctx: FrameContext): void {
    const layer = this.engine.layer(LAYER)
    const camera = layer.camera
    let aliased = false

    for (const entry of this.entries.values()) {
      // Light direction for the atmosphere shell, in the layer's own space.
      this.sunDirection.copy(entry.body.group.position).negate().normalize()
      entry.body.setSunDirection(this.sunDirection)

      // Cull bodies whose apparent size has fallen below a pixel. The label engine
      // draws a constant-size marker glyph for them instead — a mesh one pixel across
      // is invisible, but a glyph tells the truth about where the body is.
      const distance = camera.position.distanceTo(entry.body.group.position)
      const radiusUnits = layer.toLocalLength(entry.node.radiusMetres)
      const apparentPixels = (radiusUnits / Math.max(distance, 1e-12)) * (ctx.height / (2 * Math.tan((ctx.fovDegrees * Math.PI) / 360)))
      const visible = apparentPixels > 0.35
      entry.body.setVisible(visible)
      // Only a body large enough to be drawn can be seen to strobe, so only those
      // raise the flag -- otherwise every rung above a month per second would warn
      // about Mercury's spin from the Kuiper belt.
      if (visible && entry.spinCapped && apparentPixels > 2) aliased = true
    }
    this.rotationAliased = aliased

    // An orbit only draws while the view is wide enough to show its shape and narrow
    // enough that the shape is not a dot. See spanFade.ts.
    for (const orbit of this.orbitSizes) {
      const visibility = spanVisibility(ctx.viewSpanMetres, orbit.sizeMetres)
      orbit.line.visible = visibility > 0.004
      ;(orbit.line.material as THREE.LineBasicMaterial).opacity = orbit.baseOpacity * visibility
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.body.dispose()
      this.engine.unregister(entry.node.id)
    }
    this.entries.clear()
    for (const line of this.orbitLines) {
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
      line.removeFromParent()
    }
    this.orbitLines.length = 0
    this.orbitSizes.length = 0
  }
}

/** Kepler's third law about the Sun, in days. Good to a fraction of a percent. */
function orbitalPeriodDays(semiMajorAxisAu: number): number {
  return 365.256363004 * Math.sqrt(semiMajorAxisAu ** 3)
}

/** Metres per AU, re-exported for callers that place things by AU. */
export { AU_M }

export default function createSolarModule(): AtlasModule {
  return new SolarModule()
}

/** Length of a vector, used by callers positioning relative to the Sun. */
export function distanceFromSun(position: Vec3d): number {
  return length3d(position)
}
