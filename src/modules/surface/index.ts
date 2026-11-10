import * as THREE from 'three'
import type { AtlasModule, Engine, FrameContext, SceneNodeHandle } from '../../core/Engine'
import { type Vec3d, vec3d } from '../../core/world'
import { orientationFromPole } from '../../core/render/orientation'
import { bodyOrientation } from '../../astronomy/ephemeris'
import { assetUrl } from '../../data/assetUrl'
import { CITIES_URL, MOON_CRATERS_URL, type CityRecord, type CraterRecord } from '../../data/surfaceLayers'
import { spanVisibility } from '../../core/render/spanFade'

/**
 * Named places on the surfaces of Earth and the Moon.
 *
 * ## Why this module exists at all
 *
 * The `surface` layer has been defined since the overhaul, re-origined onto the anchor
 * every frame, and completely empty. Meanwhile `public/data` has been shipping 4.4 MB
 * of sourced surface data that nothing read: 1,615 IAU-approved lunar craters with
 * measured centres and diameters, 1,251 cities, 242 countries, and the Natural Earth
 * coastlines. `catalog.ts` exported the loaders for all of it and had no callers.
 *
 * This draws two of those four: the craters and the cities. They are the two that are
 * pure point-and-extent data, which is the kind this rung can state honestly.
 *
 * ## What this rung can and cannot claim
 *
 * It is a MAP, not a photograph, and the distinction is forced by the imagery rather
 * than chosen. The Blue Marble texture is 5400x2700, which over Earth's circumference
 * is 7.4 km per pixel; the LROC colour map is 4096x2048, or 2.7 km per pixel on the
 * Moon. The rung's own span is ten kilometres. So at the scale this rung is named for,
 * the picture underneath is between one and four pixels across and there is nothing in
 * it — no terrain, no relief, no detail of any kind.
 *
 * What IS good at ten kilometres is the geometry. A crater's centre and diameter come
 * from the USGS Gazetteer and are accurate to far better than the thing's own size, so
 * a rim circle drawn at its catalogued diameter is a true statement at a scale where
 * the imagery has nothing to say. That is the whole design: draw what is measured,
 * which is where things are and how big they are, and let the absent picture be
 * absent rather than upscaling a blur to cover the gap.
 *
 * ## Placement
 *
 * A body-fixed direction turned into the layer frame by the body's IAU orientation —
 * `north` and the prime-meridian angle from astronomy-engine, the same pair that
 * orients the sphere these features sit on, so the two cannot disagree. The body-local
 * convention is three.js's own sphere mapping, which `SphereBody` uses unmodified:
 * +Y at the north pole, +X on the prime meridian, longitude increasing towards -Z.
 * Getting that backwards puts every crater on the wrong side of the Moon and looks
 * entirely plausible, so there is a test that checks a near-side crater comes out on
 * the near side and a far-side one does not.
 */

const LAYER = 'surface' as const
const FRAME = 'icrf' as const

/** Mean radii, metres. Both measured; see the catalogue entries they come from. */
const EARTH_RADIUS_M = 6_371_000
const MOON_RADIUS_M = 1_737_400

/** Craters smaller than this are not drawn as circles; there are 1,615 of them. */
const MIN_DRAWN_DIAMETER_KM = 8

interface Feature {
  node: SceneNodeHandle
  /** Unit direction in body-fixed coordinates. */
  local: Vec3d
  bodyId: string
}

interface Body {
  id: string
  engineKey: string
  radiusMetres: number
  group: THREE.Group
  quaternion: THREE.Quaternion
}

/**
 * A body-fixed unit vector for a latitude and longitude, in three.js sphere convention.
 *
 * `SphereGeometry` with the default `phiStart` puts u=0.5 — the middle of an
 * equirectangular texture, which is longitude zero — at +X, and its north pole at +Y,
 * with longitude running towards -Z. Everything that draws a body here uses that
 * geometry unmodified, so matching it is what keeps a crater on top of the crater.
 */
export function surfaceDirection(out: Vec3d, latitudeDeg: number, longitudeDeg: number): Vec3d {
  const lat = (latitudeDeg * Math.PI) / 180
  const lon = (longitudeDeg * Math.PI) / 180
  const cosLat = Math.cos(lat)
  out.x = cosLat * Math.cos(lon)
  out.y = Math.sin(lat)
  out.z = -cosLat * Math.sin(lon)
  return out
}

