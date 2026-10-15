import * as THREE from 'three'
import type { AtlasModule, Engine, FrameContext, SceneNodeHandle } from '../../core/Engine'
import { KPC_M, type Vec3d, vec3d } from '../../core/world'
import {
  type ArmModelFile,
  R0_KPC,
  angularDiameterToRadiusKpc,
  galactocentricToSceneOffsetKpc,
  heliocentricToSceneKpc,
  sampleArmRidge,
  sunGalactocentricKpc,
} from '../../astronomy/galaxy'

/**
 * The Milky Way.
 *
 * ## What is observation and what is model
 *
 * This is the layer where that question stops being pedantry. **There is no photograph
 * of the Milky Way from outside and there never will be.** Everything that looks like
 * a picture of our Galaxy — including the one this module draws — is a model.
 *
 * So the module draws the model and the evidence for it *at the same time*, never one
 * without the other:
 *
 * | What                       | Provenance     | Why |
 * | -------------------------- | -------------- | --- |
 * | 300k-point disc field      | **DERIVED**    | A deterministic statistical realisation of the Reid+2019 arm model. No point is a real star. |
 * | Spiral arm ribbons         | **DERIVED**    | Log-periodic fits, Reid+2019 Table 2. Fitted curves. |
 * | ~200 maser points          | **MEASURED**   | VLBI trigonometric parallaxes. These are what the arms were fitted *to*. |
 * | Maser distance error bars  | **MEASURED**   | 1-sigma parallax uncertainty, drawn along the line of sight. |
 * | Local Group galaxies       | **MEASURED**   | Cepheid / TRGB / CMD distances (UNGC). |
 * | Local Group glow discs     | **ILLUSTRATION** | Sized by the measured D25 major axis, but no image data exists in this build. |
 * | The Sun's position         | **MEASURED**   | R0 = 8.15 +/- 0.15 kpc. |
 *
 * `provenanceIndex()` returns that table at runtime, and every node and Object3D this
 * module creates carries its own `provenance` and `provenanceNote`, so the UI can badge
 * them without this file knowing anything about the UI.
 *
 * ## Why the arms and the masers are never drawn apart
 *
 * An atlas that renders a beautiful spiral and leaves the user to assume it is a
 * photograph has lied by omission. Drawing the 199 measured points along the fitted
 * curves makes the relationship visible: the curves pass through the points, the points
 * run out long before the curves do, and the stretch where only the curve exists is
 * drawn dimmer because `arms.json` tells us where the parallaxes stop.
 *
 * ## Frames
 *
 * The `galactic` layer's origin is the **Sun** (every OmniAtlas frame shares the solar
 * origin; a frame only fixes axis directions). The Reid model is galactocentric. So all
 * galactocentric geometry is parented to one group whose position is the Galactic
 * centre, which both keeps every vertex under ~20 units and makes the offset explicit
 * in one place instead of being baked into 300,000 coordinates.
 */

const LAYER = 'galactic' as const
const FRAME = 'galactic' as const
const DATA = '/data/galaxy'

export type Provenance = 'measured' | 'derived' | 'illustration'

/** A registered node that also declares where its numbers came from. */
export interface ProvenancedNode extends SceneNodeHandle {
  provenance: Provenance
  provenanceNote: string
}

export interface ProvenanceEntry {
  id: string
  label: string
  provenance: Provenance
  note: string
  source: string
}

// ---------------------------------------------------------------------------
// Dataset shapes. Only the columns this module reads are typed.
// ---------------------------------------------------------------------------

interface FieldManifest {
  recordCount: number
  fields: { name: string; dtype: string; byteOffset: number; byteLength: number }[]
  colour: { palette: [number, number, number][] }
  frame: { sunPositionPc: number[] }
  badge: string
  statement: string
  attribution: string
}

interface MaserRow {
  name: string
  otherName: string | null
  lDeg: number
  bDeg: number
  distKpc: number
  eDistKpc: number
  armCode: string | null
  armFit: string | null
  xKpc: number
  yKpc: number
  zKpc: number
}

interface MaserFile {
  badge: string
  attribution: string
  masers: MaserRow[]
}

interface LocalGroupRow {
  id: string
  name: string
  distanceKpc: number | null
  distanceMethod: string | null
  xHelioKpc: number | null
  yHelioKpc: number | null
  zHelioKpc: number | null
  host: string
  kind: string
  morphology: string | null
  apparentBMag: number | null
  absoluteBMag: number | null
  majorAxisArcmin: number | null
}

interface LocalGroupFile {
  badge: string
  attribution: string
  landmarks: { label: string; name: string; distanceKpc: number }[]
  galaxies: LocalGroupRow[]
}

// ---------------------------------------------------------------------------
// Tunables. Named, because every one of them is a presentation choice rather than
// a measurement, and a reader is entitled to see which numbers are which.
// ---------------------------------------------------------------------------

/**
 * Flux scale for the disc field. Each point stands for an equal slice of stellar mass,
 * so its screen brightness falls as 1/d^2 — which is what makes the same cloud read as
 * a galaxy from outside and as a band of light from inside without a second code path.
 */
const FIELD_GAIN = 420
/**
 * Above this, a point is spread over a larger quad instead of getting brighter, up to
 * `uMaxRadiusPx`. Past that cap the spreading stops and the sample is simply dimmed:
 * flux conservation would otherwise make the view from inside the disc — where a line
 * of sight crosses eight kiloparsecs of midplane — a solid white bar. That cap is an
 * exposure compromise, measured by screenshot, not a statement about the Galaxy. The
 * numbers it was tuned against: from 55 kpc outside, 6.5% of the frame above 200/255;
 * from inside the disc, 8.8%.
 */
const FIELD_MAX_INTENSITY = 0.07
/**
 * Inside this radius of the Sun, in kpc, the model field fades out entirely. Two
 * reasons, both substantive: the solar neighbourhood is where the atlas draws 330,000
 * REAL stars from AT-HYG, and overlaying invented ones there would be the single most
 * misleading thing this module could do; and a 300k-point realisation is far too sparse
 * to survive being looked at from a few hundred parsecs.
 */
