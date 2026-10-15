import type { AtlasModule, Engine } from '../../core/Engine'
import type { LayerId } from '../../core/Layer'
import { MPC_M, PC_M, type Vec3d, convertFrame, sphericalToCartesian, vec3d } from '../../core/world'
import { comovingDistanceMpc } from '../../astronomy/cosmology'
import { NOTABLE_OBJECTS, notableRadiusMetres } from '../../data/notableObjects'

/**
 * The hand-listed objects: black holes, quasars, and the far edge of the observed
 * universe.
 *
 * A thin module by design. It owns no geometry — the proxy module draws whichever of
 * these the camera is anchored to, because one shadow-and-accretion-disc at a time is
 * all anyone can look at and building sixteen of them for a frame that shows none
 * would be waste. What this module owns is their positions.
 */

/** Positions are given as ICRS right ascension and declination. */
const FRAME = 'icrf' as const

/**
 * Which layer draws an object, by how far away it is.
 *
 * Each layer renders in its own unit — parsecs, kiloparsecs, megaparsecs — and a
 * position only keeps its precision in the layer whose unit matches its magnitude.
 * Putting TON 618 in the stellar layer would ask float32 to hold 1.7 billion
 * parsecs, where one unit in the last place is 128 parsecs.
 */
function layerForDistance(metres: number): LayerId {
  if (metres < 3e21) return 'stellar' // under ~100 kpc
  if (metres < 3e24) return 'galactic' // under ~100 Mpc
  return 'cosmic'
}

export class NotableModule implements AtlasModule {
  readonly id = 'notable'
  private engine!: Engine
  private readonly registeredIds: string[] = []

  init(engine: Engine): void {
    this.engine = engine

    let placedByRedshift = 0
    for (const object of NOTABLE_OBJECTS) {
      const distanceMetres =
        object.distancePc !== undefined
          ? object.distancePc * PC_M
          : object.redshift !== undefined
            ? comovingDistanceMpc(object.redshift) * MPC_M
            : 0
      if (!(distanceMetres > 0)) {
        console.warn(`[omniatlas] notable object ${object.id} has no usable distance; skipped`)
        continue
      }
      if (object.distancePc === undefined) placedByRedshift++

      const icrf: Vec3d = sphericalToCartesian(vec3d(), object.raDeg, object.decDeg, distanceMetres)
      const layer = layerForDistance(distanceMetres)
      // Store the position in the layer's own frame, so neither the registry nor the
      // renderer repeats the rotation on every frame.
      const layerFrame = this.engine.layer(layer).config.frame
      const worldPosition = convertFrame(vec3d(), icrf, FRAME, layerFrame)

      this.engine.register({
        id: object.id,
        worldPosition,
        frame: layerFrame,
        radiusMetres: notableRadiusMetres(object),
        layer,
        objectClass: object.objectClass,
        name: object.name,
        parentId: null,
      })
      this.registeredIds.push(object.id)
    }

    console.info(
      `[omniatlas] notable: ${this.registeredIds.length} objects registered ` +
        `(${placedByRedshift} placed from redshift at comoving distance, Planck 2018)`,
    )
  }

  dispose(): void {
    for (const id of this.registeredIds) this.engine.unregister(id)
    this.registeredIds.length = 0
  }
}
