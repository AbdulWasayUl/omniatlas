import * as THREE from 'three'
import type { AtlasModule, Engine, FrameContext, SceneNodeHandle } from '../../core/Engine'
import { MPC_M, vec3d } from '../../core/world'
import {
  PLANCK18,
  Z_LAST_SCATTERING,
  angularDiameterDistanceMpc,
  comovingDistanceMpc,
  lookbackTimeGyr,
  particleHorizonMpc,
} from '../../astronomy/cosmology'
import { spanVisibility } from '../../core/render/spanFade'

/**
 * The edge of what can be seen: the last-scattering surface and the particle horizon.
 *
 * ## The one rung whose radius is actually known
 *
 * Everything else at the far end of this atlas is a measurement with a wide error bar
 * or, in the Oort cloud's case, a round number off a guess. This one is different: the
 * particle horizon falls out of the Planck 2018 parameters with a precision of better
 * than a percent, and it is the most sharply determined boundary in the whole model.
 *
 *     last-scattering surface   13,864.7 Mpc   45.22 Gly   what you can see
 *     particle horizon          14,145.3 Mpc   46.14 Gly   what could ever have been seen
 *
 * They differ by 2%, which is the 380,000 years of opaque plasma between the Big Bang
 * and the moment the universe cooled enough to let light through. Both are drawn, and
 * the gap between them is that era.
 *
 * ## The part that is slippery, which is not the number
 *
 * It is a COMOVING distance. The matter that emitted the microwave background is 45.22
 * Gly away *now*, 13.79 billion years after it emitted the light that is arriving. When
 * it emitted that light it was 41.5 million light years away — the angular diameter
 * distance is 12.71 Mpc — so the same surface has two "distances" differing by a factor
 * of a thousand, and both are correct answers to different questions. The inspector
 * says so, because a single number labelled "distance" here would be the most
 * confidently wrong thing in the atlas.
 *
 * It is also not an edge. Nothing happens there; it is where our light cone runs out.
 * The universe is not known to end at it and is generally expected not to.
 *
 * ## Why it is drawn as a confident grid
 *
 * Deliberately unlike the heliosphere, whose wireframe fades away from the two places a
 * spacecraft crossed it, and unlike the Oort cloud, which is a scatter of invented
 * points. This surface is uniform, and it is uniform because it is known — the same
 * everywhere to one part in a hundred thousand, which is the single most precisely
 * measured fact about the universe at large. Drawing all three the same way would have
 * thrown that distinction away.
 */

const LAYER = 'cosmic' as const
/** The cosmic layer's frame; a shell centred on the observer is the same in any. */
const FRAME = 'supergalactic' as const

/** Rings and meridians. Fine, because this surface is smooth and known to be. */
const RINGS = 24
const MERIDIANS = 48

/** Mpc to billions of light years, for the figures the inspector quotes. */
const GLY_PER_MPC = 3.2615638e-3

interface Shell {
  mesh: THREE.LineSegments
  material: THREE.LineBasicMaterial
  baseOpacity: number
}

export class HorizonModule implements AtlasModule {
  readonly id = 'horizon'
  private engine!: Engine
  private readonly nodeIds: string[] = []
  private readonly shells: Shell[] = []
  private geometry: THREE.BufferGeometry | null = null

  readonly manifest = {
    particleHorizonMpc: 0,
    lastScatteringMpc: 0,
    /** How far away that surface was when it emitted the light we see, Mpc. */
    emissionDistanceMpc: 0,
    lookbackGyr: 0,
  }

  init(engine: Engine): void {
    this.engine = engine

    const horizonMpc = particleHorizonMpc()
    const lastScatteringMpc = comovingDistanceMpc(Z_LAST_SCATTERING)
    const emissionMpc = angularDiameterDistanceMpc(Z_LAST_SCATTERING)
    const lookback = lookbackTimeGyr(Z_LAST_SCATTERING)
    this.manifest.particleHorizonMpc = horizonMpc
    this.manifest.lastScatteringMpc = lastScatteringMpc
    this.manifest.emissionDistanceMpc = emissionMpc
    this.manifest.lookbackGyr = lookback

    // One unit sphere, two meshes, two scales. The vertex buffer holds numbers no
    // bigger than 1 while the shells sit 14,000 units out, which is the only way to
    // draw something this large and keep inside the float32 bound the layer states:
    // 14,145 in a vertex buffer is 1.4 orders past the ~1e4 limit in Layer.ts.
    this.geometry = this.buildUnitGrid()

    this.addShell(lastScatteringMpc, 0x9ec5ff, 0.55, 'horizon:last-scattering')
    this.addShell(horizonMpc, 0xffd79a, 0.4, 'horizon:particle')

    this.registerNodes(horizonMpc, lastScatteringMpc, emissionMpc, lookback)

    console.info(
      `[omniatlas] horizon: last scattering at ${(lastScatteringMpc * GLY_PER_MPC).toFixed(2)} Gly comoving, ` +
        `particle horizon at ${(horizonMpc * GLY_PER_MPC).toFixed(2)} Gly, ` +
        `emitted when that surface was ${(emissionMpc * GLY_PER_MPC * 1000).toFixed(1)} Mly away`,
      this.manifest,
    )
  }