const FIELD_NEAR_FADE_START_KPC = 0.8
const FIELD_NEAR_FADE_END_KPC = 3.5

/**
 * The fitted arm width describes high-mass star-forming regions, a narrow ridge tracer.
 * The stellar arm is broader. `field.json` scales the fitted width by 2 for the same
 * reason; the ribbons use the same factor so the ribbon and the point cloud agree.
 * This is a presentation choice, not a measurement.
 */
const ARM_WIDTH_SCALE = 2

/** Maser glyph brightness, and the brightness of their 1-sigma error bars. */
const MASER_INTENSITY = 0.45
const MASER_BAR_OPACITY = 0.22

/** Per-arm ribbon colours. Reinforcement only — the label carries the identity. */
const ARM_COLORS: Record<string, number> = {
  '3kpc-near': 0xc98a6a,
  norma: 0xd6a066,
  'scutum-centaurus': 0x6fb6e8,
  'sagittarius-carina': 0x7fd9c0,
  local: 0xf2e6a8,
  perseus: 0x9a9ff0,
  outer: 0xc88ad8,
}

export class GalaxyModule implements AtlasModule {
  id = 'galaxy'

  private engine!: Engine
  /** Everything expressed in Reid's galactocentric frame hangs off this. */
  private gcGroup!: THREE.Group
  /** Everything heliocentric (the Local Group) hangs off this. */
  private helioGroup!: THREE.Group

  private quad!: THREE.BufferGeometry
  private readonly materials: THREE.Material[] = []
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly nodes: ProvenancedNode[] = []

  private fieldMaterial: THREE.ShaderMaterial | null = null
  private fieldMesh: THREE.Mesh | null = null
  private maserMaterial: THREE.ShaderMaterial | null = null
  private maserBarMaterial: THREE.LineBasicMaterial | null = null
  private localGroupMaterial: THREE.ShaderMaterial | null = null
  private armMaterials: (THREE.MeshBasicMaterial | THREE.LineBasicMaterial)[] = []
  private readonly armBaseOpacity: number[] = []

  private fieldCount = 0
  private maserCount = 0
  private localGroupCount = 0
  private armCount = 0
  /** Local Group rows with no usable distance. Reported rather than invented. */
  private localGroupWithoutDistance = 0
  private localGroupWithoutSize = 0

  private readonly scratch = vec3d()
  private readonly localPosition = new THREE.Vector3()
  private readonly provenance: ProvenanceEntry[] = []

  async init(engine: Engine): Promise<void> {
    this.engine = engine
    const layer = engine.layer(LAYER)

    this.quad = new THREE.BufferGeometry()
    this.quad.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    )
    this.quad.setIndex([0, 1, 2, 0, 2, 3])

    this.gcGroup = new THREE.Group()
    this.gcGroup.name = 'galaxy:galactocentric'
    this.gcGroup.matrixAutoUpdate = true
    this.positionGalacticCentre()
    layer.scene.add(this.gcGroup)

    this.helioGroup = new THREE.Group()
    this.helioGroup.name = 'galaxy:heliocentric'
    layer.scene.add(this.helioGroup)

    // The small files first, and awaited: nodes must exist before the viewer builds
    // its label set, which it does as soon as every module's init resolves.
    const [armModel, maserFile, localGroupFile] = await Promise.all([
      fetchJson<ArmModelFile>(`${DATA}/arms.json`),
      fetchJson<MaserFile>(`${DATA}/masers.json`),
      fetchJson<LocalGroupFile>(`${DATA}/localgroup.json`),
    ])
    if (engine.isDisposed) return

    this.addSunAndCentre()
    if (armModel) this.buildArms(armModel)
    else console.warn('[omniatlas] galaxy: arms.json unavailable — no arm model drawn')
    if (maserFile) this.buildMasers(maserFile)
    else console.warn('[omniatlas] galaxy: masers.json unavailable — the arm model ships unaccompanied by its evidence')
    if (localGroupFile) this.buildLocalGroup(localGroupFile)
    else console.warn('[omniatlas] galaxy: localgroup.json unavailable — no Local Group objects')

