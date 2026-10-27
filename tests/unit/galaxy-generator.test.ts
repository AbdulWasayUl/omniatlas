import { describe, expect, it } from 'vitest'
import {
  type GeneratedGalaxy,
  galaxyStarField,
  generateInterior,
  publishedMorphology,
  shapeFromMorphology,
} from '../../src/generators/galaxy'

/**
 * The inside of a place nobody has been inside.
 *
 * Invention is the point here, so these tests are not about accuracy. They are about the
 * two things invention still owes: that it is the SAME invention every time, because the
 * atlas puts its camera in the URL and a link to a named place has to lead there; and
 * that it is the RIGHT KIND of invention, because generating one shape for everything
 * gave the Crab Nebula spiral arms and sixteen globular clusters.
 */

const galaxy = (id: string, r = 1.2e20) => generateInterior(id, r, 'galaxy')
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

describe('generateInterior', () => {
  it('builds the same interior for the same host, every time', () => {
    expect(JSON.stringify(galaxy('ngc:NGC5194'))).toBe(JSON.stringify(galaxy('ngc:NGC5194')))
  })

  it('builds different interiors for different hosts', () => {
    expect(JSON.stringify(galaxy('ngc:NGC5194'))).not.toBe(JSON.stringify(galaxy('ngc:NGC5055')))
  })

  it('gives a nebula a nebula and not a galaxy', () => {
    // The failure this pins shipped: everything explorable got spiral arms, so the Crab
    // Nebula came out as a barred spiral with sixteen globular clusters in it.
    const neb = generateInterior('ngc:NGC1952', 1.6e17, 'nebula')
    const kinds = new Set(neb.landmarks.map((l) => l.kind))
    expect(neb.armCount).toBe(0)
    expect(kinds.has('cluster')).toBe(false)
    expect(kinds.has('core')).toBe(false)
    expect(neb.radiusKpc).toBeLessThan(0.3)
  })

  it('knows the Crab is a remnant rather than a nursery', () => {
    const crab = generateInterior('ngc:NGC1952', 1.6e17, 'nebula')
    expect(crab.description).toMatch(/remnant/i)
    expect(crab.landmarks.some((l) => l.kind === 'pulsar')).toBe(true)
  })

  it('gives a cluster stars and nothing else', () => {
    const cluster = generateInterior('gc:ngc5139', 5e17, 'cluster')
    expect(cluster.armCount).toBe(0)
    expect(cluster.landmarks.every((l) => l.kind === 'member')).toBe(true)
    // `gc:` is the Harris catalogue, which is globulars only.
    expect(cluster.description).toMatch(/globular/i)
  })

  it('uses the published morphology for the galaxies people visit', () => {
    // M87 is the elliptical every textbook uses to show what an elliptical is, and it
    // came out a barred spiral until this table existed.
    expect(shapeFromMorphology(publishedMorphology('ngc:NGC4486'))).toBe('elliptical')
    expect(shapeFromMorphology(publishedMorphology('ngc:NGC5194'))).toBe('spiral')
    expect(shapeFromMorphology(publishedMorphology('ngc:NGC3034'))).toBe('irregular')
    expect(publishedMorphology('ngc:NGC9999')).toBeUndefined()
  })

  it('turns a measured spiral into a spiral, barred or not', () => {
    for (const id of ['ngc:NGC5194', 'ngc:NGC0224', 'ngc:NGC5457']) {
      const shape = generateInterior(id, 1.2e20, 'galaxy', shapeFromMorphology(publishedMorphology(id))).shape
      expect(['spiral', 'barred'], id).toContain(shape)
    }
    expect(generateInterior('ngc:NGC4486', 1.2e20, 'galaxy', shapeFromMorphology(publishedMorphology('ngc:NGC4486'))).shape)
      .toBe('elliptical')
  })

  it('names every place in an interior differently', () => {
    for (let i = 0; i < 120; i++) {
      const g = galaxy(`probe:${i}`)
      const names = g.landmarks.map((l) => l.name)
      expect(new Set(names).size, `interior ${i} repeats a name`).toBe(names.length)
      for (const l of g.landmarks) expect(l.description.length).toBeGreaterThan(30)
    }
  })

  it('keeps its landmarks inside the thing they belong to', () => {
    for (let i = 0; i < 120; i++) {
      const g = galaxy(`probe:${i}`)
      for (const l of g.landmarks) {
        const r = Math.hypot(l.x, l.y, l.z)
        // Globulars live in the halo, so the bound is generous; nothing should be out
        // at ten times the galaxy's own radius.
        expect(r, `${l.name} is ${r.toFixed(1)} kpc out of ${g.radiusKpc.toFixed(1)}`).toBeLessThan(g.radiusKpc * 4)
        expect(Number.isFinite(l.radiusKpc) && l.radiusKpc > 0).toBe(true)
        expect(l.color).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })

  it('gives each interior its own orientation', () => {
    // Without this every disc lay in the same plane and the whole atlas tilted one way.
    const normals: GeneratedGalaxy['basis']['e3'][] = []
    for (let i = 0; i < 40; i++) normals.push(galaxy(`probe:${i}`).basis.e3)
    // No two normals within a degree of each other.
    let close = 0
    for (let i = 0; i < normals.length; i++) {
      for (let j = i + 1; j < normals.length; j++) {
        if (Math.abs(dot(normals[i], normals[j])) > 0.9998) close++
      }
    }
    expect(close).toBe(0)
  })

  it('uses an orthonormal basis, so nothing is stretched by it', () => {
    for (let i = 0; i < 60; i++) {
      const { e1, e2, e3 } = galaxy(`probe:${i}`).basis
      for (const v of [e1, e2, e3]) expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 10)
      expect(dot(e1, e2)).toBeCloseTo(0, 10)
      expect(dot(e1, e3)).toBeCloseTo(0, 10)
      expect(dot(e2, e3)).toBeCloseTo(0, 10)
    }
  })

  it('draws a star cloud that is finite, sized, and shaped like its galaxy', () => {
    const g = galaxy('ngc:NGC5194')
    const field = galaxyStarField(g)
    expect(field.length).toBe(g.starCount * 3)
    let outside = 0
    for (let i = 0; i < g.starCount; i++) {
      const r = Math.hypot(field[i * 3], field[i * 3 + 1], field[i * 3 + 2])
      expect(Number.isFinite(r)).toBe(true)
      if (r > g.radiusKpc * 3) outside++
    }
    // An exponential disc has a tail, but it should be a tail.
    expect(outside / g.starCount).toBeLessThan(0.02)
  })

  it('puts the arms somewhere, rather than smearing them round the disc', () => {
    // The arms were present and unreadable until the scatter came down. Measured as the
    // spread of star count across azimuth bins: a disc with arms is lumpy in azimuth.
    const spiral = generateInterior('probe:arms', 1.2e20, 'galaxy', 'spiral')
    const field = galaxyStarField(spiral)
    const bins = new Array(36).fill(0)
    // Measure in the disc's own plane, which the basis has rotated away from z.
    const { e1, e2 } = spiral.basis
    for (let i = 0; i < spiral.starCount; i++) {
      const p = [field[i * 3], field[i * 3 + 1], field[i * 3 + 2]]
      const a = Math.atan2(dot(p, e2), dot(p, e1))
      bins[Math.min(35, Math.floor(((a + Math.PI) / (2 * Math.PI)) * 36))]++
    }
    const mean = spiral.starCount / 36
    const spread = Math.sqrt(bins.reduce((s, n) => s + (n - mean) ** 2, 0) / 36) / mean
    expect(spread, 'azimuthal structure too smooth to read as arms').toBeGreaterThan(0.1)
  })
})
