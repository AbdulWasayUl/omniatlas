import * as THREE from 'three'
import type { AtlasModule, Engine, FrameContext, SceneNodeHandle } from '../../core/Engine'
import { SphereBody } from '../../core/render/SphereBody'
import { type Vec3d, convertFrame, copy3d, vec3d } from '../../core/world'
import { type KeplerianElements, keplerianOffset } from '../../astronomy/ephemeris'
import {
  type GeneratedMoon,
  type GeneratedPlanet,
  type GeneratedSystem,
  WORLD_KINDS,
  generateSystem,
  nameSystem,
} from '../../generators/system'

/**
 * Immersive mode: invented planetary systems around real stars.
 *
 * The atlas draws 330,000 real stars and, until this module, not one of them was
 * anywhere. You could fly to Sabik and arrive at a glowing ball with nothing around it,
 * because nobody has imaged a planet there and the atlas refuses to draw what nobody has
 * measured. That refusal is right, and it is also the reason the middle of the atlas is
 * empty. This module is the other half of the bargain: everything here is MADE UP, it is
 * off unless the viewer asks for it, and it says so wherever it appears.
 *
 * ## Why the rest of the atlas stays honest
 *
 * Nothing measured is altered. Generated nodes live under a `gen:` id that cannot collide
 * with a catalogue id, they carry `provenance: 'illustration'` so the inspector marks
 * them, and switching the mode off unregisters every one of them. The real star keeps its
 * own radius, position and name; the invention is what orbits it.
 *
 * The one thing the mode borrows is the star's `object3D`, set while it is on so the
 * proxy module does not also draw a stand-in for a star this module is already drawing,
 * and deleted again on teardown. That is a rendering fact, not a measurement, and it is
 * the same field `solar` sets for a real planet.
 *
 * ## Why this works today
 *
 * `system` and `surface` are anchor-local layers: the engine re-origins them onto
 * whatever the camera is anchored to, every frame. So a planet around a star 88 light
 * years away costs no new precision work — fly to it and the layer re-origins onto the
 * planet, and its moons are a few hundred units across. That is why this is possible now
 * while a walk through another GALAXY is not: nothing re-origins at galactic scale yet.
 */

/**
 * Invented systems get a layer of their own, at the heliocentric layer's scale.
 *
 * Two layers were tried first and neither works. `system` is sized for ONE planet and
 * its moons -- a span band stopping at seven AU and a far plane to match -- so a
 * six-planet system drawn there sat entirely outside the frustum and nothing appeared at
 * all; forcing the layer active does not help, because an active layer still clips to
 * its own far plane. Re-origining `helio` onto the host star came much closer, since
 * every module that draws the solar system positions its bodies through `toLocal` each
 * frame and those went correctly out of range -- but the orbit lines and the asteroid
 * belt are STATIC geometry built about the origin, and static geometry does not move
 * when the origin does, so the real solar system's orbits were drawn around Sabik.
 *
 * `imagined` has the same unit and span band as `helio` and an origin this module owns.
 * It also means invented content can never share a scene with measured content, which is
 * worth more than the convenience of reusing a layer.
 */
const LAYER = 'imagined' as const
/** Generated positions are stated in the frame the star catalogue uses. */
const FRAME = 'icrf' as const


/**
 * A generated node, which says plainly that it is one.
 *
 * `SceneNodeHandle` carries no provenance field — the inspector widens it, the way the
 * cosmic and deep-sky modules already do for theirs — so this is where invented content
 * declares itself. Without it a generated world got no chip at all, which the inspector
 * treats as "says nothing about itself" and is far too quiet for something made up.
 */
interface ImaginedNode extends SceneNodeHandle {
  provenance: 'illustration'
  provenanceNote: string
  /** The kind of world, and what makes it that kind. Shown above the provenance note. */
  caveat: string
}

interface Body {
  id: string
  node: SceneNodeHandle
  body: SphereBody
  elements: KeplerianElements | null
  /** Null for the star; the planet's id for a moon. */
  parentId: string | null
  /** North axis of the orbit this body follows. */
  north: Vec3d
  world: Vec3d
}

