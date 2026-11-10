import * as THREE from 'three'
import type { AtlasModule, Engine, FrameContext, SceneNodeHandle } from '../../core/Engine'
import { AU_M, type Vec3d, convertFrame, sphericalToCartesian, vec3d } from '../../core/world'
import { ESCAPE_STATE_SOURCE, ESCAPING_SPACECRAFT, type EscapingSpacecraft } from '../../data/escapingSpacecraft'

/**
 * The five spacecraft leaving the solar system, drawn at true scale.
 *
 * ## Why they are not points
 *
 * They were, and it was wrong in a way the atlas is supposed to be good at catching.
 * A node with a position and no geometry is a dot, and flying to a dot in interstellar
 * space shows you nothing at all — the inspector describing an object the screen does
 * not contain. These are the only human-made things out there and the whole reason the
 * heliopause has a measured distance at all.
 *
 * ## What the shapes claim
 *
 * Schematics, built from published dimensions, badged ILLUSTRATED SHAPE and not
 * resembling a shape model in any respect. The dimensions are real and cited; the
 * arrangement is a reading of the standard mission diagrams; everything below the
 * resolution of those figures — cabling, thruster placement, the detail of the scan
 * platform — is absent rather than invented.
 *
 * The parts are worth the trouble because the parts ARE the silhouette. A Voyager
 * without its two 10 m plasma-wave whips and its 13 m magnetometer boom is a saucer
 * with a box on it, which is what the first version of this drew and why it read as a
 * blob. Three quarters of what makes these recognisable is boom.
 *
 * ## Where they are
 *
 * `data/escapingSpacecraft.ts` holds one dated heliocentric state per craft and the
 * rate it is receding at; this module walks that forward to the displayed instant, so
 * the time controls carry them outward. Solar gravity still decelerates them and this
 * ignores it: about 0.2 AU per decade at these ranges, which is why the position is
 * DERIVED and not measured.
 *
 * Two of the five are dead. Nothing has been heard from Pioneer 11 since 1995 or
 * Pioneer 10 since 2003, so their positions are not predictions anyone is checking
 * against a signal. The inspector says so for those two and not for the others.
 *
 * ## Which layer, and why it matters
 *
 * `system`, which is anchor-local with a unit of 1000 km — NOT `helio`, where
 * everything about the solar system lives. A layer's near plane cannot go below
 * MIN_NEAR in its own unit, and helio's unit is the AU, which puts its floor at 150
 * metres. A 3.7 m spacecraft is inside the near plane at every distance from which it
 * could be seen, so drawing these in helio renders nothing, at any zoom, forever.
 */

const LAYER = 'system' as const
const FRAME = 'ecliptic' as const
const MS_PER_YEAR = 365.25 * 86_400_000

/** Pale, unlit, slightly translucent: a drawing, not a photograph. */
const SHELL = 0xcfd9e4
const BRIGHT = 0xeaf2fb
const STRUT = 0x9fb4c8

/**
 * Roughly how wide each design is, in metres, booms included.
 *
 * The span, not the antenna: a Voyager is about 26 m across its plasma-wave whips and
 * 3.7 m across its dish, and those are different questions.
 */
function spanOf(craft: EscapingSpacecraft): number {
  return craft.design === 'voyager' ? 26 : craft.design === 'pioneer' ? 14 : 5
}

/** Full strength until the view is this many craft-widths across... */
const FADE_FROM = 40
/** ...and gone by this many, where the marker glyph has long since taken over. */
const FADE_TO = 200

/**
 * How solid the schematic should be in a view this wide.
 *
 * Deliberately NOT `spanVisibility`, which fades a structure out at BOTH ends — it is
 * built for orbits and shells, where standing inside one means you can no longer read
 * its shape. A spacecraft is the opposite case: the closer you are the more there is
 * to see, and the near-side fade meant flying to Voyager 1 arrived at 7.8 m, inside
 * its own 26 m span, and hid it. Twice, in fact — the first time because the layer's
 * near plane clipped it, and the second because this number went to zero.
 */