    // The 3.9 MB point cloud streams in behind the first frame. Nothing registered
    // depends on it, so a slow or failed fetch costs structure, not the layer.
    void this.loadField().catch((error) => {
      console.warn('[omniatlas] galaxy: disc field unavailable', error)
    })
  }

  // -------------------------------------------------------------------------
  // The galactic centre, the Sun, and the two things everybody looks for first
  // -------------------------------------------------------------------------

  private positionGalacticCentre(): void {
    const layer = this.engine.layer(LAYER)
    // The Galactic centre in heliocentric galactic metres: straight down +x (l = 0),
    // R0 away, and 5.5 pc below the Sun's own height above the midplane.
    this.scratch.x = R0_KPC * KPC_M
    this.scratch.y = 0
    this.scratch.z = -0.0055 * KPC_M
    layer.toLocal(this.localPosition, this.scratch, FRAME)
    this.gcGroup.position.copy(this.localPosition)
  }

  private addSunAndCentre(): void {
    const sun = sunGalactocentricKpc()
    const [sx, sy, sz] = galactocentricToSceneOffsetKpc(sun)

    // A small instrument cross, not a star glyph: the Sun's photosphere is 2e-8 kpc
    // across and drawing anything with an apparent size here would be a lie.
    const arm = 0.06
    const vertices = new Float32Array([
      sx - arm, sy, sz, sx + arm, sy, sz,
      sx, sy - arm, sz, sx, sy + arm, sz,
      sx, sy, sz - arm, sx, sy, sz + arm,
    ])
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3))
    const material = new THREE.LineBasicMaterial({
      color: 0xffe9a8,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      depthTest: false,
    })
    const cross = new THREE.LineSegments(geometry, material)
    cross.frustumCulled = false
    cross.renderOrder = -6
    cross.name = 'galaxy:sun-marker'
    cross.userData = {
      provenance: 'measured',
      note: 'R0 = 8.15 +/- 0.15 kpc, z_sun = 5.5 pc (Reid et al. 2019).',
    }
    this.gcGroup.add(cross)
    this.geometries.push(geometry)
    this.materials.push(material)

    // The Galaxy itself, as a selectable object, placed at its centre.
    this.addNode({
      id: 'milky-way',
      name: 'Milky Way',
      objectClass: 'galaxy',
      parentId: null,
      // Stellar disc radius: an adopted round 15 kpc. The Galaxy has no edge and the
      // disc's measured scale length is 3.5 kpc, not a radius — this number exists to
      // frame the camera, and nothing is derived from it.
      radiusMetres: 15 * KPC_M,
      worldGalactocentricKpc: { x: 0, y: 0, z: 0 },
      provenance: 'derived',
      provenanceNote:
        'Position is measured (R0 = 8.15 kpc, Reid+2019). Everything you can SEE of it here is a model: there is no photograph of the Milky Way from outside.',
    })

    this.addNode({
      id: 'galactic-centre',
      name: 'Galactic centre',
      objectClass: 'black-hole',
      parentId: 'milky-way',
      radiusMetres: 0,
      worldGalactocentricKpc: { x: 0, y: 0, z: 0 },
      provenance: 'measured',
      provenanceNote:
        'Direction from VLBI astrometry of Sgr A*; distance R0 = 8.15 +/- 0.15 kpc (Reid et al. 2019).',
    })

    this.addNode({
      id: 'sun-galactic',
      name: 'The Sun',
      objectClass: 'star',
      parentId: 'milky-way',
      radiusMetres: 0,
      worldGalactocentricKpc: sun,
      provenance: 'measured',
      provenanceNote: 'Where we are: 8.15 kpc from the centre, 5.5 pc above the midplane.',
    })

    this.provenance.push({
      id: 'sun-position',
      label: "The Sun's place in the disc",
      provenance: 'measured',
      note: 'R0 = 8.15 +/- 0.15 kpc, z = 5.5 pc.',
      source: 'Reid et al. 2019, ApJ 885, 131',
    })
  }

  // -------------------------------------------------------------------------
  // The arm model
  // -------------------------------------------------------------------------

  private buildArms(model: ArmModelFile): void {
    const ribbonPositions: number[] = []
    const ribbonColors: number[] = []
    const measuredLine: number[] = []
    const extrapolatedLine: number[] = []

    for (const arm of model.arms) {
      const samples = sampleArmRidge(arm, 240)
      if (samples.length < 2) continue
      this.armCount++
      const colour = new THREE.Color(ARM_COLORS[arm.id] ?? 0x9fb4d8)

      for (let i = 0; i < samples.length - 1; i++) {
        const a = samples[i]
        const b = samples[i + 1]
        const wa = a.halfWidthKpc * ARM_WIDTH_SCALE
        const wb = b.halfWidthKpc * ARM_WIDTH_SCALE

        // Alpha carries two separate facts: the Gaussian cross-section (bright ridge,
        // transparent edges) and whether parallaxes constrain this azimuth at all.
        const alphaA = a.extrapolated ? 0.06 : 0.24
        const alphaB = b.extrapolated ? 0.06 : 0.24

        const aL = galactocentricToSceneOffsetKpc(offsetPoint(a.position, a.normal, wa))
        const aC = galactocentricToSceneOffsetKpc(a.position)
        const aR = galactocentricToSceneOffsetKpc(offsetPoint(a.position, a.normal, -wa))
        const bL = galactocentricToSceneOffsetKpc(offsetPoint(b.position, b.normal, wb))
        const bC = galactocentricToSceneOffsetKpc(b.position)
        const bR = galactocentricToSceneOffsetKpc(offsetPoint(b.position, b.normal, -wb))

        pushQuad(ribbonPositions, aL, aC, bC, bL)
        pushQuadColors(ribbonColors, colour, 0, alphaA, alphaB, 0)
        pushQuad(ribbonPositions, aC, aR, bR, bC)
        pushQuadColors(ribbonColors, colour, alphaA, 0, 0, alphaB)

        const target = a.extrapolated || b.extrapolated ? extrapolatedLine : measuredLine
        target.push(aC[0], aC[1], aC[2], bC[0], bC[1], bC[2])
      }
    }

    if (ribbonPositions.length > 0) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(ribbonPositions, 3))
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(ribbonColors, 4))
      const material = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.frustumCulled = false
      mesh.renderOrder = -8
      mesh.name = 'galaxy:arm-ribbons'
      mesh.userData = { provenance: 'derived', badge: model.badge, note: model.description }
      this.gcGroup.add(mesh)
      this.geometries.push(geometry)
      this.materials.push(material)
      this.armMaterials.push(material)
      this.armBaseOpacity.push(1)
    }

    // The ridge lines, split so that the extrapolated reaches are visibly weaker. The
    // dataset tells us exactly where the parallaxes stop; hiding that would turn a
    // measurement-limited model into a confident drawing.
    this.addRidgeLine(measuredLine, 0.38, 'galaxy:arm-ridge-measured')
    this.addRidgeLine(extrapolatedLine, 0.11, 'galaxy:arm-ridge-extrapolated')

    this.provenance.push({
      id: 'arms',
      label: `Spiral arm model (${this.armCount} arms)`,
      provenance: 'derived',
      note: 'Fitted log-periodic curves, not an image. Dim stretches are extrapolated past the last parallax.',
      source: model.attribution,
    })
  }

  private addRidgeLine(vertices: number[], opacity: number, name: string): void {
    if (vertices.length === 0) return
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    const material = new THREE.LineBasicMaterial({
      color: 0xdfe9ff,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    })
    const line = new THREE.LineSegments(geometry, material)
    line.frustumCulled = false
    line.renderOrder = -7
    line.name = name
    line.userData = { provenance: 'derived' }
    this.gcGroup.add(line)
    this.geometries.push(geometry)
    this.materials.push(material)
    this.armMaterials.push(material)
    this.armBaseOpacity.push(opacity)
  }

  // -------------------------------------------------------------------------
  // The measurements the model was fitted to
  // -------------------------------------------------------------------------

  private buildMasers(file: MaserFile): void {
    const rows = file.masers.filter((row) => Number.isFinite(row.xKpc) && Number.isFinite(row.distKpc))
    this.maserCount = rows.length
    if (rows.length === 0) return

    const positions = new Float32Array(rows.length * 3)
    const bars: number[] = []
    const sun = sunGalactocentricKpc()

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const point = { x: row.xKpc, y: row.yKpc, z: row.zKpc }
      const [sx, sy, sz] = galactocentricToSceneOffsetKpc(point)
      positions[i * 3] = sx
      positions[i * 3 + 1] = sy
      positions[i * 3 + 2] = sz

      // The 1-sigma parallax error, drawn as a bar along the line of sight — which is
      // the direction the error actually lies in. A circle of uncertainty would be
      // wrong: these distances are precise across the sky and uncertain in depth.
      const dx = point.x - sun.x
      const dy = point.y - sun.y
      const dz = point.z - sun.z
      const length = Math.hypot(dx, dy, dz) || 1
      const e = Math.min(row.eDistKpc, row.distKpc * 0.9)
      const near = { x: point.x - (dx / length) * e, y: point.y - (dy / length) * e, z: point.z - (dz / length) * e }
      const far = { x: point.x + (dx / length) * e, y: point.y + (dy / length) * e, z: point.z + (dz / length) * e }
      const a = galactocentricToSceneOffsetKpc(near)
      const b = galactocentricToSceneOffsetKpc(far)
      bars.push(a[0], a[1], a[2], b[0], b[1], b[2])
    }

    const geometry = new THREE.InstancedBufferGeometry()
    geometry.index = this.quad.index
    geometry.setAttribute('position', this.quad.getAttribute('position'))
    geometry.setAttribute('iPosition', new THREE.InstancedBufferAttribute(positions, 3))
    geometry.instanceCount = rows.length

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelHeight: { value: 1080 },
        uRadiusPx: { value: 2.1 },
        uColor: { value: new THREE.Color(0x9ef0ff) },
        uIntensity: { value: MASER_INTENSITY },
      },
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = -5
    mesh.name = 'galaxy:masers'
    mesh.userData = {
      provenance: 'measured',
      badge: file.badge,
      note: `${rows.length} VLBI trigonometric parallaxes — the observational constraints on the arm model drawn beside them.`,
    }
    this.gcGroup.add(mesh)
    this.geometries.push(geometry)
    this.materials.push(material)
    this.maserMaterial = material

    const barGeometry = new THREE.BufferGeometry()
    barGeometry.setAttribute('position', new THREE.Float32BufferAttribute(bars, 3))
    const barMaterial = new THREE.LineBasicMaterial({
      color: 0x4fa8c8,
      transparent: true,
      opacity: MASER_BAR_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    })
    const barLines = new THREE.LineSegments(barGeometry, barMaterial)
    barLines.frustumCulled = false
    barLines.renderOrder = -6
    barLines.name = 'galaxy:maser-error-bars'
    barLines.userData = { provenance: 'measured', note: '1-sigma parallax distance error, along the line of sight.' }
    this.gcGroup.add(barLines)
    this.geometries.push(barGeometry)
    this.materials.push(barMaterial)
    this.maserBarMaterial = barMaterial

    this.provenance.push({
      id: 'masers',
      label: `${rows.length} maser parallaxes`,
      provenance: 'measured',
      note: 'Drawn with 1-sigma line-of-sight error bars, alongside the model they constrain.',
      source: file.attribution,
    })
  }

  // -------------------------------------------------------------------------
  // The Local Group
  // -------------------------------------------------------------------------

  /**
   * Which layer should M31 live in?
   *
   * `galactic` — and the decision is not aesthetic. The `cosmic` layer only contributes
   * when the camera is more than 0.1 Mpc from its origin, so anything registered there
   * is invisible from inside the Milky Way, which is where the user spends almost all
   * of their time. The `galactic` layer contributes out to 1 Mpc from the Sun and so
   * covers the Local Group from the inside, where the question "where is Andromeda?"
   * is actually asked.
   *
   * Precision is not the constraint people assume: M31 at 773 kpc, in a layer whose
   * unit is 1 kpc, is 773 render units, where a float32 ULP is about 6e-5 units — 6
   * milliparsecs, against a galaxy 60,000 parsecs across. Nine of the 81 catalogue rows
   * lie past the layer's 1 Mpc band and will need the cosmic layer to pick them up when
   * it ships; they are registered here regardless, because a node that exists is
   * findable by search even when its layer is not drawing.
   */
  private buildLocalGroup(file: LocalGroupFile): void {
    // The catalogue's four landmarks carry human-readable labels; everything else gets
    // mechanical reformatting of its catalogue identifier and nothing more.
    const landmarkLabels = new Map((file.landmarks ?? []).map((l) => [l.name, l.label]))
    const positions: number[] = []
    const radii: number[] = []
    const intensities: number[] = []
    const colors: number[] = []

    for (const row of file.galaxies) {
      // The catalogue's own "Milky Way" row is heliocentric zero — it is us, and it is
      // already registered at the Galactic centre with a real position. Skipping it
      // avoids a second, wrongly-placed Milky Way sitting on top of the Sun.
      if (row.id === 'milky-way') continue

      const distance = row.distanceKpc
      if (distance === null || !Number.isFinite(distance) || distance <= 0) {
        // No distance means no position. Inventing one would be the exact failure this
        // layer exists to avoid, so the row is counted and dropped.
        this.localGroupWithoutDistance++
        continue
      }
      if (row.xHelioKpc === null || row.yHelioKpc === null || row.zHelioKpc === null) {
        this.localGroupWithoutDistance++
        continue
      }

      const helio = { x: row.xHelioKpc, y: row.yHelioKpc, z: row.zHelioKpc }
      const [sx, sy, sz] = heliocentricToSceneKpc(helio)

      const radiusKpc =
        row.majorAxisArcmin !== null && row.majorAxisArcmin > 0
          ? angularDiameterToRadiusKpc(row.majorAxisArcmin, distance)
          : 0
      if (radiusKpc === 0) this.localGroupWithoutSize++

      const nodeId = `lg:${row.id}`
      const parentId = hostId(row.host)
      this.addNode({
        id: nodeId,
        name: landmarkLabels.get(row.name) ?? displayName(row.name),
        objectClass: 'galaxy',
        // A catalogue host that resolves to the galaxy itself (M31's own row says
        // host = M31) would make the containment hierarchy a loop.
        parentId: parentId === nodeId ? null : parentId,
        radiusMetres: radiusKpc * KPC_M,
        worldHeliocentricKpc: helio,
        provenance: 'measured',
        provenanceNote: `Distance ${distance.toFixed(1)} kpc by ${row.distanceMethod ?? 'unstated method'} (UNGC). Extent from the catalogued D25 major axis.`,
      })

      if (radiusKpc <= 0) continue
      positions.push(sx, sy, sz)
      radii.push(radiusKpc)
      // Brightness ordering comes from the measured apparent B magnitude, with a floor
      // so a 15th-magnitude dwarf is still a faint smudge rather than nothing. The
      // floor is a presentation choice; the ordering is not.
      const mag = row.apparentBMag ?? 15
      intensities.push(clamp(10 ** (-0.4 * (mag - 8)), 0.06, 1.1))
      const tint = morphologyTint(row.morphology)
      colors.push(tint.r, tint.g, tint.b)
    }

    this.localGroupCount = radii.length
    if (radii.length === 0) return

    const geometry = new THREE.InstancedBufferGeometry()
    geometry.index = this.quad.index
    geometry.setAttribute('position', this.quad.getAttribute('position'))
    geometry.setAttribute('iPosition', new THREE.InstancedBufferAttribute(new Float32Array(positions), 3))
    geometry.setAttribute('iRadius', new THREE.InstancedBufferAttribute(new Float32Array(radii), 1))
    geometry.setAttribute('iIntensity', new THREE.InstancedBufferAttribute(new Float32Array(intensities), 1))
    geometry.setAttribute('iColor', new THREE.InstancedBufferAttribute(new Float32Array(colors), 3))
    geometry.instanceCount = radii.length

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelHeight: { value: 1080 },
        uTanHalfFov: { value: 0.46 },
        uMinRadiusPx: { value: 1.5 },
        uGain: { value: 0.5 },
      },
      vertexShader: GALAXY_VERTEX,
      fragmentShader: GALAXY_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = -4
    mesh.name = 'galaxy:local-group'
    mesh.userData = {
      provenance: 'illustration',
      note: 'Positions and sizes are measured (UNGC distances, D25 major axes). The glow itself is a stand-in: this build ships no imagery of these galaxies.',
    }
    this.helioGroup.add(mesh)
    this.geometries.push(geometry)
    this.materials.push(material)
    this.localGroupMaterial = material

    this.provenance.push({
      id: 'local-group',
      label: `${this.nodes.filter((n) => n.id.startsWith('lg:')).length} Local Group galaxies`,
      provenance: 'measured',
      note: `Positions from Cepheid/TRGB/CMD distances. Drawn extent is the measured D25 major axis; the glow filling it is an illustration. ${this.localGroupWithoutSize} of them have no published D25 and are drawn as markers only.`,
      source: file.attribution,
    })
  }

  // -------------------------------------------------------------------------
  // The disc field
  // -------------------------------------------------------------------------

  private async loadField(): Promise<void> {
    const [manifest, buffer] = await Promise.all([
      fetchJson<FieldManifest>(`${DATA}/field.json`),
      fetch(`${DATA}/field.bin`).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null),
    ])
    if (this.engine.isDisposed) return
    if (!manifest || !buffer) {
      console.warn('[omniatlas] galaxy: disc field unavailable — arms and masers only')
      return
    }

    const count = manifest.recordCount
    const field = (name: string) => manifest.fields.find((f) => f.name === name)
    const xField = field('x')
    const yField = field('y')
    const zField = field('z')
    const cField = field('colourIndex')
    if (!xField || !yField || !zField || !cField || buffer.byteLength < count * 13) {
      console.warn('[omniatlas] galaxy: field.bin does not match its manifest — skipped')
      return
    }

    // STRUCT-OF-ARRAYS: all 300,000 x, then all y, then all z, then all colour
    // indices. Reading this as interleaved triples yields a cloud that still looks
    // vaguely like a galaxy, which is precisely why it has to be checked rather than
    // eyeballed — tests/unit/galaxy.test.ts verifies the decode against the extent,
    // the disc axis ratio and the colour gradient the manifest publishes.
    const x = new Float32Array(buffer, xField.byteOffset, count)
    const y = new Float32Array(buffer, yField.byteOffset, count)
    const z = new Float32Array(buffer, zField.byteOffset, count)
    const colourIndex = new Uint8Array(buffer, cField.byteOffset, count)

    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const palette = buildPalette(manifest.colour?.palette)

    for (let i = 0; i < count; i++) {
      // Parsecs galactocentric -> kiloparsecs, scene basis, relative to the Galactic
      // centre: (-Y, Z, -X) / 1000. Vertex magnitudes stay under about 19.
      positions[i * 3] = -y[i] * 1e-3
      positions[i * 3 + 1] = z[i] * 1e-3
      positions[i * 3 + 2] = -x[i] * 1e-3

      const rgb = palette[colourIndex[i]]
      colors[i * 3] = rgb[0]
      colors[i * 3 + 1] = rgb[1]
      colors[i * 3 + 2] = rgb[2]
    }

    const geometry = new THREE.InstancedBufferGeometry()
    geometry.index = this.quad.index
    geometry.setAttribute('position', this.quad.getAttribute('position'))
    geometry.setAttribute('iPosition', new THREE.InstancedBufferAttribute(positions, 3))
    geometry.setAttribute('iColor', new THREE.InstancedBufferAttribute(colors, 3))
    geometry.instanceCount = count

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelHeight: { value: 1080 },
        uGain: { value: FIELD_GAIN },
        uMaxIntensity: { value: FIELD_MAX_INTENSITY },
        uMinRadiusPx: { value: 1.05 },
        uMaxRadiusPx: { value: 2.6 },
        uNearFadeStart: { value: FIELD_NEAR_FADE_START_KPC },
        uNearFadeEnd: { value: FIELD_NEAR_FADE_END_KPC },
      },
      vertexShader: FIELD_VERTEX,
      fragmentShader: FIELD_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = -12
    mesh.name = 'galaxy:disc-field'
    mesh.userData = {
      provenance: 'derived',
      badge: manifest.badge,
      note: manifest.statement,
    }
    this.gcGroup.add(mesh)
    this.geometries.push(geometry)
    this.materials.push(material)
    this.fieldMaterial = material
    this.fieldMesh = mesh
    this.fieldTotalInstances = count
    this.fieldCount = count

    this.provenance.push({
      id: 'disc-field',
      label: `${count.toLocaleString('en-GB')}-point disc field`,
      provenance: 'derived',
      note: manifest.statement,
      source: manifest.attribution,
    })
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  preRender(ctx: FrameContext): void {
    const layer = this.engine.layer(LAYER)
    if (!layer.active) return

    // The galactic layer's origin never moves today, but it costs one float64
    // subtraction a frame to stop depending on that.
    this.positionGalacticCentre()

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const pixelHeight = ctx.height * dpr
    const tanHalfFov = Math.tan((ctx.fovDegrees * Math.PI) / 360)

    if (this.fieldMaterial) {
      this.fieldMaterial.uniforms.uPixelHeight.value = pixelHeight

      // Density LOD for the disc field.
      //
      // Framing the whole galaxy puts all ~300,000 additive splats on screen at once,
      // and additive blending cannot use early-Z, so the cost is raw overdraw: the
      // Milky Way rung measured 23 fps against 60 everywhere else on the ladder.
      //
      // The field is a statistical realisation, not a catalogue, and the builder
      // seeded it deterministically — so a prefix of it is itself a valid, and
      // identically reproducible, realisation at lower density. Brightness is
      // compensated by the same factor, which keeps total luminance about constant
      // and makes the transition invisible.
      const mesh = this.fieldMesh
      if (mesh) {
        const geometry = mesh.geometry as THREE.InstancedBufferGeometry
        const total = this.fieldTotalInstances
        // Below about a kiloparsec on screen the field is already fading out against
        // the real star catalogue, so the full set only matters in the middle band.
        const spanKpc = ctx.viewSpanMetres / 3.0856775814913673e19
        const fraction = spanKpc > 60 ? 0.22 : spanKpc > 25 ? 0.3 : spanKpc > 8 ? 0.62 : 1
        const drawn = Math.max(1, Math.round(total * fraction))
        geometry.instanceCount = drawn
        this.fieldMaterial.uniforms.uGain.value = FIELD_GAIN * (total / drawn)
      }
    }
    if (this.maserMaterial) {
      this.maserMaterial.uniforms.uPixelHeight.value = pixelHeight
    }
    if (this.localGroupMaterial) {
      this.localGroupMaterial.uniforms.uPixelHeight.value = pixelHeight
      this.localGroupMaterial.uniforms.uTanHalfFov.value = tanHalfFov
    }

    // The arm model is a map, and a map is read from outside. Sitting inside the disc,
    // a translucent ribbon that passes through the camera fills half the screen with
    // haze and teaches nothing, so the model fades out as the camera enters the plane
    // and returns as it climbs out of it or backs away. The masers never fade: they are
    // measurements, and they stay on screen wherever the camera is.
    const camera = layer.camera
    const heightAbovePlane = Math.abs(camera.position.y - this.gcGroup.position.y)
    const distanceFromCentre = camera.position.distanceTo(this.gcGroup.position)
    //
    // The far end has the opposite problem. Past about 100 kpc the whole Galaxy is a
    // smudge a few dozen pixels across, and constant-screen-size maser glyphs drawn on
    // top of it stop being evidence and start being a misleading halo wider than the
    // thing they are evidence for. Both the model and its measurements therefore fade
    // out together at Local Group range, where the Milky Way is one object among many.
    const nearFade = Math.max(
      smoothstep(0.6, 4, heightAbovePlane),
      smoothstep(22, 40, distanceFromCentre),
    )
    const farFade = 1 - smoothstep(90, 200, distanceFromCentre)
    const fade = nearFade * farFade
    for (let i = 0; i < this.armMaterials.length; i++) {
      const material = this.armMaterials[i]
      material.opacity = this.armBaseOpacity[i] * fade
      material.visible = material.opacity > 0.004
    }
    if (this.maserMaterial) {
      this.maserMaterial.uniforms.uIntensity.value = MASER_INTENSITY * farFade
      this.maserMaterial.visible = farFade > 0.01
    }
    if (this.maserBarMaterial) {
      this.maserBarMaterial.opacity = MASER_BAR_OPACITY * farFade
      this.maserBarMaterial.visible = farFade > 0.01
    }
  }

  // -------------------------------------------------------------------------
  // Public surface: visibility toggles and the provenance table
  // -------------------------------------------------------------------------

  /** The model layer. Off by default is wrong; being unable to turn it off is worse. */
  setArmModelVisible(visible: boolean): void {
    for (const object of this.gcGroup.children) {
      if (object.name.startsWith('galaxy:arm')) object.visible = visible
    }
  }

  /** Full instance count of the disc field, before any density LOD. */
  private fieldTotalInstances = 0

  setDiscFieldVisible(visible: boolean): void {
    if (this.fieldMesh) this.fieldMesh.visible = visible
  }

  /**
   * What this module drew and where each part came from. The UI can render this
   * verbatim; nothing here needs interpreting.
   */
  provenanceIndex(): readonly ProvenanceEntry[] {
    return this.provenance
  }

  /** Counts, for the stats overlay and for an honest coverage statement. */
  census(): Record<string, number> {
    return {
      fieldPoints: this.fieldCount,
      arms: this.armCount,
      masers: this.maserCount,
      localGroupRegistered: this.nodes.filter((n) => n.id.startsWith('lg:')).length,
      localGroupDrawn: this.localGroupCount,
      localGroupWithoutDistance: this.localGroupWithoutDistance,
      localGroupWithoutSize: this.localGroupWithoutSize,
    }
  }

  dispose(): void {
    for (const node of this.nodes) this.engine.unregister(node.id)
    this.nodes.length = 0
    for (const geometry of this.geometries) geometry.dispose()
    this.geometries.length = 0
    for (const material of this.materials) material.dispose()
    this.materials.length = 0
    this.armMaterials.length = 0
    this.armBaseOpacity.length = 0
    this.quad?.dispose()
    this.gcGroup?.clear()
    this.gcGroup?.removeFromParent()
    this.helioGroup?.clear()
    this.helioGroup?.removeFromParent()
    this.fieldMaterial = null
    this.fieldMesh = null
    this.maserMaterial = null
    this.maserBarMaterial = null
    this.localGroupMaterial = null
  }

  // -------------------------------------------------------------------------

  private addNode(spec: {
    id: string
    name: string
    objectClass: string
    parentId: string | null
    radiusMetres: number
    provenance: Provenance
    provenanceNote: string
    worldGalactocentricKpc?: { x: number; y: number; z: number }
    worldHeliocentricKpc?: { x: number; y: number; z: number }
  }): ProvenancedNode {
    const helio = spec.worldHeliocentricKpc ??
      (spec.worldGalactocentricKpc
        ? {
            x: R0_KPC - spec.worldGalactocentricKpc.y,
            y: spec.worldGalactocentricKpc.x,
            z: spec.worldGalactocentricKpc.z - 0.0055,
          }
        : { x: 0, y: 0, z: 0 })

    const worldPosition: Vec3d = {
      x: helio.x * KPC_M,
      y: helio.y * KPC_M,
      z: helio.z * KPC_M,
    }

    const node: ProvenancedNode = {
      id: spec.id,
      name: spec.name,
      objectClass: spec.objectClass,
      parentId: spec.parentId,
      radiusMetres: spec.radiusMetres,
      layer: LAYER,
      frame: FRAME,
      worldPosition,
      provenance: spec.provenance,
      provenanceNote: spec.provenanceNote,
    }
    this.engine.register(node)
    this.nodes.push(node)
    return node
  }
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