export class ImmersiveModule implements AtlasModule {
  readonly id = 'immersive'
  private engine!: Engine
  private builtFor: string | null = null
  private system: GeneratedSystem | null = null
  private readonly bodies = new Map<string, Body>()
  private readonly orbits: THREE.Line[] = []
  private starLight: THREE.PointLight | null = null
  private hostNode: SceneNodeHandle | null = null
  private readonly local = new THREE.Vector3()

  init(engine: Engine): void {
    this.engine = engine
  }

  /**
   * Build and tear down here rather than in `preRender`, for the reason the proxy module
   * documents: the engine decides which layers are active between the two, so anything
   * created in `preRender` is invisible for its first frame.
   */
  update(ctx: FrameContext): void {
    const wanted = this.engine.immersive ? this.hostStar(ctx) : null
    if (wanted !== this.builtFor) {
      this.teardown()
      if (wanted) this.build(wanted)
    }
    if (!this.system || !this.hostNode) return

    this.place(ctx)
  }

  /** True where this id names something this module invented. */
  isGenerated(nodeId: string | null): boolean {
    return nodeId !== null && nodeId.startsWith('gen:')
  }

  /** The generated system currently built, for the inspector and the stats panel. */
  current(): GeneratedSystem | null {
    return this.system
  }

  /**
   * Which star the camera is at, if any.
   *
   * Reads the destination AND the body being left, so a flight between two generated
   * worlds of one system does not tear the system down halfway across. The Sun is
   * excluded: it has real planets, and inventing a second set around it would be the one
   * case where a generated world could be mistaken for a measured one.
   */
  private hostStar(ctx: FrameContext): string | null {
    // `engine.anchorId` rather than `ctx.anchorId`: the context's copy is written in
    // `draw`, so inside `update` it is the PREVIOUS frame's value. The proxy module can
    // live with that because it rebuilds every frame anyway; this one would spend the
    // first frame after every arrival building the system it just left.
    for (const id of [this.engine.anchorId, ctx.transitFromId]) {
      if (!id) continue
      const starId = id.startsWith('gen:') ? id.slice(4).split('/')[0] : id
      const node = this.engine.node(starId)
      if (node && canHostInventedSystem(node, this.hasRealChildren(starId))) return starId
    }
    return null
  }

  /** Whether the registry already holds something orbiting this star. */
  private hasRealChildren(starId: string): boolean {
    for (const node of this.engine.registry.values()) {
      if (node.parentId === starId && !node.id.startsWith('gen:')) return true
    }
    return false
  }

