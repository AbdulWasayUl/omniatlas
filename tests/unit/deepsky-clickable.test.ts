import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as THREE from 'three'
import { beforeAll, describe, expect, it } from 'vitest'
import { Engine, type SceneNodeHandle } from '../../src/core/Engine'
import { DeepSkyModule } from '../../src/modules/deepsky'
import { PC_M, sphericalToCartesian, vec3d } from '../../src/core/world'

/**
 * Everything the deep sky draws can be clicked, and it draws nothing it cannot place.
 *
 * ## The failure
 *
 * A marker is the only pick target in this atlas, and a marker comes from a registry
 * node. The registry was filled from `ngc-names.json`, a list of the objects that have
 * NAMES, while the field was drawn from `ngc.bin`, the catalogue. So 13,174 of the
 * 13,371 NGC/IC objects were drawn and unreachable, 10,775 of them as oriented
 * ellipses that look exactly like something you could click.
 *
 * At 715 kly the screen was full of pink ellipses and the number of deep-sky objects a
 * click could reach was ZERO, because the nodes that did exist named the `stellar`
 * layer and the copy on screen was the `galactic` one.
 *
 * ## What this pins
 *
 * The invariant, not the number: drawn and clickable are the same set. A row this
 * module declines to own, it declines to draw — that is how the Harris globulars and
 * the catalogue's stars are settled — so the two directions are both checked.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public')

beforeAll(() => {
  ;(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
    const file = ROOT + String(url)
    if (!fs.existsSync(file)) return { ok: false, status: 404 }
    const buffer = fs.readFileSync(file)
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(buffer.toString('utf8')),
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      text: async () => buffer.toString('utf8'),
    }
  }
  ;(globalThis as { window?: unknown }).window = { devicePixelRatio: 1 }
})

/** The module's row bookkeeping, which is private to everything but a test. */
interface Internals {
  designationToRow: Map<string, number>
  rowToInstance: Map<number, number>
  rowToDisc: Map<number, number>
  pointPlacement: { unitPc: number; distance: { getX(i: number): number }; radius: { getX(i: number): number } }[]
  pointMagAttribute: { getX(i: number): number }
  manifest: {
    named: { literature: number; drawnFromLiterature: number }
    outlines: { outlines: number; matchedToCatalogue: number; complexesRegistered: number }
  }
  outlinesSettled: Promise<void>
  update(): void
}

/** Where one catalogue row is drawn, in parsecs, read back out of the vertex buffers. */
function drawnAt(inner: Internals, designation: string): { distancePc: number; radiusPc: number; absoluteMag: number } {
  const instance = inner.rowToInstance.get(inner.designationToRow.get(designation) as number) as number
  const buffer = inner.pointPlacement[0]
  return {
    distancePc: buffer.distance.getX(instance) * buffer.unitPc,
    radiusPc: buffer.radius.getX(instance) * buffer.unitPc,
    absoluteMag: inner.pointMagAttribute.getX(instance),
  }
}

/** Past the magnitude limit by construction: the vertex shader collapses the sprite. */
const SUPPRESSED = 90

async function boot(): Promise<{ engine: Engine; module: DeepSkyModule; inner: Internals }> {
  const engine = new Engine({ renderer: {} as never })
  const module = new DeepSkyModule()
  await module.init(engine)
  return { engine, module, inner: module as unknown as Internals }
}

function magnitudes(engine: Engine, name: string): Float32Array {
  let found: Float32Array | null = null
  engine.layer('galactic').scene.traverse((object) => {
    if (object.name !== name) return
    found = (object as THREE.Mesh).geometry.getAttribute('dsMag').array as Float32Array
  })
  if (!found) throw new Error(`no mesh called ${name}`)
  return found
}