/**
 * The disc field.
 *
 * Each instance is one sample of the stellar mass distribution, so its apparent
 * brightness falls as 1/d^2 like any other luminous thing. That single law is what lets
 * the same 300,000 points read as a spiral galaxy from 60 kpc out and as a band of
 * light from inside the disc, with no LOD switch and no second asset.
 *
 * The one subtlety is shot noise. A sample a few hundred parsecs away would be hundreds
 * of times brighter than one across the Galaxy, and with only 300k samples the result
 * from inside would be a scatter of hard bright dots instead of a smooth band. So above
 * a brightness ceiling the quad is *spread* instead of brightened — radius grows as
 * sqrt(flux), conserving total flux. That is also the physically right answer: a nearby
 * sample stands for a nearby patch of disc, which subtends a larger angle.
 */
const FIELD_VERTEX = /* glsl */ `
  attribute vec3 iPosition;
  attribute vec3 iColor;

  uniform float uPixelHeight;
  uniform float uGain;
  uniform float uMaxIntensity;
  uniform float uMinRadiusPx;
  uniform float uMaxRadiusPx;
  uniform float uNearFadeStart;
  uniform float uNearFadeEnd;

  varying vec3 vColor;
  varying float vIntensity;
  varying vec2 vQuad;

  void main() {
    vQuad = position.xy;

    vec4 viewPosition = modelViewMatrix * vec4(iPosition, 1.0);
    float d = length(viewPosition.xyz);

    // Inside the solar neighbourhood the atlas draws real catalogued stars. The model
    // field must not compete with them, so it fades out before it gets there.
    float near = smoothstep(uNearFadeStart, uNearFadeEnd, d);
    if (near <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float flux = uGain / (d * d + 1e-4);
    float intensity = flux;
    float radiusPx = uMinRadiusPx;
    if (intensity > uMaxIntensity) {
      radiusPx = min(uMinRadiusPx * sqrt(intensity / uMaxIntensity), uMaxRadiusPx);
      intensity = uMaxIntensity;
    }

    vIntensity = intensity * near;
    vColor = iColor;

    vec4 clip = projectionMatrix * viewPosition;
    float pixelScale = 2.0 * radiusPx / uPixelHeight;
    clip.xy += position.xy * pixelScale * clip.w;
    gl_Position = clip;
  }
`

