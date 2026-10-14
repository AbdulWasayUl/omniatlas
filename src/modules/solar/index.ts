import * as THREE from 'three'
import type { AtlasModule, Engine, FrameContext, SceneNodeHandle } from '../../core/Engine'
import { SphereBody } from '../../core/render/SphereBody'
import { orientationFromPole, orientationTidallyLocked } from '../../core/render/orientation'
import { AU_M, type Vec3d, copy3d, length3d, normalize3d, sub3d, vec3d } from '../../core/world'
import {
  bodyOrientation,
  galileanMoonOffsets,
  heliocentricPosition,
  keplerianOffset,
} from '../../astronomy/ephemeris'

import { DWARF_PLANETS, EARTH_MOON, MOONS, PLANETS, SUN } from '../../data/catalog'
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
  private sunLight!: THREE.PointLight
  private readonly scratch = vec3d()
  private readonly scratchB = vec3d()
  private readonly localPosition = new THREE.Vector3()
  private readonly quaternion = new THREE.Quaternion()
  private readonly sunDirection = new THREE.Vector3()

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
    this.addBody(SUN, {
      radiusMetres: SUN_RADIUS_M,
      emissive: true,
      emissiveIntensity: 3.4,
      textureUrl: '/textures/planets/sun.jpg',
      objectClass: 'star',
      parentId: null,
    })

    // --- planets and dwarf planets -----------------------------------------
    for (const planet of [...PLANETS, ...DWARF_PLANETS]) {
      this.addBody(planet, {
        radiusMetres: (planet.radiusKm ?? 1) * 1000,
        textureUrl: planet.textureUrl,
        ringTextureUrl: planet.ringTextureUrl,
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
      ringTextureUrl?: string
      emissive?: boolean
      emissiveIntensity?: number
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
      color: entity.id === 'sun' ? '#ffd9a0' : undefined,
      emissive: options.emissive,
      emissiveIntensity: options.emissiveIntensity,
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
  }

  update(ctx: FrameContext): void {
    const date = new Date(ctx.epochMs)
    const layer = this.engine.layer(LAYER)

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
      if (axis) {
        orientationFromPole(this.quaternion, axis.north, axis.spinRadians, FRAME)
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
    }

    this.sunLight.position.set(0, 0, 0)
  }

  preRender(ctx: FrameContext): void {
    const layer = this.engine.layer(LAYER)
    const camera = layer.camera

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
      entry.body.setVisible(apparentPixels > 0.35)
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