  private build(starId: string): void {
    const host = this.engine.node(starId)
    if (!host) return
    // Set FIRST: `addWorld` compares against it to decide whether a body's parent is the
    // real star or another generated world, and `update` compares against it to decide
    // whether anything needs building at all. Left until the end of this method, the
    // module rebuilt the entire system every frame and hung every planet off a parent id
    // that did not exist.
    this.builtFor = starId
    this.hostNode = host
    const system = nameSystem(generateSystem({ id: starId, radiusMetres: host.radiusMetres, temperatureK: host.temperatureK }), host.name)
    this.system = system
    const layer = this.engine.layer(LAYER)
    // This module owns the layer's origin; nothing else draws into it.
    layer.setOrigin(host.worldPosition, host.frame, starId)

    // One orbital plane per system, from the seed, so systems are not all stacked in the
    // catalogue's equator. The planets' own inclinations are measured from this.
    const north = planeNormal(system.seed)

    // The star. Drawn here rather than left to the proxy module so that it stays lit and
    // present while the camera is anchored on one of its planets.
    const starBody = new SphereBody({
      id: `gen:${starId}`,
      radius: layer.toLocalLength(system.star.radiusMetres),
      color: system.star.color,
      emissive: true,
      emissiveIntensity: 3.2,
      limbDarkened: true,
      coronaScale: 2.4,
      coronaColor: system.star.color,
      coronaIntensity: 0.5,
      segments: 64,
    })
    layer.scene.add(starBody.group)
    // The real star is now drawn by this module, so the proxy module must not also build
    // a stand-in for it. Removed again in `teardown`.
    host.object3D = starBody.group
    this.bodies.set(starId, {
      id: starId,
      node: host,
      body: starBody,
      elements: null,
      parentId: null,
      north,
      world: vec3d(),
    })

    this.starLight = new THREE.PointLight(0xffffff, 1, 0, 0)
    layer.scene.add(this.starLight)

    // The star's world position, which every orbit ring is built about.
    const hostWorld = vec3d()
    convertFrame(hostWorld, host.worldPosition, host.frame, FRAME)
    for (const planet of system.planets) {
      this.addWorld(planet, starId, north)
      const planetNorth = planeNormal(system.seed ^ hashOf(planet.id))
      for (const moon of planet.moons) this.addWorld(moon, planet.id, planetNorth)
      this.addOrbit(planet, north, hostWorld)
    }

    console.info(
      `[omniatlas] immersive: invented ${system.planets.length} worlds and ` +
        `${system.planets.reduce((n, p) => n + p.moons.length, 0)} moons around ${host.name} ` +
        `(${system.planets.filter((p) => p.habitable).length + system.planets.reduce((n, p) => n + p.moons.filter((m) => m.habitable).length, 0)} habitable)`,
    )
  }

  private addWorld(world: GeneratedPlanet | GeneratedMoon, parentId: string, north: Vec3d): void {
    const layer = this.engine.layer(LAYER)
    const isPlanet = 'moons' in world
    const rings = isPlanet && (world as GeneratedPlanet).hasRings
    const body = new SphereBody({
      id: `gen:${world.id}`,
      radius: layer.toLocalLength(world.radiusMetres),
      color: world.color,
      // A habitable world gets a rim light, which is the one visual cue the mode gives
      // for a property it invented. The inspector says the rest.
      atmosphereColor: world.habitable ? '#9ec9ff' : undefined,
      // `hasRings` is generated and is NOT drawn yet: SphereBody draws a ring system
      // from a texture, and this module ships no textures at all. What it does show is
      // the oblateness that goes with a fast-spinning giant, which is a real thing about
      // the body rather than a stand-in for the rings. Drawing the rings needs a
      // procedural ring map, which is the obvious next piece of work.
      polarRatio: rings ? 0.93 : undefined,
      segments: world.radiusMetres > 2e7 ? 64 : 32,
    })
    layer.scene.add(body.group)

    const node: ImaginedNode = {
      id: `gen:${world.id}`,
      worldPosition: vec3d(),
      frame: FRAME,
      radiusMetres: world.radiusMetres,
      layer: LAYER,
      objectClass: isPlanet ? 'planet' : 'moon',
      name: world.name,
      parentId: parentId === this.builtFor ? parentId : `gen:${parentId}`,
      object3D: body.group,
      // The atlas's existing word for "this is a picture, not a measurement". There is
      // no stronger one in the vocabulary, and adding a fourth kind for this would mean
      // every consumer of provenance had to learn it; what the chip cannot say, the note
      // underneath it does, in the first four words.
      provenance: 'illustration',
      // What kind of world this is, said first, because it is the thing a viewer wants
      // to know on arrival and the thing the colour is only hinting at.
      caveat: `${WORLD_KINDS[world.kind].label}. ${WORLD_KINDS[world.kind].description}` +
        `${world.habitable ? ` Habitable: ${world.habitabilityNote}.` : ''}`,
      provenanceNote:
        `Invented, not observed. ${this.hostNode?.name ?? 'This star'}'s measured radius and ` +
        'temperature set the scale, and everything else — how many worlds there are, how big ' +
        'they are, what they are made of and what orbits them — was generated from the star\'s ' +
        'identifier. The same star always yields the same system, so a link to this world ' +
        'shows anyone the same world.',
    }
    this.engine.register(node)
    this.bodies.set(world.id, {
      id: world.id,
      node,
      body,
      elements: elementsOf(world),
      parentId,
      north,
      world: vec3d(),
    })
  }