const FIELD_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vIntensity;
  varying vec2 vQuad;

  void main() {
    float r2 = dot(vQuad, vQuad);
    if (r2 > 1.0) discard;
    float falloff = exp(-3.4 * r2);
    gl_FragColor = vec4(vColor * vIntensity * falloff, falloff);
  }
`

/** Constant-screen-size points: the masers. Evidence should not shrink with distance. */
const POINT_VERTEX = /* glsl */ `
  attribute vec3 iPosition;

  uniform float uPixelHeight;
  uniform float uRadiusPx;

  varying vec2 vQuad;

  void main() {
    vQuad = position.xy;
    vec4 viewPosition = modelViewMatrix * vec4(iPosition, 1.0);
    vec4 clip = projectionMatrix * viewPosition;
    float pixelScale = 2.0 * uRadiusPx / uPixelHeight;
    clip.xy += position.xy * pixelScale * clip.w;
    gl_Position = clip;
  }
`

const POINT_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying vec2 vQuad;

  void main() {
    float r = length(vQuad);
    if (r > 1.0) discard;
    // A ring with a core: unmistakably an instrument mark on a measured position,
    // rather than one more blob in a field of model points.
    float core = exp(-9.0 * r * r);
    float ring = smoothstep(0.52, 0.72, r) * (1.0 - smoothstep(0.78, 1.0, r));
    float a = clamp(core + ring * 0.9, 0.0, 1.0);
    gl_FragColor = vec4(uColor * uIntensity * a, a);
  }
`