describe('the deep sky is as clickable as it is visible', () => {
  it('registers a node for every sprite it actually draws', async () => {
    const { engine, module, inner } = await boot()
    const mags = magnitudes(engine, 'deepsky:ngc:galactic')

    const unreachable: string[] = []
    let drawn = 0
    for (const [designation, row] of inner.designationToRow) {
      const instance = inner.rowToInstance.get(row)
      // Not drawn at all: a duplicate listing or a row the catalogue retracts.
      if (instance === undefined) continue
      if (mags[instance] >= SUPPRESSED) continue
      drawn++
      if (!engine.registry.has(`ngc:${designation}`)) unreachable.push(designation)
    }

    // The whole catalogue, not a famous subset of it.
    expect(drawn).toBeGreaterThan(12_000)
    expect(unreachable).toEqual([])
    module.dispose?.()
  })

  it('draws nothing it has handed to another catalogue', async () => {
    const { engine, module, inner } = await boot()
    const mags = magnitudes(engine, 'deepsky:ngc:galactic')

    // 47 Tucanae is Harris's, by its own measurement; the OpenNGC row for it is
    // dropped from the registry AND from the sky, rather than drawn twice in two
    // places at two distances.
    expect(engine.registry.has('gc:ngc104')).toBe(true)
    expect(engine.registry.has('ngc:NGC0104')).toBe(false)
    const row = inner.designationToRow.get('NGC0104')
    expect(row).toBeDefined()
    expect(mags[inner.rowToInstance.get(row as number) as number]).toBeGreaterThanOrEqual(SUPPRESSED)

    module.dispose?.()
  })

  it('routes labels to whichever copy of the sky is on screen', async () => {
    const { engine, module } = await boot()
    // Both layers draw the field; a node that names only one stops being clickable
    // the moment the other is the one being drawn, which at 715 kly was all of them.
    for (const id of ['ngc:NGC5194', 'gc:ngc104']) {
      const node = engine.node(id)
      expect(node?.layer, id).toBe('stellar')
      expect(node?.alsoDrawnIn, id).toContain('galactic')
    }
    module.dispose?.()
  })

  it('states the size a bearing is drawn at without calling it a measurement', async () => {
    const { engine, module } = await boot()
    // The Horsehead rule: a radius derived from the 100 kpc shell is not a radius. But
    // the thing IS forty pixels across, and the label engine rations ink by what is on
    // screen, so the drawn size has to be stated somewhere that is not `radiusMetres`.
    const bearing = [...engine.registry.values()].find(
      (node) => node.id.startsWith('ngc:') && (node as { directionOnly?: boolean }).directionOnly === true,
    )
    expect(bearing).toBeDefined()
    expect(bearing?.radiusMetres).toBe(0)
    expect(bearing?.drawnRadiusMetres).toBeGreaterThan(0)
    module.dispose?.()
  })

  it('stops drawing a bearing once another catalogue measures the same object', async () => {
    const { engine, module, inner } = await boot()
    const discs = magnitudes(engine, 'deepsky:discs:galactic')
    const row = inner.designationToRow.get('ESO056-115') as number
    const disc = inner.rowToDisc.get(row) as number
    expect(disc).toBeDefined()

    // OpenNGC has no distance it trusts for the Large Magellanic Cloud, so the field
    // projects it onto the 100 kpc shell and draws it there at the 10.7 degrees of sky
    // it covers: a pink ellipse 63 pixels across, 140 pixels from the LMC's own
    // measured marker, with no label of its own because the label dedupe had already
    // merged the two names into one. That ring is what started this.
    expect(discs[disc]).toBeLessThan(SUPPRESSED)

    const ra = 80.894
    const dec = -69.756
    const measured: SceneNodeHandle = {
      id: 'lg:lmc',
      name: 'Large Magellanic Cloud',
      worldPosition: sphericalToCartesian(vec3d(), ra, dec, 49_970 * PC_M),
      frame: 'icrf',
      radiusMetres: 1.5e20,
      layer: 'galactic',
      objectClass: 'galaxy',
      parentId: null,
    }
    engine.register(measured)
    inner.update()

    expect(discs[disc]).toBeGreaterThanOrEqual(SUPPRESSED)
    // The row keeps its registry entry: the designation is still a true thing to
    // search for, and nothing is drawn for it, so nothing is left unclickable.
    expect(engine.registry.has('ngc:ESO056-115')).toBe(true)
    module.dispose?.()
  })

  it('gives the traced regions that are in no catalogue a node of their own', async () => {
    const { engine, module, inner } = await boot()
    // The outlines land after init resolves; the registry is not complete until here.
    await inner.outlinesSettled

    // OpenNGC traces 379 contours. Most sit on a catalogue row, which already has a
    // node, so a click in the contour reaches it. The rest belong to regions the
    // catalogue does not number, and those used to be the largest shapes on the
    // screen with nothing behind them.
    const { outlines, matchedToCatalogue, complexesRegistered } = inner.manifest.outlines
    expect(outlines).toBeGreaterThan(300)
    expect(matchedToCatalogue).toBeLessThan(outlines)
    expect(complexesRegistered).toBeGreaterThan(0)

    for (const name of ['Orion', 'Cygnus', 'Vela']) {
      const node = engine.node(`region:${name}`)
      expect(node, name).toBeTruthy()
      // The contour is a shape on the sky, not an extent in space.
      expect(node?.radiusMetres, name).toBe(0)
      expect(node?.drawnRadiusMetres, name).toBeGreaterThan(0)
      expect((node as { provenance?: string } | null)?.provenance, name).toBe('illustration')
    }
    module.dispose?.()
  })

  it('matches an outline to the row its catalogue spells differently', async () => {
    const { engine, module, inner } = await boot()
    await inner.outlinesSettled

    // The Pleiades, the Cave Nebula and the LMC are all traced under a name the
    // catalogue does not use for them. Unaliased they looked like regions, so they
    // would have been registered a SECOND time here, next to the row that already
    // had them.
    for (const name of ['M045', 'C9', 'LMC']) {
      expect(engine.registry.has(`region:${name}`), name).toBe(false)
    }
    for (const designation of ['Mel022', 'C009', 'ESO056-115']) {
      expect(engine.registry.has(`ngc:${designation}`), designation).toBe(true)
    }
    module.dispose?.()
  })

  it('leaves a bearing alone when nothing else in the atlas measures it', async () => {
    const { engine, module, inner } = await boot()
    const discs = magnitudes(engine, 'deepsky:discs:galactic')
    const before = [...inner.rowToDisc.values()].filter((disc) => discs[disc] < SUPPRESSED).length

    engine.register({
      id: 'made-up:thing',
      name: 'Not A Galaxy In This Catalogue',
      worldPosition: sphericalToCartesian(vec3d(), 12, 34, 1e22),
      frame: 'icrf',
      radiusMetres: 1e20,
      layer: 'galactic',
      objectClass: 'galaxy',
      parentId: null,
    })
    inner.update()

    expect([...inner.rowToDisc.values()].filter((disc) => discs[disc] < SUPPRESSED).length).toBe(before)
    module.dispose?.()
  })
})

