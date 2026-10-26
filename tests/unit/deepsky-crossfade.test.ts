import { describe, expect, it } from 'vitest'
import { crossfadeWeights } from '../../src/modules/deepsky/index'

/**
 * The deep-sky catalogue is drawn twice, once per layer, and must never go dark between
 * them.
 *
 * The regression this pins shipped: gating each copy on its own layer's opacity is right,
 * but the handover is keyed on distance from the Sun while the opacities are not, so the
 * two can disagree. A few hundred parsecs out the handover had already given the sky to
 * the galactic copy while the galactic layer was not drawing, and 13,371 objects fell to
 * 2 per cent opacity.
 */

const sum = (h: number, n: number, f: number) => {
  const w = crossfadeWeights(h, n, f)
  return w.near + w.far
}

describe('crossfadeWeights', () => {
  it('splits the catalogue by the handover when both layers draw', () => {
    const w = crossfadeWeights(0.25, 1, 1)
    expect(w.near).toBeCloseTo(0.75, 10)
    expect(w.far).toBeCloseTo(0.25, 10)
  })

  it('never lets the catalogue dim just because the handover favours a layer that is off', () => {
    // The exact case that regressed: handover says "far", far layer is dark.
    const w = crossfadeWeights(0.98, 1, 0)
    expect(w.near).toBeCloseTo(1, 10)
    expect(w.far).toBe(0)
    // ...and the mirror image.
    const m = crossfadeWeights(0.02, 0, 1)
    expect(m.far).toBeCloseTo(1, 10)
    expect(m.near).toBe(0)
  })

  it('keeps the catalogue at full strength across the whole handover while either layer draws', () => {
    for (let h = 0; h <= 1.0001; h += 0.05) {
      expect(sum(h, 1, 1)).toBeCloseTo(1, 10)
      expect(sum(h, 1, 0)).toBeCloseTo(1, 10)
      expect(sum(h, 0, 1)).toBeCloseTo(1, 10)
    }
  })

  it('never exceeds what the better of the two layers allows', () => {
    // A faded layer must not be made to carry the catalogue at full strength: the
    // renormalisation fills a hole, it does not override a layer's own fade.
    for (const [h, n, f] of [
      [0.98, 0.3, 0],
      [0.5, 0.4, 0.2],
      [0.1, 0.0, 0.8],
      [0.75, 0.6, 0.6],
    ]) {
      const w = crossfadeWeights(h, n, f)
      expect(w.near + w.far).toBeLessThanOrEqual(Math.max(n, f) + 1e-9)
      expect(w.near).toBeLessThanOrEqual(n + 1e-9)
      expect(w.far).toBeLessThanOrEqual(f + 1e-9)
    }
  })

  it('keeps the TOTAL continuous as one layer fades away entirely', () => {
    // Which copy carries the catalogue may switch abruptly — both draw the same objects
    // in the same places, so that is invisible. What must not jump is how much light
    // reaches the screen in total.
    for (const h of [0, 0.3, 0.98, 1]) {
      let prev = sum(h, 1, 1)
      for (let f = 1; f >= -1e-9; f -= 0.01) {
        const now = sum(h, 1, Math.max(f, 0))
        expect(Math.abs(now - prev)).toBeLessThan(0.02)
        prev = now
      }
    }
  })

  it('draws nothing when neither layer is drawing', () => {
    expect(crossfadeWeights(0.5, 0, 0)).toEqual({ near: 0, far: 0 })
    expect(crossfadeWeights(0, 0, 0)).toEqual({ near: 0, far: 0 })
  })

  it('moves continuously, so the handover cannot flash', () => {
    let prev = crossfadeWeights(0, 1, 0.4)
    for (let h = 0.002; h <= 1.0001; h += 0.002) {
      const w = crossfadeWeights(h, 1, 0.4)
      expect(Math.abs(w.near - prev.near)).toBeLessThan(0.02)
      expect(Math.abs(w.far - prev.far)).toBeLessThan(0.02)
      prev = w
    }
  })
})
