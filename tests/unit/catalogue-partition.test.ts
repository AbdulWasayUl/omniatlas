import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Who owns which rows, when two catalogues overlap.
 *
 * `localgroup.json` and `ungc.json` are built from the same UNGC table. The first is the
 * subset inside `cutoffMpc`, and its own `sourceRowsNote` says the remainder "belongs to
 * the cosmic layer, not the galactic layer". The cosmos module ignored that for a long
 * time and drew all 869 rows, so 74 dwarf galaxies were drawn TWICE — once by the galaxy
 * module in the galactic layer from full-precision cartesian coordinates, once by cosmos
 * in the cosmic layer from an RA/Dec/distance whose distance is rounded to two decimals.
 *
 * The two copies share a direction and differ only in range, by up to 4.9 kpc. A radial
 * offset from the Sun is invisible from the Sun and opens up with camera parallax, so the
 * pair separated as the camera moved and slid back together as the galactic layer faded:
 * the "stray artifact that merges into another object while zooming" this was reported
 * as. And since `oneLabelPerObject` gives one marker per object and `AtlasViewer.pick`
 * tests nothing else, the losing copy had no hit target at all.
 *
 * These tests are about the DATA contract, not the module, because that is what makes
 * them cheap and total: if the two files ever stop agreeing about the boundary, the
 * runtime gate cannot be right no matter how it is written.
 */

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public')
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(PUBLIC, p), 'utf8'))

interface Row {
  name: string
  distMpc?: number
}

const localGroup = read('data/galaxy/localgroup.json') as { cutoffMpc?: number; galaxies?: Row[] }
const ungc = read('data/universe/ungc.json') as { galaxies?: Row[] }

const lgRows = localGroup.galaxies ?? []
const ungcRows = ungc.galaxies ?? []

describe('the Local Group / Local Volume boundary', () => {
  it('is declared in the data rather than hard-coded in a module', () => {
    // The cosmos module reads this value at runtime instead of carrying its own copy.
    // If it disappears the gate falls back to drawing everything, which is the old
    // double-draw — so its presence is part of the contract, not an implementation note.
    expect(typeof localGroup.cutoffMpc).toBe('number')
    expect(localGroup.cutoffMpc!).toBeGreaterThan(0)
  })

  it('partitions the UNGC table exactly, with nothing on either side of the match', () => {
    const cutoff = localGroup.cutoffMpc!
    const inside = ungcRows.filter((r) => typeof r.distMpc === 'number' && r.distMpc > 0 && r.distMpc <= cutoff)

    const lgNames = new Set(lgRows.map((r) => r.name.trim()))
    const insideNames = new Set(inside.map((r) => r.name.trim()))

    // Same count AND same membership. Count alone would pass on two disjoint sets.
    expect(inside.length).toBe(lgRows.length)
    expect([...insideNames].filter((n) => !lgNames.has(n))).toEqual([])
    expect([...lgNames].filter((n) => !insideNames.has(n))).toEqual([])
  })

  it('leaves the cosmic layer a non-empty catalogue after the cut', () => {
    const cutoff = localGroup.cutoffMpc!
    const outside = ungcRows.filter((r) => typeof r.distMpc === 'number' && r.distMpc > cutoff)
    // The whole point of UNGC is the Local Volume beyond the Local Group. A gate that
    // swallowed most of it would be a worse bug than the one it fixes.
    expect(outside.length).toBeGreaterThan(700)
  })

  it('keeps the rounding that made the duplicates visible, so the reason is still legible', () => {
    // Not a requirement, an explanation: this is WHY the two copies were offset rather
    // than coincident. If a rebuild ever ships full-precision distances here, the
    // duplicates would have become invisible instead of fixed, and this assertion
    // failing is the signal to re-read the comment in `loadUngc` rather than relax it.
    const over2dp = ungcRows.filter(
      (r) => typeof r.distMpc === 'number' && Math.round(r.distMpc * 100) / 100 !== r.distMpc,
    )
    expect(over2dp).toEqual([])
  })
})