  /** A faint ring on the orbit, which is what makes a system read as a system. */
  private addOrbit(planet: GeneratedPlanet, north: Vec3d, hostWorld: Vec3d): void {
    const layer = this.engine.layer(LAYER)
    const points: THREE.Vector3[] = []
    const elements = elementsOf(planet)
    const steps = 192
    const scratch = vec3d()
    // `toLocal` takes a WORLD position and subtracts the layer's origin, so handing it a
    // bare orbital offset asks it where a point 0.6 AU from the frame's zero is -- which
    // is 88 light years from this star, five and a half million AU outside the far plane.
    // Differencing two local positions gives the offset in the layer's units and basis
    // with no origin in it, which is what a ring drawn about its star needs.
    const centre = new THREE.Vector3()
    layer.toLocal(centre, hostWorld, FRAME)
    for (let i = 0; i <= steps; i++) {
      // Sampled by true position around one period, so an eccentric orbit comes out the
      // shape it actually is rather than as a circle.
      const when = new Date(elements.epoch.getTime() + (i / steps) * elements.periodDays * 86400000)
      const offset = keplerianOffset(elements, when, north, FRAME)
      scratch.x = hostWorld.x + offset.x
      scratch.y = hostWorld.y + offset.y
      scratch.z = hostWorld.z + offset.z
      layer.toLocal(this.local, scratch, FRAME)
      points.push(this.local.clone().sub(centre))
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points)
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color: 0x5f7f9f, transparent: true, opacity: 0.22, depthWrite: false }),
    )
    line.frustumCulled = false
    line.name = `gen:orbit:${planet.id}`
    layer.scene.add(line)
    this.orbits.push(line)
  }

  /** Propagate every orbit and write the transforms. */
  private place(ctx: FrameContext): void {
    const layer = this.engine.layer(LAYER)
    const date = new Date(ctx.epochMs)
    const host = this.bodies.get(this.builtFor ?? '')
    if (!host || !this.hostNode) return

    // The star sits where the catalogue says it does; everything else hangs off it.
    convertFrame(host.world, this.hostNode.worldPosition, this.hostNode.frame, FRAME)

    // Planets first, then moons, so a moon's parent is already resolved this frame.
    for (const pass of [1, 2]) {
      for (const entry of this.bodies.values()) {
        if (!entry.elements || !entry.parentId) continue
        const isMoon = entry.parentId !== this.builtFor
        if ((pass === 1) === isMoon) continue
        const parent = this.bodies.get(entry.parentId)
        if (!parent) continue
        const offset = keplerianOffset(entry.elements, date, entry.north, FRAME)
        entry.world.x = parent.world.x + offset.x
        entry.world.y = parent.world.y + offset.y
        entry.world.z = parent.world.z + offset.z
      }
    }

    // Re-origin onto whatever the camera is anchored to, exactly as the engine does for
    // `system` and `surface`. Two reasons, and the first is not optional: the engine
    // waives a layer's distance band only while `layer.anchorId` matches the camera's
    // anchor, so a layer still parked on the star went dark the moment the camera
    // arrived at one of its planets. The second is precision -- at a planet the local
    // coordinates are then kilometres rather than AU.
    //
    // Safe here because every world position above is absolute and was computed before
    // the origin moved; only the conversions below depend on it.
    const anchored = this.engine.anchorId
    const anchorEntry = anchored
      ? this.bodies.get(anchored.startsWith('gen:') ? anchored.slice(4) : anchored)
      : undefined
    const originOf = anchorEntry ?? host
    layer.setOrigin(originOf.world, FRAME, anchored ?? this.builtFor)

    for (const entry of this.bodies.values()) {
      copy3d(entry.node.worldPosition, entry.world)
      layer.toLocal(this.local, entry.world, FRAME)
      entry.body.group.position.copy(this.local)
    }

    if (this.starLight) {
      layer.toLocal(this.local, host.world, FRAME)
      this.starLight.position.copy(this.local)
      // Inverse-square from the star, in the layer's own units, so a planet at 5 AU is
      // lit like a planet at 5 AU rather than like one at the camera's whim.
      this.starLight.distance = 0
      this.starLight.intensity = 1
    }

    // Orbit rings are drawn about the star, so they follow it rather than the origin.
    for (const line of this.orbits) {
      layer.toLocal(this.local, host.world, FRAME)
      line.position.copy(this.local)
    }
  }

  private teardown(): void {
    const layer = this.engine.layer(LAYER)
    const restoreOrigin = this.builtFor !== null
    for (const entry of this.bodies.values()) {
      if (entry.id === this.builtFor) {
        // The real star's node is not ours to unregister; only the mesh we hung on it.
        if (this.hostNode) delete this.hostNode.object3D
      } else {
        this.engine.unregister(entry.node.id)
      }
      entry.body.group.removeFromParent()
      entry.body.dispose?.()
    }
    this.bodies.clear()
    for (const line of this.orbits) {
      line.removeFromParent()
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
    }
    this.orbits.length = 0
    if (this.starLight) {
      this.starLight.removeFromParent()
      this.starLight = null
    }
    // Nothing else draws here, so the origin only needs clearing so that a later build
    // starts from a known place rather than from the last star visited.
    if (restoreOrigin) layer.setOrigin(vec3d(), layer.config.frame, null)

    this.system = null
    this.hostNode = null
    this.builtFor = null
  }

  dispose(): void {
    this.teardown()
  }
}

