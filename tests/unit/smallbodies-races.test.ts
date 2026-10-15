import { describe, expect, it, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import { Engine } from '../../src/core/Engine'
import { vec3d } from '../../src/core/world'

import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public')

beforeAll(() => {
  ;(globalThis as any).fetch = async (url: string) => {
    const p = ROOT + String(url)
    if (!fs.existsSync(p)) return { ok: false, status: 404 } as any
    const buf = fs.readFileSync(p)
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(buf.toString('utf8')),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    } as any
  }
  ;(globalThis as any).window = { devicePixelRatio: 1 }
})

describe('smallbodies races and edge cases', () => {
  it('lists registered ids; shows pluto collision when smallbodies wins the race', async () => {
    const { SmallBodiesModule } = await import('../../src/modules/smallbodies')
    const engine = new Engine({ renderer: {} as any })
    const mod = new SmallBodiesModule()
    await mod.init(engine)
    const ids = [...engine.registry.keys()]
    console.log('HAS pluto?', engine.registry.has('pluto'))
    console.log('IDS', ids.join(','))
    const comets = [...engine.registry.values()].filter((n) => n.objectClass === 'comet')
    console.log('COMET NAMES', comets.slice(0, 12).map((c) => c.name).join(' | '))
    const bad = [...engine.registry.values()].filter((n) => !Number.isFinite(n.worldPosition.x))
    console.log('non-finite positions', bad.length)
    // distances sanity
    const AU = 1.495978707e11
    const far = [...engine.registry.values()]
      .map((n) => [n.name, Math.hypot(n.worldPosition.x, n.worldPosition.y, n.worldPosition.z) / AU] as [string, number])
      .sort((a, b) => b[1] - a[1])
    console.log('farthest', far.slice(0, 5).map(([n, d]) => `${n}=${d.toFixed(2)}AU`).join(' | '))
    console.log('nearest', far.slice(-5).map(([n, d]) => `${n}=${d.toFixed(3)}AU`).join(' | '))
    mod.dispose()
  })

  it('does NOT clobber a pre-existing solar pluto, and dispose does not remove it', async () => {
    const { SmallBodiesModule } = await import('../../src/modules/smallbodies')
    const engine = new Engine({ renderer: {} as any })
    const solarPluto = {
      id: 'pluto',
      worldPosition: vec3d(1, 2, 3),
      frame: 'ecliptic' as const,
      radiusMetres: 1188300,
      layer: 'helio' as const,
      objectClass: 'dwarf',
      name: 'Pluto',
      parentId: 'sun',
    }
    engine.register(solarPluto)
    const mod = new SmallBodiesModule()
    await mod.init(engine)
    console.log('pluto after init is solar?', engine.registry.get('pluto') === solarPluto, 'stats.dup', mod.stats.namedDuplicateOfExisting)
    mod.dispose()
    console.log('pluto survives smallbodies dispose?', engine.registry.has('pluto'))
    expect(engine.registry.get('pluto')).toBe(solarPluto)
  })
})