export class SurfaceModule implements AtlasModule {
  readonly id = 'surface'
  private engine!: Engine
  private readonly nodeIds: string[] = []
  private readonly features: Feature[] = []
  private readonly bodies = new Map<string, Body>()
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  /**
   * Marks a node as drawing itself, so the proxy module leaves it alone.
   *
   * The proxy stands in for any node with a radius and no `object3D`, which is right
   * for a catalogue object that owns no geometry and wrong here: fly to Tycho and it
   * built a hashed irregular blob floating at 42.6 km, badged ILLUSTRATED SHAPE, on
   * top of the Moon. These features ARE drawn — as rim circles — just in one batched
   * buffer rather than an object each, so one shared marker says so for all of them.
   */
  private readonly ownsItsDrawing = new THREE.Group()
  private readonly scratchLocal = new THREE.Vector3()
  private readonly scratchVec = new THREE.Vector3()

  readonly manifest = {
    craters: 0,
    cratersDrawn: 0,
    cities: 0,
    imageryMetresPerPixel: { earth: 7_421, moon: 2_666 },
  }

  async init(engine: Engine): Promise<void> {
    this.engine = engine
    await Promise.all([this.loadCraters(), this.loadCities()])
    console.info(
      `[omniatlas] surface: ${this.manifest.craters} lunar craters ` +
        `(${this.manifest.cratersDrawn} drawn at their catalogued diameter), ${this.manifest.cities} cities. ` +
        `The imagery underneath is ${this.manifest.imageryMetresPerPixel.moon} m/pixel on the Moon and ` +
        `${this.manifest.imageryMetresPerPixel.earth} m/pixel on Earth: this rung is a map, not a picture.`,
      this.manifest,
    )
  }

  private body(id: string, engineKey: string, radiusMetres: number): Body {
    const existing = this.bodies.get(id)
    if (existing) return existing
    const group = new THREE.Group()
    group.name = `surface:${id}`
    group.visible = false
    this.engine.layer(LAYER).scene.add(group)
    const body: Body = { id, engineKey, radiusMetres, group, quaternion: new THREE.Quaternion() }
    this.bodies.set(id, body)
    return body
  }

  // -------------------------------------------------------------------------
  // The data
  // -------------------------------------------------------------------------

