import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { Engine, layerApproaching } from '../../src/core/Engine'
import { LAYER_CONFIGS } from '../../src/core/Layer'

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public')

beforeAll(() => {
  // Serve public/ to the module's fetch calls, the same way `modules-smoke` does. The
  // registration assertion below is about what init does with the REAL files; stubbing
  // the data would let it pass against a module that reads nothing.
  ;(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
    const file = PUBLIC + String(url)
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
})

/**
 * What is allowed to wait, and how early it is asked for.
 *
 * Two datasets are purely visual and mean nothing until the camera reaches a particular
 * rung: the Milky Way's disc field (3.5 MB) and the 2MRS field (0.6 MB). Both used to be
 * fetched during module init, before the first frame, for every visitor including the
 * ones who never leave the inner system. They now wait for `layerApproaching`.
 *
 * The margin is the whole point and is easy to lose in a refactor. Fetching when a layer
 * goes ACTIVE is too late — the download then happens while the content is already
 * wanted, which is a hole in the view rather than a saving. Fetching a decade early is
 * what makes it invisible, and that decade is what these tests hold.
 */

function engine() {
  return new Engine({ renderer: {} as never })
}

/** Span floors, read from the configuration rather than restated. */
const GALACTIC_FLOOR = LAYER_CONFIGS.find((c) => c.id === 'galactic')!.spanBandMetres[0]
const COSMIC_FLOOR = LAYER_CONFIGS.find((c) => c.id === 'cosmic')!.spanBandMetres[0]

describe('layerApproaching', () => {
  it('is false across the whole solar system, which is the point', () => {
    const e = engine()
    // A few AU, the default view: the widest a planetary view ever gets is ~1e13 m.
    for (const span of [1e7, 6e11, 1.3e13, 1.5e14]) {
      expect(layerApproaching(e, 'galactic', span), `galactic at span ${span}`).toBe(false)
      expect(layerApproaching(e, 'cosmic', span), `cosmic at span ${span}`).toBe(false)
    }
  })

  it('fires a decade before the layer would draw, not when it draws', () => {
    const e = engine()
    // Just inside the floor: the layer is not drawing yet and the fetch is already out.
    expect(layerApproaching(e, 'galactic', GALACTIC_FLOOR / 5)).toBe(true)
    expect(layerApproaching(e, 'cosmic', COSMIC_FLOOR / 5)).toBe(true)
    // A full decade below: still too early, and that is the budget's far edge.
    expect(layerApproaching(e, 'galactic', GALACTIC_FLOOR / 20)).toBe(false)
    expect(layerApproaching(e, 'cosmic', COSMIC_FLOOR / 20)).toBe(false)
  })

  it('is true once the layer is in its own span band', () => {
    const e = engine()
    expect(layerApproaching(e, 'galactic', GALACTIC_FLOOR * 10)).toBe(true)
    expect(layerApproaching(e, 'cosmic', COSMIC_FLOOR * 10)).toBe(true)
  })

  it('takes an explicit margin', () => {
    const e = engine()
    expect(layerApproaching(e, 'cosmic', COSMIC_FLOOR / 50, 1)).toBe(false)
    expect(layerApproaching(e, 'cosmic', COSMIC_FLOOR / 50, 2)).toBe(true)
  })
})

describe('the deferral is only safe for content that registers nothing', () => {
  it('keeps the searchable catalogues out of the deferred set', async () => {
    // CF4 and UNGC rows are destinations: they are in the registry, they are in search,
    // and the viewer snapshots the registry into the label engine once after module
    // load. Deferring either would make a catalogue findable only by flying to it
    // first. This asserts the cosmos module still registers them from `init` alone,
    // with no frame ever having run.
    const { CosmosModule } = await import('../../src/modules/cosmos/index')
    const e = engine()
    const module = new CosmosModule()
    await module.init(e)

    const ids = [...e.registry.keys()]
    expect(ids.some((id) => id.startsWith('cf4:')), 'CF4 groups must register during init').toBe(true)
    expect(ids.some((id) => id.startsWith('ungc:')), 'UNGC galaxies must register during init').toBe(true)

    module.dispose?.()
  })
})