/**
 * Whether a star may have a system invented for it.
 *
 * Two rules, both structural rather than a list of ids to keep adding to.
 *
 * The star must live in the `stellar` layer, which is where the star catalogue puts its
 * 601 named stars and nowhere else. The atlas holds the Sun twice more — as `sun` in the
 * helio layer, and as `sun-galactic`, the marker the galaxy module draws to say "you are
 * here" — and both are `objectClass: 'star'`, so a check on the class alone cheerfully
 * invented a system around each. "The Sun b" appearing beside Mercury is the exact
 * failure this whole mode is built to avoid: the one place an invented world could be
 * taken for a measured one.
 *
 * And the star must have nothing already orbiting it. That catches the Sun again by a
 * second route, and it is the rule that will still be right the day the atlas gains a
 * real exoplanet catalogue — a star with measured planets must never also sprout
 * invented ones.
 */
export function canHostInventedSystem(
  node: { objectClass: string; layer: string },
  hasRealChildren: boolean,
): boolean {
  return node.objectClass === 'star' && node.layer === 'stellar' && !hasRealChildren
}

/** Keplerian elements in the shape the ephemeris propagator wants. */
function elementsOf(world: GeneratedPlanet | GeneratedMoon): KeplerianElements {
  return {
    semiMajorAxisKm: world.semiMajorAxisMetres / 1000,
    eccentricity: world.eccentricity,
    inclinationDeg: world.inclinationDeg,
    nodeDeg: world.nodeDeg,
    periapsisDeg: world.periapsisDeg,
    meanAnomalyDegAtEpoch: world.meanAnomalyDeg,
    // A fixed epoch, so the system's phase is a function of the seed and the clock and
    // nothing else: the same permalink at the same simulated instant shows the same sky.
    epoch: new Date(Date.UTC(2000, 0, 1, 12)),
    periodDays: world.periodDays,
  }
}

/** A deterministic unit normal, so each system has an orbital plane of its own. */
function planeNormal(seed: number): Vec3d {
  // Two angles from the seed, spread by the golden ratio so neighbouring seeds do not
  // give neighbouring planes.
  const a = ((seed >>> 0) % 10000) / 10000
  const b = (((seed >>> 13) ^ 0x9e3779b9) >>> 0) % 10000 / 10000
  const theta = Math.acos(2 * a - 1)
  const phi = 2 * Math.PI * b
  return vec3d(Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta))
}

function hashOf(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}
