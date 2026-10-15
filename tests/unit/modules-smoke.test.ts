import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { beforeAll, describe, expect, it } from 'vitest'
import { Engine, type AtlasModule } from '../../src/core/Engine'
import type { LayerId } from '../../src/core/Layer'

/**
 * Boots every content module against the real data files.
 *
 * This is not a substitute for looking at the screen, and it does not compile a single
 * shader. What it does cover is the layer below the pixels, which is where the
 * expensive mistakes live: a binary decoded against the wrong byte offsets, a module
 * that registers nothing, geometry whose vertices are too far from their own origin to
 * survive the float32 downcast, or a disposal path that leaks the scene graph.
 *
 * It also pins the one rule the whole multi-scale architecture rests on: object origins
 * may be large, vertex buffers may not.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public')

beforeAll(() => {
  // Serve public/ to the modules' fetch calls.
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

  // three.js's ImageLoader reaches for document.createElementNS to build an <img>.
  // The solar module loads body textures, so without this it cannot be constructed
  // headlessly at all. The stub never fires a load event, which is correct: these
  // tests are about geometry and registration, not pixels.
  ;(globalThis as { document?: unknown }).document = {
    createElementNS: () => ({
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      style: {},
    }),
    createElement: () => ({
      addEventListener() {},
      removeEventListener() {},
      getContext: () => null,
      style: {},
    }),
  }
})

const MODULES: { id: string; load: () => Promise<AtlasModule>; layers: LayerId[]; minNodes: number }[] = [
  {
    id: 'solar',
    load: async () => new (await import('../../src/modules/solar')).SolarModule(),
    layers: ['helio'],
    minNodes: 25,
  },
  {
    id: 'smallbodies',
    load: async () => new (await import('../../src/modules/smallbodies')).SmallBodiesModule(),
    layers: ['helio'],
    minNodes: 50,
  },
  {
    id: 'stars',
    load: async () => new (await import('../../src/modules/stars')).StarsModule(),
    layers: ['stellar'],
    minNodes: 0,
  },
  {
    id: 'deepsky',
    load: async () => new (await import('../../src/modules/deepsky')).DeepSkyModule(),
    layers: ['stellar'],
    minNodes: 50,
  },
  {
    id: 'galaxy',
    load: async () => new (await import('../../src/modules/galaxy')).GalaxyModule(),
    layers: ['galactic'],
    minNodes: 1,
  },
  {
    id: 'cosmos',
    load: async () => new (await import('../../src/modules/cosmos')).CosmosModule(),
    layers: ['cosmic'],
    minNodes: 1,
  },
  {
    // Draws nothing of its own: the proxy module renders whichever of these the
    // camera is anchored to. What it owns is positions.
    id: 'notable',
    load: async () => new (await import('../../src/modules/notable')).NotableModule(),
    layers: [],
    minNodes: 14,
  },
]

/** Largest absolute vertex coordinate in a geometry's position attribute. */
function maxVertexExtent(object: THREE.Object3D): number {
  let worst = 0
  object.traverse((child) => {
    const geometry = (child as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
    const position = geometry?.getAttribute?.('position')
    if (!position) return
    const array = position.array as ArrayLike<number>
    for (let i = 0; i < array.length; i++) {
      const value = Math.abs(array[i])
      if (value > worst) worst = value
    }
  })
  return worst
}

describe.each(MODULES)('module $id', ({ id, load, layers, minNodes }) => {
  it('initialises against the real data files and puts something in its layer', async () => {
    const engine = new Engine({ renderer: {} as never })
    const module = await load()
    await module.init(engine)

    if (layers.length > 0) {
      const drawn = layers.reduce((total, layer) => total + engine.layer(layer).scene.children.length, 0)
      expect(drawn, `${id} added nothing to ${layers.join('/')}`).toBeGreaterThan(0)
    }
    expect(engine.registry.size, `${id} registered too few objects`).toBeGreaterThanOrEqual(minNodes)

    module.dispose?.()
  })

  it('keeps vertex buffers local to their object origin', async () => {
    // The float32 budget: a coordinate beyond ~1e4 units starts losing sub-unit
    // precision, which is exactly the failure the layer system exists to prevent.
    // Anything larger belongs in an object's position, not in its vertices.
    const engine = new Engine({ renderer: {} as never })
    const module = await load()
    await module.init(engine)

    for (const layer of layers) {
      const extent = maxVertexExtent(engine.layer(layer).scene)
      expect(extent, `${id} has a vertex at ${extent.toExponential(2)} units from its object origin`).toBeLessThan(1e5)
    }

    module.dispose?.()
  })

  it('aborts cleanly if the engine is disposed mid-init', async () => {
    const engine = new Engine({ renderer: {} as never })
    const module = await load()
    // Promise.resolve: a module with no I/O to do initialises synchronously, and
    // `init` is declared to return void or a promise.
    const booting = Promise.resolve(module.init(engine))
    engine.dispose()
    // React StrictMode mounts, unmounts and remounts every effect in development, so
    // a boot started by the first mount is still in flight when the second tears its
    // engine down. A module that touches the scene graph afterwards throws here.
    await expect(booting).resolves.toBeUndefined()
    expect(engine.registry.size).toBe(0)
  })

  it('registers every node with a finite position and a known layer', async () => {
    const engine = new Engine({ renderer: {} as never })
    const module = await load()
    await module.init(engine)

    for (const node of engine.registry.values()) {
      const { x, y, z } = node.worldPosition
      expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), `${node.id} has a non-finite position`).toBe(
        true,
      )
      expect(node.radiusMetres, `${node.id} has a negative radius`).toBeGreaterThanOrEqual(0)
      expect(engine.layers.has(node.layer), `${node.id} claims unknown layer ${node.layer}`).toBe(true)
      expect(node.name.length, `${node.id} has no name`).toBeGreaterThan(0)
    }

    module.dispose?.()
  })
})

describe('all modules together', () => {
  it('boot concurrently without colliding on ids', async () => {
    const engine = new Engine({ renderer: {} as never })
    await engine.loadModules(MODULES.map(({ id, load }) => ({ id, load })))

    expect(engine.failedModules, 'a module failed to load').toEqual([])
    expect(engine.modules.length).toBe(MODULES.length)
    // Every registry key is unique by construction; what this really checks is that
    // two modules did not quietly claim the same object and overwrite each other.
    expect(engine.registry.size).toBeGreaterThan(200)

    const sun = engine.node('sun')
    expect(sun, 'the Sun went missing after all modules loaded').toBeTruthy()
    expect(sun!.name).toBe('Sun')

    engine.dispose()
    expect(engine.registry.size).toBe(0)
  })
})
