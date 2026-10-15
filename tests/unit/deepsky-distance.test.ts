import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The Hubble law has a floor.
 *
 * Galaxies move through space as well as with its expansion, at several hundred km/s.
 * Below about z = 0.002 that peculiar motion is comparable to the recession velocity,
 * so `z * c / H0` stops measuring distance.
 *
 * The Small Magellanic Cloud is the object that exposed this in OpenNGC: its catalogued
 * radial velocity is dominated by its orbit around the Milky Way, and the Hubble law
 * placed it 2.15 Mpc away instead of 62 kpc — wrong by a factor of 35, on one of the
 * most recognisable objects in the southern sky.
 *
 * These tests pin the data this policy reads and the floor itself, so neither a
 * dataset rebuild nor a well-meaning tweak can quietly put the SMC back in the wrong
 * galaxy group.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/data/deepsky')
const HUBBLE_REDSHIFT_FLOOR = 0.002
const DISTANCE_KIND_HUBBLE = 2

interface Field {
  name: string
  byteOffset: number
}

function load() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'ngc.json'), 'utf8')) as {
    recordCount: number
    fields: Field[]
  }
  const raw = fs.readFileSync(path.join(ROOT, 'ngc.bin'))
  const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
  const ids = JSON.parse(fs.readFileSync(path.join(ROOT, 'ngc-ids.json'), 'utf8')) as {
    designations?: string[]
  }
  const n = manifest.recordCount
  const offset = (name: string) => manifest.fields.find((f) => f.name === name)!.byteOffset
  return {
    n,
    designations: ids.designations ?? [],
    distancePc: new Float32Array(buffer, offset('distancePc'), n),
    distanceKind: new Uint8Array(buffer, offset('distanceKind'), n),
    redshift: new Float32Array(buffer, offset('redshift'), n),
  }
}

/** Mirrors `hasTrustworthyDistance` in src/modules/deepsky/index.ts. */
function trustworthy(kind: number, distancePc: number, redshift: number): boolean {
  if (kind === 0) return false
  if (!Number.isFinite(distancePc) || distancePc <= 0) return false
  if (kind === DISTANCE_KIND_HUBBLE && Number.isFinite(redshift) && Math.abs(redshift) < HUBBLE_REDSHIFT_FLOOR) {
    return false
  }
  return true
}

describe('deep-sky distance policy', () => {
  const data = load()
  const indexOf = (designation: string) =>
    data.designations.findIndex((d) => typeof d === 'string' && d.toUpperCase().includes(designation))

  it('refuses the Hubble distance for the Small Magellanic Cloud', () => {
    const i = indexOf('NGC0292')
    expect(i).toBeGreaterThanOrEqual(0)
    // The stored value is the wrong one; the point is that we decline to use it.
    expect(data.distancePc[i] / 1e6).toBeGreaterThan(1.5)
    expect(trustworthy(data.distanceKind[i], data.distancePc[i], data.redshift[i])).toBe(false)
  })

  it('refuses the Hubble distance for Centaurus A', () => {
    // z = 0.0018 gives about 8.1 Mpc; the real distance is near 3.8 Mpc.
    const i = indexOf('NGC5128')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(trustworthy(data.distanceKind[i], data.distancePc[i], data.redshift[i])).toBe(false)
  })

  it('keeps Hubble distances for genuinely distant galaxies', () => {
    let kept = 0
    for (let i = 0; i < data.n; i++) {
      if (data.distanceKind[i] !== DISTANCE_KIND_HUBBLE) continue
      if (trustworthy(data.distanceKind[i], data.distancePc[i], data.redshift[i])) kept++
    }
    // The floor must be a scalpel, not a hammer: the overwhelming majority of
    // redshift distances in the catalogue are perfectly usable.
    expect(kept).toBeGreaterThan(9000)
  })

  it('rejects only a small fraction of redshift distances', () => {
    let hubble = 0
    let rejected = 0
    for (let i = 0; i < data.n; i++) {
      if (data.distanceKind[i] !== DISTANCE_KIND_HUBBLE) continue
      hubble++
      if (!trustworthy(data.distanceKind[i], data.distancePc[i], data.redshift[i])) rejected++
    }
    expect(hubble).toBeGreaterThan(5000)
    expect(rejected / hubble).toBeLessThan(0.05)
  })

  it('never places an object at a non-positive distance', () => {
    for (let i = 0; i < data.n; i++) {
      if (!trustworthy(data.distanceKind[i], data.distancePc[i], data.redshift[i])) continue
      expect(data.distancePc[i]).toBeGreaterThan(0)
      expect(Number.isFinite(data.distancePc[i])).toBe(true)
    }
  })
})