  private async loadCraters(): Promise<void> {
    const records = await fetchJson<CraterRecord[]>(MOON_CRATERS_URL)
    if (this.engine.isDisposed || !records?.length) return
    const body = this.body('moon', 'Moon', MOON_RADIUS_M)
    const rims: number[] = []

    for (const crater of records) {
      if (!Number.isFinite(crater.latitude) || !Number.isFinite(crater.longitude)) continue
      const local = surfaceDirection(vec3d(), crater.latitude, crater.longitude)
      const radiusMetres = ((crater.diameterKm ?? 0) * 1000) / 2

      const node: SceneNodeHandle & { provenance: string; provenanceNote: string } = {
        id: crater.id,
        name: crater.name,
        worldPosition: vec3d(),
        frame: FRAME,
        // The diameter IS measured, and is the one number about a crater that is.
        radiusMetres,
        framingRadiusMetres: Math.max(radiusMetres, 2_000),
        layer: LAYER,
        // It sits on a body drawn in the system layer too, and at the Body rung that
        // is the copy on screen. See `SceneNodeHandle.alsoDrawnIn`.
        alsoDrawnIn: ['system'],
        objectClass: 'region',
        parentId: 'moon',
        object3D: this.ownsItsDrawing,
        provenance: 'measured',
        provenanceNote:
          `Centre and diameter from the USGS Gazetteer of Planetary Nomenclature, IAU-approved` +
          `${crater.approvalDate ? ` ${crater.approvalDate.slice(0, 4)}` : ''}. ` +
          `${crater.origin ? `Named for ${crater.origin} ` : ''}` +
          `The rim is drawn as a circle at the catalogued diameter: a true statement of where and ` +
          `how big, on imagery that is 2.7 km per pixel and shows none of it.`,
      }
      this.engine.register(node)
      this.nodeIds.push(node.id)
      this.features.push({ node, local, bodyId: 'moon' })
      this.manifest.craters++

      if ((crater.diameterKm ?? 0) >= MIN_DRAWN_DIAMETER_KM) {
        this.appendRim(rims, local, radiusMetres / MOON_RADIUS_M, MOON_RADIUS_M / 1000)
        this.manifest.cratersDrawn++
      }
    }

    if (rims.length > 0) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rims), 3))
      const material = new THREE.LineBasicMaterial({
        color: 0xc8d4e2,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
      })
      const lines = new THREE.LineSegments(geometry, material)
      lines.name = 'surface:moon:rims'
      lines.frustumCulled = false
      body.group.add(lines)
      this.geometries.push(geometry)
      this.materials.push(material)
    }
  }

  private async loadCities(): Promise<void> {
    const records = await fetchJson<CityRecord[]>(CITIES_URL)
    if (this.engine.isDisposed || !records?.length) return
    this.body('earth', 'Earth', EARTH_RADIUS_M)

    for (const city of records) {
      if (!Number.isFinite(city.latitude) || !Number.isFinite(city.longitude)) continue
      const node: SceneNodeHandle & { provenance: string; provenanceNote: string } = {
        id: city.id,
        name: city.name,
        worldPosition: vec3d(),
        frame: FRAME,
        // A city has a position, not a radius. Nothing here measures its extent.
        radiusMetres: 0,
        framingRadiusMetres: 20_000,
        layer: LAYER,
        alsoDrawnIn: ['system'],
        objectClass: 'region',
        parentId: 'earth',
        object3D: this.ownsItsDrawing,
        provenance: 'measured',
        provenanceNote:
          `${city.country ? `${city.country}. ` : ''}` +
          `${city.population ? `Population about ${city.population.toLocaleString()}. ` : ''}` +
          `Coordinates from Natural Earth. The point is measured; the imagery under it is 7.4 km ` +
          `per pixel, so nothing of the city itself is visible at this scale.`,
      }
      this.engine.register(node)
      this.nodeIds.push(node.id)
      this.features.push({ node, local: surfaceDirection(vec3d(), city.latitude, city.longitude), bodyId: 'earth' })
      this.manifest.cities++
    }
  }

  /**
   * A small circle on the sphere around `centre`, in body-local layer units.
   *
   * Built in an orthonormal frame about the crater's own direction, so a crater at the
   * pole is no more special than one on the equator — the naive version, offsetting in
   * latitude and longitude, draws ellipses everywhere but the equator and nonsense at
   * the poles.
   */
  private appendRim(out: number[], centre: Readonly<Vec3d>, angularRadius: number, bodyRadiusUnits: number): void {
    const axis = this.scratchVec.set(centre.x, centre.y, centre.z).normalize()
    const seed = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
    const u = new THREE.Vector3().crossVectors(seed, axis).normalize()
    const v = new THREE.Vector3().crossVectors(axis, u).normalize()
    const cos = Math.cos(angularRadius)
    const sin = Math.sin(angularRadius)
    const segments = 24
    let previous: [number, number, number] | null = null
    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2
      const x = (axis.x * cos + (u.x * Math.cos(t) + v.x * Math.sin(t)) * sin) * bodyRadiusUnits
      const y = (axis.y * cos + (u.y * Math.cos(t) + v.y * Math.sin(t)) * sin) * bodyRadiusUnits
      const z = (axis.z * cos + (u.z * Math.cos(t) + v.z * Math.sin(t)) * sin) * bodyRadiusUnits
      if (previous) out.push(previous[0], previous[1], previous[2], x, y, z)
      previous = [x, y, z]
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(ctx: FrameContext): void {
    const date = new Date(ctx.epochMs)
    for (const body of this.bodies.values()) {
      const axis = bodyOrientation(body.engineKey, date)
      if (axis) orientationFromPole(body.quaternion, axis.north, axis.spinRadians, FRAME)
      const anchor = this.engine.node(body.id)
      if (!anchor) continue
      // Every feature on this body, turned with it. The quaternion is the same one the
      // sphere is drawn with, which is the point: a crater that drifts off its crater
      // is the failure this shares an input to avoid.
      for (const feature of this.features) {
        if (feature.bodyId !== body.id) continue
        this.scratchVec.set(feature.local.x, feature.local.y, feature.local.z)
        this.scratchVec.applyQuaternion(body.quaternion).multiplyScalar(body.radiusMetres)
        feature.node.worldPosition.x = anchor.worldPosition.x + this.scratchVec.x
        feature.node.worldPosition.y = anchor.worldPosition.y + this.scratchVec.y
        feature.node.worldPosition.z = anchor.worldPosition.z + this.scratchVec.z
      }
    }
  }

  preRender(ctx: FrameContext): void {
    const layer = this.engine.layer(LAYER)
    for (const body of this.bodies.values()) {
      const anchor = this.engine.node(body.id)
      // Rim circles are worth drawing from a view a few body-radii across down to one
      // crater wide; past that the body is a dot and the markers say everything.
      const visibility = anchor ? spanVisibility(ctx.viewSpanMetres, body.radiusMetres * 2) : 0
      body.group.visible = visibility > 0.01
      if (!body.group.visible || !anchor) continue
      layer.toLocal(this.scratchLocal, anchor.worldPosition, FRAME)
      body.group.position.copy(this.scratchLocal)
      body.group.quaternion.copy(body.quaternion)
      body.group.scale.setScalar(layer.toLocalLength(1000))
      for (const material of this.materials) {
        ;(material as THREE.LineBasicMaterial).opacity = 0.42 * visibility * layer.renderOpacity
      }
    }
  }

  dispose(): void {
    for (const body of this.bodies.values()) body.group.removeFromParent()
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
    this.bodies.clear()
    this.features.length = 0
    this.geometries.length = 0
    this.materials.length = 0
    for (const id of this.nodeIds) this.engine?.unregister(id)
    this.nodeIds.length = 0
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(assetUrl(url))
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}