/**
 * The Local Group galaxies, drawn at their true angular size from the catalogued D25
 * major axis. Below a couple of pixels the glow fades out and the atlas's own marker
 * glyph takes over, which is the same contract every other object in the product uses.
 */
const GALAXY_VERTEX = /* glsl */ `
  attribute vec3 iPosition;
  attribute float iRadius;
  attribute float iIntensity;
  attribute vec3 iColor;

  uniform float uPixelHeight;
  uniform float uMinRadiusPx;
  uniform float uGain;

  varying vec3 vColor;
  varying float vIntensity;
  varying vec2 vQuad;

  void main() {
    vQuad = position.xy;

    vec4 viewPosition = modelViewMatrix * vec4(iPosition, 1.0);
    float d = max(length(viewPosition.xyz), 1e-6);

    // True angular size in pixels, from the projection the camera is actually using.
    vec4 probe = projectionMatrix * vec4(0.0, iRadius, viewPosition.z, 1.0);
    float truePx = abs(probe.y / max(probe.w, 1e-9)) * uPixelHeight * 0.5;

    float radiusPx = max(truePx, uMinRadiusPx);
    float visible = smoothstep(1.2, 3.5, truePx);
    if (visible <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vColor = iColor;
    vIntensity = iIntensity * uGain * visible;

    vec4 clip = projectionMatrix * viewPosition;
    float pixelScale = 2.0 * radiusPx / uPixelHeight;
    clip.xy += position.xy * pixelScale * clip.w;
    gl_Position = clip;
  }
`

