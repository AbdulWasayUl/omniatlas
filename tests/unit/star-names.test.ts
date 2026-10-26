import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { borrowedProperNames } from '../../src/modules/stars/index'

/**
 * One proper name, one star.
 *
 * `oneLabelPerObject` gives one marker to a name in a direction, and markers are the
 * only pick targets the atlas has — so when two different stars carry one name, one of
 * them silently becomes unreachable and the tie is broken on catalogued radius, which
 * knows nothing about which star the name belongs to.
 */

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public')
const names = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data/stars/names.json'), 'utf8')) as {
  stars: { i: number; proper?: string; gl?: string }[]
}

describe('borrowedProperNames', () => {
  it('leaves a name alone when only one star carries it', () => {
    expect(borrowedProperNames([{ i: 1, m: 0, proper: 'Sirius', gl: '244A' }])).toEqual(new Set())
  })

  it('gives a component name to the star whose Gliese number carries that letter', () => {
    const real = { i: 7, m: 6.3, proper: 'Gamma B', gl: '106.1B' }
    const borrowed = { i: 8, m: 6.18, proper: 'Gamma B' }
    expect(borrowedProperNames([real, borrowed])).toEqual(new Set([8]))
    // Order must not decide it: the same pair the other way round gives the same answer.
    expect(borrowedProperNames([borrowed, real])).toEqual(new Set([8]))
  })

  it('leaves every one of them named when nothing settles the claim', () => {
    // Two Gliese letters that both match, no component letter in the name at all, or
    // neither star carrying a Gliese number: picking a winner here would be a guess,
    // and a guess is the failure this exists to undo.
    expect(borrowedProperNames([
      { i: 1, m: 1, proper: 'Twin B', gl: '10B' },
      { i: 2, m: 2, proper: 'Twin B', gl: '11B' },
    ])).toEqual(new Set())
    expect(borrowedProperNames([
      { i: 3, m: 1, proper: 'Plain' },
      { i: 4, m: 2, proper: 'Plain', gl: '12B' },
    ])).toEqual(new Set())
    expect(borrowedProperNames([{ i: 5, m: 1, proper: 'Lone B' }, { i: 6, m: 2, proper: 'Lone B' }])).toEqual(
      new Set(),
    )
  })

  it('resolves every collision in the shipped catalogue', () => {
    // Not a fixed list of names: the assertion is that NOTHING survives unresolved, so a
    // rebuild that introduces a new collision the Gliese letter cannot settle fails here
    // rather than quietly costing a star its marker.
    const borrowed = borrowedProperNames(names.stars)
    const claims = new Map<string, number>()
    for (const star of names.stars) {
      if (!star.proper || borrowed.has(star.i)) continue
      claims.set(star.proper, (claims.get(star.proper) ?? 0) + 1)
    }
    expect([...claims].filter(([, n]) => n > 1)).toEqual([])
  })

  it('drops the star with no identifier at all, not the catalogued component', () => {
    // The two real collisions. Kaffaljidhma is the one that was going wrong: the dedupe
    // kept the star with no Gliese, HIP, HD, HR or spectral type and dropped Gl 106.1B,
    // so searching the name flew the camera to the wrong star of the pair.
    const borrowed = borrowedProperNames(names.stars)
    const named = (n: string) => names.stars.filter((s) => s.proper === n)
    for (const name of ['Sabik B', 'Kaffaljidhma B']) {
      const members = named(name)
      expect(members).toHaveLength(2)
      const kept = members.filter((s) => !borrowed.has(s.i))
      expect(kept).toHaveLength(1)
      expect(kept[0].gl?.toUpperCase().endsWith('B')).toBe(true)
    }
  })
})