  /** A lat/long wireframe on the unit sphere. */
  private buildUnitGrid(): THREE.BufferGeometry {
    const points: number[] = []
    const at = (theta: number, phi: number): [number, number, number] => [
      Math.sin(theta) * Math.cos(phi),
      Math.sin(theta) * Math.sin(phi),
      Math.cos(theta),
    ]
    for (let r = 1; r < RINGS; r++) {
      const theta = (r / RINGS) * Math.PI
      for (let m = 0; m < MERIDIANS; m++) {
        const a = at(theta, (m / MERIDIANS) * Math.PI * 2)
        const b = at(theta, ((m + 1) / MERIDIANS) * Math.PI * 2)
        points.push(...a, ...b)
      }
    }
    for (let m = 0; m < MERIDIANS; m++) {
      const phi = (m / MERIDIANS) * Math.PI * 2
      for (let r = 0; r < RINGS; r++) {
        const a = at((r / RINGS) * Math.PI, phi)
        const b = at(((r + 1) / RINGS) * Math.PI, phi)
        points.push(...a, ...b)
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3))
    return geometry
  }

  private addShell(radiusMpc: number, color: number, opacity: number, name: string): void {
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const mesh = new THREE.LineSegments(this.geometry as THREE.BufferGeometry, material)
    mesh.name = name
    mesh.frustumCulled = false
    mesh.renderOrder = -10
    // Radius goes in the model matrix, which three.js builds on the CPU in doubles.
    mesh.scale.setScalar(radiusMpc)
    this.engine.layer(LAYER).scene.add(mesh)
    this.shells.push({ mesh, material, baseOpacity: opacity })
  }

  private registerNodes(horizonMpc: number, lastScatteringMpc: number, emissionMpc: number, lookback: number): void {
    const emissionMly = emissionMpc * GLY_PER_MPC * 1000
    const slippery =
      `This is a COMOVING distance: where that matter is now, ${lookback.toFixed(2)} billion years after it ` +
      `emitted the light now arriving. When it emitted that light it was ${emissionMly.toFixed(1)} million ` +
      `light years away. Both numbers are correct answers to different questions, and they differ by a ` +
      `factor of about a thousand.`

    const shared = {
      worldPosition: vec3d(),
      frame: FRAME,
      // Not a body. The radius is known to better than a percent and is still not a
      // "mean radius" of anything — it is how far light has had time to come.
      radiusMetres: 0,
      layer: LAYER,
      objectClass: 'region' as const,
      parentId: null,
      // The Planck parameters are measured; these distances are integrated from them.
      // `cosmology.json` says exactly that about itself and this follows it.
      provenance: 'derived' as const,
    }

    const cmb: SceneNodeHandle & { provenance: string; provenanceNote: string; caveat: string } = {
      ...shared,
      id: 'horizon:cmb',
      name: 'Cosmic microwave background',
      framingRadiusMetres: lastScatteringMpc * MPC_M,
      caveat:
        `The furthest thing it is possible to see, at ${(lastScatteringMpc * GLY_PER_MPC).toFixed(2)} billion ` +
        `light years. Not an edge of the universe — only the point where the universe was last opaque, ` +
        `380,000 years after the Big Bang, beyond which light could not travel freely.`,
      provenanceNote: `${slippery} Integrated from the Planck 2018 parameters (H0 ${PLANCK18.H0} km/s/Mpc), at z = ${Z_LAST_SCATTERING}.`,
    }

    const horizon: SceneNodeHandle & { provenance: string; provenanceNote: string; caveat: string } = {
      ...shared,
      id: 'horizon:particle',
      name: 'Observable universe',
      framingRadiusMetres: horizonMpc * MPC_M,
      caveat:
        `${(horizonMpc * GLY_PER_MPC).toFixed(2)} billion light years: the distance light has had time to ` +
        `travel since the Big Bang, which is more than 13.8 billion because space expanded while it was ` +
        `travelling. The 2% between this and the microwave background is the opaque era before it.`,
      provenanceNote: `${slippery} Integrated from the Planck 2018 parameters (H0 ${PLANCK18.H0} km/s/Mpc).`,
    }

    for (const node of [cmb, horizon]) {
      this.engine.register(node)
      this.nodeIds.push(node.id)
    }
  }

  preRender(ctx: FrameContext): void {
    const layer = this.engine.layer(LAYER)
    const visibility = spanVisibility(ctx.viewSpanMetres, this.manifest.particleHorizonMpc * 2 * MPC_M)
    for (const shell of this.shells) {
      shell.mesh.visible = visibility > 0.004
      shell.material.opacity = shell.baseOpacity * visibility * layer.renderOpacity
    }
  }

  dispose(): void {
    for (const shell of this.shells) {
      shell.mesh.removeFromParent()
      shell.material.dispose()
    }
    this.shells.length = 0
    this.geometry?.dispose()
    this.geometry = null
    for (const id of this.nodeIds) this.engine?.unregister(id)
    this.nodeIds.length = 0
  }
}