function schematicVisibility(viewSpanMetres: number, spanMetres: number): number {
  const ratio = viewSpanMetres / spanMetres
  if (ratio <= FADE_FROM) return 1
  if (ratio >= FADE_TO) return 0
  const t = (Math.log10(ratio) - Math.log10(FADE_FROM)) / (Math.log10(FADE_TO) - Math.log10(FADE_FROM))
  return 1 - t * t * (3 - 2 * t)
}

interface Craft {
  spec: EscapingSpacecraft
  group: THREE.Group
  node: SceneNodeHandle
  bearing: Vec3d
  epochMs: number
  materials: { material: THREE.Material; baseOpacity: number }[]
}

export class SpacecraftModule implements AtlasModule {
  readonly id = 'spacecraft'
  private engine!: Engine
  private readonly craft: Craft[] = []
  private readonly nodeIds: string[] = []
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  private readonly scratchLocal = new THREE.Vector3()
  private readonly scratchSun = new THREE.Vector3()

  init(engine: Engine): void {
    this.engine = engine
    for (const spec of ESCAPING_SPACECRAFT) this.add(spec)
    console.info(
      `[omniatlas] spacecraft: ${this.craft.length} escaping probes, ` +
        `${ESCAPING_SPACECRAFT.filter((c) => c.lastContactIso).length} of them silent. ${ESCAPE_STATE_SOURCE}.`,
    )
  }

  private add(spec: EscapingSpacecraft): void {
    const icrf = sphericalToCartesian(vec3d(), spec.raDeg, spec.decDeg, 1)
    const bearing = convertFrame(vec3d(), icrf, 'icrf', FRAME)
    const group = this.buildSchematic(spec)

    const silent = spec.lastContactIso
    const node: SceneNodeHandle & {
      provenance: string
      provenanceNote: string
      shapeIsIllustration: boolean
      caveat?: string
    } = {
      id: spec.id,
      name: spec.name,
      worldPosition: vec3d(),
      frame: FRAME,
      // The antenna is a published dimension, so this one really is a measurement.
      radiusMetres: spec.antennaRadiusMetres,
      layer: LAYER,
      objectClass: 'spacecraft',
      parentId: null,
      // Owning the mesh is what keeps the proxy module's hashed irregular blob away —
      // the right stand-in for an asteroid of unknown shape, an absurd one here.
      object3D: group,
      provenance: 'derived',
      shapeIsIllustration: true,
      provenanceNote:
        `Position walked forward from ${spec.distanceAu} AU on ${spec.epochIso}, outward along the ` +
        `escape bearing at ${spec.speedKmS} km/s (${spec.auPerYear} AU/yr). ${ESCAPE_STATE_SOURCE}. ` +
        `Solar gravity still decelerates it, which this ignores: roughly 0.2 AU per decade. ` +
        `The shape is a schematic from published dimensions, not a shape model. ` +
        `Launched ${spec.launchedIso}; heading into ${spec.heading}.`,
      ...(silent
        ? {
            caveat:
              `Nothing has been heard from ${spec.name} since ${silent}, when its generators could no ` +
              `longer run the transmitter. This position is an ephemeris carried forward from the last ` +
              `contact — a prediction nobody has been able to check against a signal for decades.`,
          }
        : {}),
    }

    this.engine.layer(LAYER).scene.add(group)
    this.engine.register(node)
    this.nodeIds.push(node.id)

    const entry: Craft = {
      spec,
      group,
      node,
      bearing,
      epochMs: Date.parse(`${spec.epochIso}T00:00:00Z`),
      materials: [],
    }
    group.traverse((object) => {
      const material = (object as THREE.Mesh).material
      if (!material || Array.isArray(material)) return
      const typed = material as THREE.Material
      // Captured ONCE. Reading it back inside the frame loop reads the previous
      // frame's fade, and the opacity ratchets to zero over a few seconds.
      entry.materials.push({ material: typed, baseOpacity: opacityOf(typed) })
    })
    this.craft.push(entry)
  }

  // -------------------------------------------------------------------------
  // The schematics
  // -------------------------------------------------------------------------

