import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as THREE from 'three'
import { beforeAll, describe, expect, it } from 'vitest'
import { Engine } from '../../src/core/Engine'
import { OortModule, OORT_SHELL_BOUNDS } from '../../src/modules/oort'
import { SmallBodiesModule } from '../../src/modules/smallbodies'
import { AU_M, PC_M } from '../../src/core/world'

/**
 * The Oort cloud is the one structure here nobody has ever seen, and the tests are
 * mostly about keeping that straight.
 *
 * The shell is invented and must say so. The orbits through it are real JPL solutions
 * and must reach the distances and the inclinations they actually reach, because those
 * two facts — aphelia in the thousands of AU, inclinations over the whole sky — ARE
 * the argument that the cloud exists and is a sphere rather than a belt.
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

interface Internals {
  manifest: {
    shellPoints: number
    orbitsDrawn: number
    nodesRegistered: number
    alreadyRegistered: number
    farthestAphelionAu: number
    inclinationRange: [number, number]
  }
}

async function boot(): Promise<{ engine: Engine; module: OortModule; inner: Internals }> {
  const engine = new Engine({ renderer: {} as never })
  const module = new OortModule()
  await module.init(engine)
  return { engine, module, inner: module as unknown as Internals }
}

function mesh(engine: Engine, name: string): THREE.BufferGeometry {
  let found: THREE.BufferGeometry | null = null
  engine.layer('stellar').scene.traverse((object) => {
    if (object.name === name) found = (object as THREE.Points).geometry
  })
  if (!found) throw new Error(`no object called ${name}`)
  return found
}

describe('the shell, which is invented', () => {
  it('says so, in the chip and in words', async () => {
    const { engine, module } = await boot()
    const node = engine.node('oort:cloud') as { provenance?: string; caveat?: string } | null
    expect(node?.provenance).toBe('illustration')
    // The one sentence that matters about this object.
    expect(node?.caveat).toMatch(/No object has ever been observed in the Oort cloud/i)
    module.dispose?.()
  })

  it('reports no radius for a thing whose radius is a round number off a guess', async () => {
    const { engine, module } = await boot()
    const node = engine.node('oort:cloud')
    expect(node?.radiusMetres).toBe(0)
    expect(node?.framingRadiusMetres).toBeGreaterThan(1000 * AU_M)
    module.dispose?.()
  })

  it('is a shell, not a ball, and is hollow to its stated inner radius', async () => {
    const { engine, module } = await boot()
    const position = mesh(engine, 'oort:shell').getAttribute('position').array as Float32Array
    const pcPerAu = AU_M / PC_M
    let nearest = Infinity
    let farthest = 0
    for (let i = 0; i < position.length; i += 3) {
      const r = Math.hypot(position[i], position[i + 1], position[i + 2]) / pcPerAu
      nearest = Math.min(nearest, r)
      farthest = Math.max(farthest, r)
    }
    // Inside a few percent of the declared bounds; the sampling is by inversion, so
    // the extremes are approached but not exceeded.
    expect(nearest).toBeGreaterThan(OORT_SHELL_BOUNDS.innerAu * 0.98)
    expect(farthest).toBeLessThan(OORT_SHELL_BOUNDS.outerAu * 1.02)
    expect(farthest).toBeGreaterThan(OORT_SHELL_BOUNDS.outerAu * 0.5)
    module.dispose?.()
  })

  it('spreads the points over the whole sphere rather than piling them at the poles', async () => {
    const { engine, module } = await boot()
    const position = mesh(engine, 'oort:shell').getAttribute('position').array as Float32Array
    // Sampling theta uniformly instead of cos(theta) gives a cloud with two lumps in
    // it. Check the z/r distribution is flat: each third of [-1,1] gets about a third.
    const thirds = [0, 0, 0]
    let total = 0
    for (let i = 0; i < position.length; i += 3) {
      const r = Math.hypot(position[i], position[i + 1], position[i + 2])
      if (r === 0) continue
      const cos = position[i + 2] / r
      thirds[Math.min(2, Math.floor((cos + 1) * 1.5))]++
      total++
    }
    for (const count of thirds) expect(count / total).toBeGreaterThan(0.28)
    module.dispose?.()
  })

  it('is deterministic, so a shared link shows the same cloud', async () => {
    const first = await boot()
    const a = (mesh(first.engine, 'oort:shell').getAttribute('position').array as Float32Array).slice(0, 60)
    first.module.dispose?.()
    const second = await boot()
    const b = (mesh(second.engine, 'oort:shell').getAttribute('position').array as Float32Array).slice(0, 60)
    second.module.dispose?.()
    expect([...a]).toEqual([...b])
  })
})

describe('the orbits, which are measurements', () => {
  it('draws every catalogued orbit that reaches the Oort region', async () => {
    const { module, inner } = await boot()
    // 26 bodies in the catalogue reach past 500 AU. On notability alone smallbodies
    // would keep five — right for the inner system, and it would leave the twenty-one
    // most distant orbits in the atlas with nothing behind them.
    expect(inner.manifest.orbitsDrawn).toBeGreaterThan(20)
    module.dispose?.()
  })

  it('reaches the distances that make the case for a reservoir', async () => {
    const { module, inner } = await boot()
    // The farthest aphelion in the atlas is C/1991 R1 at about 94,000 AU — most of the
    // way to the outer edge of the shell drawn around it, which is the point.
    expect(inner.manifest.farthestAphelionAu).toBeGreaterThan(50_000)
    module.dispose?.()
  })

  it('keeps the inclination spread that makes the cloud a sphere', async () => {
    const { module, inner } = await boot()
    const [low, high] = inner.manifest.inclinationRange
    // Everything that formed in the disc orbits within a few degrees of it. These do
    // not: the set runs from near-prograde to retrograde, which is the observation
    // that rules out a belt. If this range ever collapses, the evidence has gone.
    expect(low).toBeLessThan(20)
    expect(high).toBeGreaterThan(140)
    module.dispose?.()
  })

  it('leaves no orbit drawn with nothing behind it', async () => {
    // Drawn implies clickable, one rung out — and the two modules that must agree about
    // it initialise CONCURRENTLY, which is what makes this the test that matters.
    // `smallbodies` owns every body node; `oort` draws the paths and counts any whose
    // body it cannot find.
    const engine = new Engine({ renderer: {} as never })
    const oort = new OortModule()
    const small = new SmallBodiesModule()
    await Promise.all([oort.init(engine), small.init(engine)])
    const inner = oort as unknown as Internals

    inner.update()
    expect(inner.manifest.orbitsDrawn).toBeGreaterThan(20)
    expect(inner.manifest.orbitsWithoutNode).toBe(0)

    // And Sedna specifically, which the racing version of this filed as a comet with
    // no radius whenever it happened to win.
    const sedna = engine.node('sb-20090377')
    expect(sedna?.name).toMatch(/Sedna/)
    expect(sedna?.radiusMetres).toBeGreaterThan(0)

    oort.dispose?.()
    small.dispose?.()
  })

  it('gives everything back on dispose', async () => {
    const { engine, module } = await boot()
    module.dispose?.()
    expect(engine.registry.has('oort:cloud')).toBe(false)
    let remaining = 0
    engine.layer('stellar').scene.traverse((object) => {
      if (object.name.startsWith('oort:')) remaining++
    })
    expect(remaining).toBe(0)
  })
})
