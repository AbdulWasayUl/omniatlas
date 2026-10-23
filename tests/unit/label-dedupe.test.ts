import { describe, expect, it } from 'vitest'
import { oneLabelPerObject } from '../../src/core/AtlasViewer'
import type { SceneNodeHandle } from '../../src/core/Engine'
import { vec3d } from '../../src/core/world'

/**
 * One marker per object, across catalogues that agree about neither names nor distances.
 *
 * Markers are the only pick targets the atlas has, so a node that loses its label is a
 * node that cannot be clicked. That makes this function's two failure modes opposite and
 * equally visible: merge too little and one galaxy wears two names a few pixels apart,
 * drifting against each other under parallax; merge too much and a real object silently
 * becomes unreachable.
 */

const PC = 3.0857e16

function node(id: string, name: string, distPc: number, raDeg: number, radius = 0): SceneNodeHandle {
  const ra = (raDeg * Math.PI) / 180
  return {
    id,
    name,
    // Dec 0, so the direction is a pure rotation in x/y and the test can reason about it.
    worldPosition: vec3d(Math.cos(ra) * distPc * PC, Math.sin(ra) * distPc * PC, 0),
    frame: 'icrf',
    radiusMetres: radius,
    layer: 'galactic',
    objectClass: 'galaxy',
    parentId: null,
  }
}

const ids = (nodes: SceneNodeHandle[]) => nodes.map((n) => n.id).sort()

describe('oneLabelPerObject', () => {
  it('merges one designation listed by two catalogues under two names', () => {
    // The real pair: the Local Volume table calls it NGC 5128, OpenNGC calls it
    // Centaurus A, and they place it 12.23 and 12.90 million light years out. Neither
    // the name nor the distance matches; the designation does.
    const kept = oneLabelPerObject([
      node('ungc:ngc5128', 'NGC 5128', 3.75e6, 201.4),
      node('ngc:NGC5128', 'Centaurus A', 3.95e6, 201.4, 1e20),
    ])
    expect(ids(kept)).toEqual(['ngc:NGC5128'])
  })

  it('normalises leading zeros, case and separators in a designation', () => {
    expect(ids(oneLabelPerObject([node('lg:ngc0205', 'NGC 205', 8.2e5, 10.7), node('ngc:NGC0205', 'Messier 110', 8.25e5, 10.7)]))).toHaveLength(1)
    expect(ids(oneLabelPerObject([node('ungc:eso270-017', 'ESO 270-017', 3.6e6, 203.5), node('ngc:ESO270-017', 'Fourcade-Figueroa', 1.2e7, 203.5)]))).toHaveLength(1)
  })

  it('still merges on the name alone, for two designations of one object', () => {
    // The Eagle Nebula is in OpenNGC twice on purpose: IC 4703 is the nebulosity and
    // NGC 6611 the cluster inside it. Two designations, one name, one thing.
    const kept = oneLabelPerObject([
      node('ngc:IC4703', 'Eagle Nebula', 1767, 274.7, 2e15),
      node('ngc:NGC6611', 'Eagle Nebula', 1767, 274.7, 5e16),
    ])
    expect(ids(kept)).toEqual(['ngc:NGC6611'])
  })

  it('keeps two objects that share neither key, however close together', () => {
    // The Antennae: two galaxies ninety arcseconds apart. The deep-sky module hands
    // them distinguishable names precisely so this function will not collapse them,
    // and until it did, NGC 4039 had no marker and so could not be clicked at all.
    const kept = oneLabelPerObject([
      node('ngc:NGC4038', 'Antennae Galaxies (NGC 4038)', 2.48e7, 180.47, 2e21),
      node('ngc:NGC4039', 'Antennae Galaxies (NGC 4039)', 2.43e7, 180.47, 2e21),
    ])
    expect(ids(kept)).toEqual(['ngc:NGC4038', 'ngc:NGC4039'])
  })

  it('never merges across directions, however identical the name', () => {
    // Two rows with one name in different parts of the sky are two objects. Distance
    // is deliberately NOT part of the key — the whole point is that the catalogues
    // disagree about it — so direction is the only thing keeping them apart.
    const kept = oneLabelPerObject([node('a:ngc1', 'Twin', 1e6, 10), node('b:ngc1', 'Twin', 1e6, 110)])
    expect(ids(kept)).toEqual(['a:ngc1', 'b:ngc1'])
  })

  it('chains a group through whichever key each pair shares', () => {
    // A shares a name with B, B shares a designation with C, and A and C share
    // nothing. They are still one object, so one marker comes out.
    const kept = oneLabelPerObject([
      node('lg:andromeda', 'Andromeda Galaxy', 7.8e5, 10.68),
      node('ungc:ngc0224', 'Andromeda Galaxy', 7.9e5, 10.68),
      node('ngc:NGC224', 'M31', 7.85e5, 10.68, 3e20),
    ])
    expect(ids(kept)).toEqual(['ngc:NGC224'])
  })

  it('prefers the row that carries a catalogued size, then the lower id', () => {
    // The survivor is the one that can be DRAWN rather than merely marked, and the
    // tie-break is the id so the answer does not depend on module load order.
    const marked = node('z:ngc9', 'Thing', 1e6, 44)
    const drawn = node('a:ngc9', 'Thing', 1e6, 44, 1e19)
    expect(ids(oneLabelPerObject([marked, drawn]))).toEqual(['a:ngc9'])
    expect(ids(oneLabelPerObject([drawn, marked]))).toEqual(['a:ngc9'])
    const tied = [node('b:ngc8', 'Tie', 1e6, 45, 5e18), node('a:ngc8', 'Tie', 1e6, 45, 5e18)]
    expect(ids(oneLabelPerObject(tied))).toEqual(['a:ngc8'])
  })
})
