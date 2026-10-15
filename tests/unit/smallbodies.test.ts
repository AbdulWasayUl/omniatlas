import { describe, expect, it, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as THREE from 'three'
import { Engine } from '../../src/core/Engine'
import { keplerianPosition } from '../../src/astronomy/orbit'
import { AU_M } from '../../src/core/world'

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

function makeEngine() {
  return new Engine({ renderer: {} as any })
}

describe('smallbodies module', () => {
  it('init / decode / register / dispose', async () => {
    const { SmallBodiesModule } = await import('../../src/modules/smallbodies')
    const engine = makeEngine()
    const mod = new SmallBodiesModule()
    await mod.init(engine)
    const scene = engine.layer('helio').scene
    const names = scene.children.map((c) => c.name)
    console.log('CHILDREN', names)
    console.log('STATS', JSON.stringify(mod.stats))
    const belt = scene.children.find((c) => c.name === 'smallbodies:belt') as THREE.Mesh
    expect(belt).toBeTruthy()
    const geo = belt.geometry as THREE.InstancedBufferGeometry
    console.log('instanceCount', geo.instanceCount, 'attrs', Object.keys(geo.attributes))
    const a = geo.getAttribute('sbA') as THREE.BufferAttribute
    const e = geo.getAttribute('sbE') as THREE.BufferAttribute
    const H = geo.getAttribute('sbH') as THREE.BufferAttribute
    const iA = geo.getAttribute('sbI') as THREE.BufferAttribute
    console.log('rec0', a.getX(0), e.getX(0), H.getX(0), (iA.getX(0) * 180) / Math.PI)
    console.log('rec1', a.getX(1), e.getX(1), H.getX(1))
    expect(a.getX(0)).toBeCloseTo(2.361366, 5)
    expect(a.getX(1)).toBeCloseTo(2.765553, 5)
    expect(e.getX(1)).toBeCloseTo(0.079692, 5)

    const regs = [...engine.registry.values()]
    const classes: Record<string, number> = {}
    for (const r of regs) classes[r.objectClass] = (classes[r.objectClass] ?? 0) + 1
    console.log('registered', regs.length, 'classes', JSON.stringify(classes))
    const ceres = engine.registry.get('ceres')
    console.log('ceres node', JSON.stringify(ceres && { name: ceres.name, r: ceres.radiusMetres, p: ceres.parentId, layer: ceres.layer, frame: ceres.frame }))
    expect(ceres).toBeTruthy()
    const d = Math.hypot(ceres!.worldPosition.x, ceres!.worldPosition.y, ceres!.worldPosition.z) / AU_M
    console.log('ceres r AU', d)
    expect(d).toBeGreaterThan(2.5)
    expect(d).toBeLessThan(3.0)
    console.log('zero-radius nodes', regs.filter((r) => r.radiusMetres === 0).length)
    console.log('sample names', regs.slice(0, 8).map((r) => r.id + '=' + r.name).join(' | '))

    const disposed: string[] = []
    const origGeoDispose = geo.dispose.bind(geo)
    geo.dispose = () => {
      disposed.push('beltGeo')
      origGeoDispose()
    }
    const mat = belt.material as THREE.Material
    const origMatDispose = mat.dispose.bind(mat)
    mat.dispose = () => {
      disposed.push('beltMat')
      origMatDispose()
    }
    const lines = scene.children.filter((c) => c.name.startsWith('orbit:')) as THREE.LineSegments[]
    for (const l of lines) {
      const g = l.geometry
      const m = l.material as THREE.Material
      const og = g.dispose.bind(g)
      g.dispose = () => {
        disposed.push('lineGeo')
        og()
      }
      const om = m.dispose.bind(m)
      m.dispose = () => {
        disposed.push('lineMat')
        om()
      }
    }
    mod.dispose()
    console.log('disposed', JSON.stringify(disposed))
    console.log('after dispose children', scene.children.length, 'registry', engine.registry.size)
    expect(scene.children.length).toBe(0)
    expect(engine.registry.size).toBe(0)
    expect(disposed).toContain('beltGeo')
    expect(disposed).toContain('beltMat')
    expect(disposed.filter((x) => x === 'lineGeo').length).toBe(lines.length)
    expect(disposed.filter((x) => x === 'lineMat').length).toBe(lines.length)
  })

  it('aborts cleanly when the engine is disposed during init', async () => {
    const { SmallBodiesModule } = await import('../../src/modules/smallbodies')
    const engine = makeEngine()
    const mod = new SmallBodiesModule()
    const p = mod.init(engine)
    engine.dispose()
    // The assertion is simply that this resolves. A module that touches the scene
    // graph after disposal throws here, which is the StrictMode double-mount bug:
    // React mounts, unmounts and remounts every effect in development, so a boot
    // started by the first mount is still in flight when the second tears it down.
    await expect(p).resolves.toBeUndefined()
    // Nothing may have been registered into an engine that no longer exists.
    expect(engine.registry.size).toBe(0)
  })

  it('shader maths agrees with keplerianPosition', async () => {
    const f = Math.fround
    const K = 0.01720209895
    const prop = (a: number, e: number, inc: number, om: number, w: number, m0: number, days: number) => {
      const n = f(K / f(a * Math.sqrt(a)))
      let M = f(m0 + f(n * days))
      M = f(((((M + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI)
      let E = f(M + e * Math.sin(M) * (1 + e * Math.cos(M)))
      for (let k = 0; k < 5; k++) E = f(E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)))
      const xp = f(a * (Math.cos(E) - e))
      const yp = f(a * Math.sqrt(Math.max(1 - e * e, 0)) * Math.sin(E))
      const cw = Math.cos(w)
      const sw = Math.sin(w)
      const r1x = xp * cw - yp * sw
      const r1y = xp * sw + yp * cw
      const ci = Math.cos(inc)
      const si = Math.sin(inc)
      const r2 = [r1x, r1y * ci, r1y * si]
      const cn = Math.cos(om)
      const sn = Math.sin(om)
      return [r2[0] * cn - r2[1] * sn, r2[0] * sn + r2[1] * cn, r2[2]]
    }
    const named = JSON.parse(fs.readFileSync(ROOT + '/data/smallbodies/named.json', 'utf8'))
    const byName = new Map<string, any>(named.objects.map((o: any) => [o.name, o]))
    const epochMs = (2461200.5 - 2440587.5) * 86400000
    const when = Date.UTC(2026, 9, 14)
    const days = (when - epochMs) / 86400000
    for (const nm of ['Vesta', 'Ceres', 'Pallas', 'Juno', 'Hygiea']) {
      const o = byName.get(nm)!
      const el = o.elements
      const D = Math.PI / 180
      const g = prop(f(el.aAu), f(el.e), f(el.iDeg * D), f(el.omDeg * D), f(el.wDeg * D), f(el.maDeg * D), days)
      const cpu = keplerianPosition(
        {
          semiMajorAxisKm: (el.aAu * AU_M) / 1000,
          eccentricity: el.e,
          inclinationDeg: el.iDeg,
          nodeDeg: el.omDeg,
          periapsisDeg: el.wDeg,
          meanAnomalyDegAtEpoch: el.maDeg,
          epoch: new Date((el.epochJdTdb - 2440587.5) * 86400000),
          periodDays: 360 / el.nDegPerDay,
        } as any,
        new Date(when),
      )
      const cpuAu = [(cpu.x * 1000) / AU_M, (cpu.y * 1000) / AU_M, (cpu.z * 1000) / AU_M]
      const diff = Math.hypot(g[0] - cpuAu[0], g[1] - cpuAu[1], g[2] - cpuAu[2])
      console.log(nm, 'gpu', g.map((v) => v.toFixed(6)).join(','), 'cpu', cpuAu.map((v) => v.toFixed(6)).join(','), 'diff AU', diff.toExponential(2), 'diff km', ((diff * AU_M) / 1000).toFixed(1))
      expect(diff).toBeLessThan(1e-4)
    }
  })

  it('kirkwood: gaps in a, not in instantaneous r', () => {
    const buf = fs.readFileSync(ROOT + '/data/smallbodies/belt.bin')
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const N = 80598
    const B = (k: number) => new Float32Array(ab, k * N * 4, N)
    const a = B(0)
    const e = B(1)
    const ma = B(5)
    const K = 0.01720209895
    const days = (Date.UTC(2026, 9, 14) - (2461200.5 - 2440587.5) * 86400000) / 86400000
    const rs = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      let M = ma[i] + (K / (a[i] * Math.sqrt(a[i]))) * days
      M = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      let E = M
      for (let k = 0; k < 40; k++) E -= (E - e[i] * Math.sin(E) - M) / (1 - e[i] * Math.cos(E))
      rs[i] = a[i] * (1 - e[i] * Math.cos(E))
    }
    const hist = (arr: ArrayLike<number>) => {
      const h = new Float64Array(600)
      for (let i = 0; i < N; i++) {
        const b = Math.floor((arr[i] - 1.8) / 0.005)
        if (b >= 0 && b < 600) h[b]++
      }
      return h
    }
    const ha = hist(a)
    const hr = hist(rs)
    const dep = (h: Float64Array, x: number) => {
      const at = (v: number) => h[Math.floor((v - 1.8) / 0.005)]
      const sh = (at(x - 0.06) + at(x + 0.06)) / 2
      return 1 - at(x) / sh
    }
    for (const [nm, x] of [
      ['4:1', 2.065],
      ['3:1', 2.502],
      ['5:2', 2.825],
      ['2:1', 3.279],
    ] as [string, number][]) {
      console.log('KIRKWOOD', nm, 'depletion in a', dep(ha, x).toFixed(3), ' in r', dep(hr, x).toFixed(3))
    }
  })
})