/**
 * The picture and the registry agree about where a thing is.
 *
 * The named pass falls back to a published distance before it falls back to the
 * direction-only shell; the field, which reads `ngc.bin` and nothing else, has no such
 * table. So 43 rows were REGISTERED at one distance and DRAWN at another — the Orion
 * Nebula at 412 parsecs in the inspector and a hundred thousand on screen, which is the
 * kind of disagreement nothing reports and everything downstream inherits: fly there
 * and the proxy is built at one of the two numbers and the catalogue's own glyph is at
 * the other.
 */
describe('rows placed from the literature', () => {
  it('draws every one of them at the distance it registered them at', async () => {
    const { engine, module, inner } = await boot()
    expect(inner.manifest.named.literature).toBeGreaterThan(0)
    expect(inner.manifest.named.drawnFromLiterature).toBe(inner.manifest.named.literature)

    // The Orion Nebula: no OpenNGC distance this module will trust, a consensus 412 pc
    // in the literature table, and the glyph now at the same 412 pc as the node.
    const node = engine.node('ngc:NGC1976') as SceneNodeHandle & { distanceSource: string }
    expect(node.distanceSource).toBe('literature')
    const { x, y, z } = node.worldPosition
    const nodePc = Math.hypot(x, y, z) / PC_M
    const drawn = drawnAt(inner, 'NGC1976')
    expect(drawn.distancePc).toBeCloseTo(nodePc, 0)
    expect(drawn.radiusPc).toBeGreaterThan(0)

    module.dispose?.()
  })

  it('converts the magnitude instead of carrying it across', async () => {
    const { module, inner } = await boot()
    // A bearing carries what Earth sees and the shader leaves it alone; a placed object
    // carries an absolute magnitude the shader reduces by its true distance. Copying
    // the first into the second makes a 4th-magnitude nebula an ABSOLUTE 4.
    const { absoluteMag, distancePc } = drawnAt(inner, 'NGC1976')
    expect(absoluteMag).toBeLessThan(0)
    // ...and reducing it back by the distance returns the catalogue's own apparent one.
    const apparent = absoluteMag + 5 * (Math.log10(distancePc) - 1)
    expect(apparent).toBeGreaterThan(0)
    expect(apparent).toBeLessThan(12)
    module.dispose?.()
  })

  it('does not invent an extent for a row the binary gives no size for', async () => {
    const { module, inner } = await boot()
    // The Coalsack's seven degrees come from the literature table, not from OpenNGC,
    // and they frame a camera rather than describe a bright object: it is a DARK
    // nebula. Scaling the radius already in the buffer cannot give it one, which is
    // exactly why the placement scales rather than recomputing from the angular axis.
    expect(drawnAt(inner, 'C099').radiusPc).toBe(0)
    expect(drawnAt(inner, 'C099').distancePc).toBeCloseTo(180, 0)
    module.dispose?.()
  })
})