  /**
   * Every dimension is in units of the craft's own antenna RADIUS.
   *
   * Which is half the diameter every source quotes, and getting that backwards once
   * drew a Voyager seven metres across. The antenna is radius 1 in all three designs,
   * by construction.
   */
  private buildSchematic(spec: EscapingSpacecraft): THREE.Group {
    const group = new THREE.Group()
    group.name = `spacecraft:${spec.id.replace('craft:', '')}`
    // Built facing -Z so `lookAt(sun)` turns the dish the way the real one is turned:
    // all three of these point their high-gain antenna back at Earth, and from beyond
    // 60 AU the Earth and the Sun are the same direction to far inside the dish width.
    if (spec.design === 'voyager') this.buildVoyager(group, spec)
    else if (spec.design === 'pioneer') this.buildPioneer(group, spec)
    else this.buildNewHorizons(group, spec)
    group.visible = false
    return group
  }

  /**
   * Shared materials, tracked for disposal.
   *
   * The shell is shaded, which it has to be. Unlit flat white turns a paraboloid and a
   * ten-sided prism into two overlapping silhouettes of the same grey — the first
   * version of this read as a cardboard cut-out for exactly that reason. There is no
   * light in this layer to use, so the shader carries its own: one fixed direction in
   * object space, wrapped so the dark side goes dim rather than black. That is a
   * drawing convention, not a claim about illumination, which is the right register
   * for a schematic anyway.
   */
  private palette(): { shell: THREE.Material; bright: THREE.Material; strut: THREE.Material } {
    const shell = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(SHELL) },
        uOpacity: { value: 0.95 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying vec3 vNormal;
        void main() {
          vec3 light = normalize(vec3(0.35, 0.55, 0.75));
          // Wrapped lambert: half-lit at the terminator, never fully black, so the far
          // side of a boom or a dish stays legible against the star field behind it.
          float lambert = dot(normalize(vNormal), light) * 0.5 + 0.5;
          float shade = 0.3 + 0.7 * lambert * lambert;
          gl_FragColor = vec4(uColor * shade, uOpacity);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const bright = new THREE.LineBasicMaterial({ color: BRIGHT, transparent: true, opacity: 1 })
    const strut = new THREE.LineBasicMaterial({ color: STRUT, transparent: true, opacity: 1 })
    this.materials.push(shell, bright, strut)
    return { shell, bright, strut }
  }

  /** A closed circle in the XY plane at `z`, as line segments. */
  private ring(radius: number, z: number, segments = 48): THREE.BufferGeometry {
    const points: number[] = []
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2
      const b = ((i + 1) / segments) * Math.PI * 2
      points.push(Math.cos(a) * radius, Math.sin(a) * radius, z, Math.cos(b) * radius, Math.sin(b) * radius, z)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3))
    this.geometries.push(geometry)
    return geometry
  }

  /** Line segments from a flat list of endpoint triples. */
  private struts(points: number[]): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3))
    this.geometries.push(geometry)
    return geometry
  }

  private track<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.push(geometry)
    return geometry
  }

  /**
   * Voyager 1 and 2.
   *
   * 3.7 m high-gain antenna; a ten-sided bus 1.78 m across the flats and 47 cm high;
   * a 13 m magnetometer boom; a 2.5 m science boom carrying the scan platform; three
   * RTGs end-to-end on a boom opposite it; and two 10 m plasma-wave and radio-astronomy
   * whips at right angles to one another, forming the V that is most of the outline.
   * The Golden Record is a 30 cm disc on one face of the bus.
   *
   * Sources: NASA's Voyager spacecraft page (ten-sided bus, 3.7 m HGA, three RTGs in
   * tandem, the two whips "at right-angles... forming a V", the 30 cm record), the
   * SPASE observatory metadata (bus 47 cm by 1.78 m flat-to-flat, two 10 m whips), and
   * NASA's Voyager 1 data page (13 m magnetometer boom, 2.5 m science boom).
   */
  private buildVoyager(group: THREE.Group, spec: EscapingSpacecraft): void {
    const { shell, bright, strut } = this.palette()
    const u = 1 / spec.antennaRadiusMetres // metres -> units

    // The antenna. A shallow open cone reads as a dish from any angle once its rim is
    // drawn; a disc does not, and a deep paraboloid is wrong for this one.
    const dish = new THREE.Mesh(this.track(new THREE.ConeGeometry(1, 0.33, 32, 1, true)), shell)
    dish.rotation.x = -Math.PI / 2
    dish.position.z = 0.17
    group.add(dish)
    group.add(new THREE.LineSegments(this.ring(1, 0), bright))
    group.add(new THREE.LineSegments(this.ring(0.45, 0.12, 24), strut))

    // The feed, on three struts out in front of the dish.
    const feedZ = 0.62
    const feed = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.07, 0.07, 0.14, 8)), shell)
    feed.rotation.x = Math.PI / 2
    feed.position.z = feedZ
    group.add(feed)
    const feedStruts: number[] = []
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2
      feedStruts.push(Math.cos(a) * 0.95, Math.sin(a) * 0.95, 0, 0, 0, feedZ)
    }
    group.add(new THREE.LineSegments(this.struts(feedStruts), strut))

    // The bus: ten sides, 1.78 m across the flats, so the circumradius is a touch more.
    const busRadius = (0.89 / Math.cos(Math.PI / 10)) * u
    const busZ = -0.24 * u
    const bus = new THREE.Mesh(this.track(new THREE.CylinderGeometry(busRadius, busRadius, 0.47 * u, 10)), shell)
    bus.rotation.x = Math.PI / 2
    bus.position.z = busZ
    group.add(bus)

    // The Golden Record, 30 cm, bolted to one of the ten faces.
    const record = new THREE.Mesh(this.track(new THREE.CircleGeometry(0.15 * u, 20)), shell)
    record.position.set(busRadius * 0.99, 0, busZ)
    record.rotation.y = Math.PI / 2
    group.add(record)
    const recordRim = new THREE.LineSegments(this.ring(0.15 * u, 0, 20), bright)
    recordRim.position.set(busRadius * 1.0, 0, busZ)
    recordRim.rotation.y = Math.PI / 2
    group.add(recordRim)

    // The science boom, 2.5 m, with the scan platform on the end: IRIS is the big one,
    // with UVS above it, the two ISS cameras beside, and PPS below.
    const boomLen = 2.5 * u
    const platform = new THREE.Group()
    platform.position.set(boomLen, 0, busZ)
    const iris = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.2 * u, 0.2 * u, 0.5 * u, 10)), shell)
    iris.rotation.z = Math.PI / 2
    platform.add(iris)
    const issA = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.42 * u, 0.16 * u, 0.16 * u)), shell)
    issA.position.set(0.05 * u, 0.24 * u, 0.1 * u)
    platform.add(issA)
    const issB = issA.clone()
    issB.position.set(0.05 * u, 0.24 * u, -0.1 * u)
    platform.add(issB)
    const pps = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.1 * u, 0.1 * u, 0.3 * u, 8)), shell)
    pps.rotation.z = Math.PI / 2
    pps.position.set(0, -0.26 * u, 0)
    platform.add(pps)
    group.add(platform)

    // The RTG boom, opposite the science boom, with three generators end-to-end.
    const rtgBoom = -2.5 * u
    for (let i = 0; i < 3; i++) {
      const rtg = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.2 * u, 0.2 * u, 0.5 * u, 8)), shell)
      rtg.rotation.z = Math.PI / 2
      rtg.position.set(rtgBoom - (i - 1) * 0.56 * u, -0.3 * u, busZ)
      group.add(rtg)
    }

    // The booms themselves, and the two 10 m whips. The magnetometer boom runs
    // opposite the science boom and is three and a half times the width of the dish;
    // the whips are longer still, and 90 degrees apart.
    const mag = 13 * u
    const whip = 10 * u
    const whipA = whip * Math.SQRT1_2
    group.add(
      new THREE.LineSegments(
        this.struts([
          // science boom
          0, 0, busZ, boomLen, 0, busZ,
          // RTG boom
          0, 0, busZ, rtgBoom - 0.3 * u, -0.3 * u, busZ,
          // magnetometer boom, with its two outboard sensors
          0, 0, busZ, -mag * 0.28, mag * 0.96, busZ,
          // the V: two 10 m whips at right angles
          0, 0, busZ, whipA, -whipA, busZ * 0.4,
          0, 0, busZ, -whipA, -whipA, busZ * 0.4,
        ]),
        strut,
      ),
    )
  }

  /**
   * Pioneer 10 and 11.
   *
   * A 2.74 m dish 46 cm deep with the hexagonal bus tucked behind it, a 6.6 m
   * magnetometer boom, and two shorter booms carrying two RTGs each — four in total,
   * held out at arm's length because they are hot and radioactive and the instruments
   * are not. The plaque is bolted to the antenna support struts.
   *
   * Sources: Astronautix (2.74 m dish 46 cm deep, hexagonal aluminium structure, 6.6 m
   * magnetometer boom). The bus dimensions and the RTG boom length are NOT published on
   * any page consulted, so the proportions of those two parts are read off the standard
   * mission diagram rather than measured, and are the least trustworthy thing here.
   */
  private buildPioneer(group: THREE.Group, spec: EscapingSpacecraft): void {
    const { shell, bright, strut } = this.palette()
    const u = 1 / spec.antennaRadiusMetres

    const dish = new THREE.Mesh(this.track(new THREE.ConeGeometry(1, 0.46 * u, 28, 1, true)), shell)
    dish.rotation.x = -Math.PI / 2
    dish.position.z = 0.23 * u
    group.add(dish)
    group.add(new THREE.LineSegments(this.ring(1, 0), bright))

    // The hex bus, behind the dish rather than under it: a Pioneer is mostly antenna.
    const busZ = -0.3 * u
    const bus = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.51, 0.51, 0.36 * u, 6)), shell)
    bus.rotation.x = Math.PI / 2
    bus.position.z = busZ
    group.add(bus)

    // The feed and its support tripod, with the plaque on it.
    const feedStruts: number[] = []
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.4
      feedStruts.push(Math.cos(a) * 0.9, Math.sin(a) * 0.9, 0.05 * u, 0, 0, 0.9 * u)
    }
    group.add(new THREE.LineSegments(this.struts(feedStruts), strut))
    const plaque = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.23 * u, 0.15 * u, 0.01 * u)), shell)
    plaque.position.set(0.3, -0.42, 0.42 * u)
    group.add(plaque)

    // Four RTGs, two to an arm, held well away from the instruments.
    const arm = 3 * u
    for (const side of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const rtg = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.13 * u, 0.13 * u, 0.46 * u, 8)), shell)
        rtg.position.set(side * (arm + i * 0.5 * u), -0.55 * u, busZ)
        rtg.rotation.z = Math.PI / 2
        group.add(rtg)
      }
    }

    const mag = 6.6 * u
    group.add(
      new THREE.LineSegments(
        this.struts([
          0, 0, busZ, arm, -0.55 * u, busZ,
          0, 0, busZ, -arm, -0.55 * u, busZ,
          0, 0, busZ, mag * 0.55, mag * 0.83, busZ,
        ]),
        strut,
      ),
    )
  }

  /**
   * New Horizons.
   *
   * A 2.1 m high-gain antenna on the top deck, a squat triangular bus beneath it, and
   * one RTG on a short arm off a corner. Much the most compact of the three designs:
   * no long booms at all, which is why it reads as a dish on a wedge.
   *
   * Sources: NASA's launch press kit (2.1 m dish on the top deck), the mission's
   * pre-launch environmental impact statement (triangular aluminium-honeycomb bus).
   * Published overall dimensions disagree between sources by a good fraction of a
   * metre, so the bus proportions here are approximate and the antenna is not.
   */
  private buildNewHorizons(group: THREE.Group, spec: EscapingSpacecraft): void {
    const { shell, bright, strut } = this.palette()
    const u = 1 / spec.antennaRadiusMetres

    const dish = new THREE.Mesh(this.track(new THREE.ConeGeometry(1, 0.26 * u, 28, 1, true)), shell)
    dish.rotation.x = -Math.PI / 2
    dish.position.z = 0.13 * u
    group.add(dish)
    group.add(new THREE.LineSegments(this.ring(1, 0), bright))
    group.add(new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.06, 0.06, 0.1 * u, 8)), shell))

    // The bus: a flat triangular box, 2.11 m on a side and 0.68 m deep.
    const busZ = -0.5 * u
    const bus = new THREE.Mesh(this.track(new THREE.CylinderGeometry(1.05 * u, 1.05 * u, 0.68 * u, 3)), shell)
    bus.rotation.x = Math.PI / 2
    bus.position.z = busZ
    group.add(bus)

    // The single RTG, on a short arm off one corner — the part that makes this one
    // look like what it is rather than like a satellite.
    const rtg = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.2 * u, 0.2 * u, 1.0 * u, 10)), shell)
    rtg.rotation.z = Math.PI / 2
    rtg.position.set(-1.6 * u, -0.5 * u, busZ)
    group.add(rtg)
    group.add(
      new THREE.LineSegments(this.struts([0, 0, busZ, -1.2 * u, -0.5 * u, busZ]), strut),
    )
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(ctx: FrameContext): void {
    for (const entry of this.craft) {
      const years = (ctx.epochMs - entry.epochMs) / MS_PER_YEAR
      const au = entry.spec.distanceAu + entry.spec.auPerYear * years
      entry.node.worldPosition.x = entry.bearing.x * au * AU_M
      entry.node.worldPosition.y = entry.bearing.y * au * AU_M
      entry.node.worldPosition.z = entry.bearing.z * au * AU_M
    }
  }

  preRender(ctx: FrameContext): void {
    const layer = this.engine.layer(LAYER)
    let anyVisible = false
    for (const entry of this.craft) {
      const visibility = schematicVisibility(ctx.viewSpanMetres, spanOf(entry.spec))
      entry.group.visible = visibility > 0.01
      if (!entry.group.visible) continue
      anyVisible = true
      layer.toLocal(this.scratchLocal, entry.node.worldPosition, FRAME)
      entry.group.position.copy(this.scratchLocal)
      entry.group.scale.setScalar(layer.toLocalLength(entry.node.radiusMetres))
      // Turn the dish back towards the Sun, where Earth is from out here.
      layer.toLocal(this.scratchSun, SUN_WORLD, FRAME)
      entry.group.lookAt(this.scratchSun)
      for (const { material, baseOpacity } of entry.materials) {
        setOpacity(material, baseOpacity * visibility * layer.renderOpacity)
      }
    }
    if (anyVisible) layer.forceActive = true
  }

  dispose(): void {
    for (const entry of this.craft) entry.group.removeFromParent()
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
    this.craft.length = 0
    this.geometries.length = 0
    this.materials.length = 0
    for (const id of this.nodeIds) this.engine?.unregister(id)
    this.nodeIds.length = 0
  }
}

/** The Sun, which is the origin in world terms. Reused, never mutated. */
const SUN_WORLD: Readonly<Vec3d> = vec3d()

/**
 * Opacity, whichever kind of material this is.
 *
 * `ShaderMaterial.opacity` exists and does nothing — the fragment shader decides, and
 * ours reads `uOpacity`. Setting the wrong one of the two is silent: the material
 * simply never fades, which is the sort of thing that survives a review.
 */
function opacityOf(material: THREE.Material): number {
  const uniforms = (material as THREE.ShaderMaterial).uniforms
  return uniforms?.uOpacity ? (uniforms.uOpacity.value as number) : material.opacity
}

function setOpacity(material: THREE.Material, value: number): void {
  const uniforms = (material as THREE.ShaderMaterial).uniforms
  if (uniforms?.uOpacity) uniforms.uOpacity.value = value
  else material.opacity = value
}