const GALAXY_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vIntensity;
  varying vec2 vQuad;

  void main() {
    float r2 = dot(vQuad, vQuad);
    if (r2 > 1.0) discard;
    // A soft, centrally concentrated glow. It is a stand-in for an image, not an
    // image: no structure is implied because none has been measured here.
    float falloff = exp(-3.0 * r2) * (1.0 - r2);
    gl_FragColor = vec4(vColor * vIntensity * falloff, falloff * 0.9);
  }
`

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

function offsetPoint(
  point: { x: number; y: number; z: number },
  normal: { x: number; y: number; z: number },
  distance: number,
): { x: number; y: number; z: number } {
  return {
    x: point.x + normal.x * distance,
    y: point.y + normal.y * distance,
    z: point.z + normal.z * distance,
  }
}

function pushQuad(
  out: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
): void {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
  out.push(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2])
}

function pushQuadColors(
  out: number[],
  colour: THREE.Color,
  aAlpha: number,
  bAlpha: number,
  cAlpha: number,
  dAlpha: number,
): void {
  const push = (alpha: number) => out.push(colour.r, colour.g, colour.b, alpha)
  push(aAlpha)
  push(bAlpha)
  push(cAlpha)
  push(aAlpha)
  push(cAlpha)
  push(dAlpha)
}

/**
 * The 256-entry palette, sRGB-encoded in the manifest, converted to linear and
 * normalised to equal luminance. Equal luminance matters for the same reason it does in
 * the star field: if hot points were also bright points, the age/metallicity gradient
 * would be double-encoded and the arms would simply look like the bright bits.
 */
function buildPalette(palette: [number, number, number][] | undefined): [number, number, number][] {
  const fallback: [number, number, number][] = []
  const source = palette && palette.length === 256 ? palette : null
  if (!source) {
    console.warn('[omniatlas] galaxy: field palette missing — falling back to white')
    for (let i = 0; i < 256; i++) fallback.push([1, 1, 1])
    return fallback
  }
  const out: [number, number, number][] = []
  for (const entry of source) {
    let r = srgbToLinear(entry[0] / 255)
    let g = srgbToLinear(entry[1] / 255)
    let b = srgbToLinear(entry[2] / 255)
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    if (luma > 0) {
      r /= luma
      g /= luma
      b /= luma
    }
    const peak = Math.max(r, g, b, 1)
    out.push([r / peak, g / peak, b / peak])
  }
  return out
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** Morphology to a tint. Reinforcement only; the class glyph carries the meaning. */
function morphologyTint(morphology: string | null): THREE.Color {
  if (!morphology) return new THREE.Color(0xf0c8e4)
  if (/^E|^S0|^dE|^dSph/i.test(morphology)) return new THREE.Color(0xffd8bc)
  if (/^Im|^Sm|^dIr|^BCD/i.test(morphology)) return new THREE.Color(0xb8d8ff)
  return new THREE.Color(0xf5b8e0)
}

/**
 * Catalogue identifiers to something a person reads. Only mechanical reformatting —
 * no name is invented, and anything unrecognised is passed through untouched.
 */
function displayName(name: string): string {
  const messier = /^MESSIER0*(\d+)$/i.exec(name)
  if (messier) return `M${Number(messier[1])}`
  const ngc = /^NGC0*(\d+)$/i.exec(name)
  if (ngc) return `NGC ${Number(ngc[1])}`
  const ic = /^IC0*(\d+)$/i.exec(name)
  if (ic) return `IC ${Number(ic[1])}`
  const ugc = /^UGC0*(\d+)$/i.exec(name)
  if (ugc) return `UGC ${Number(ugc[1])}`
  return name
}

function hostId(host: string): string | null {
  if (host === 'MW') return 'milky-way'
  if (host === 'M31') return 'lg:messier031'
  return null
}

export default function createGalaxyModule(): AtlasModule {
  return new GalaxyModule()
}
