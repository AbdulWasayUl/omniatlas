import { describe, expect, it } from 'vitest'
import { planZoomPath } from '../../src/core/camera/AtlasControls'

/**
 * van Wijk and Nuij's zoom path, which every flight in the atlas is parameterised by.
 *
 * It shipped with no test, and with r(i) written as ln(-b + sqrt(b^2 + 1)). That form
 * cancels: once |b| >= 2^26.5 the sqrt returns |b| exactly, the subtraction returns 0,
 * and S becomes Infinity, so `at()` fed NaN into distanceMetres for the whole flight.
 * The distance RATIO between the two viewpoints is what drives |b|, so these cases walk
 * it from a hop across the solar system (1e2) out past the observable universe (1e23).
 */
const RATIOS = [1e2, 1e6, 1e9, 1e15, 1e23]

/** A typical departure: holding station 1e7 m off something, then leaving. */
const W0 = 1e7

describe('planZoomPath', () => {
  for (const ratio of RATIOS) {
    describe(`distance ratio 1e${Math.round(Math.log10(ratio))}`, () => {
      const travel = W0 * ratio
      const path = planZoomPath(0, W0, travel, W0)

      it('has a finite path length', () => {
        expect(Number.isFinite(path.S)).toBe(true)
        expect(path.S).toBeGreaterThan(0)
      })

      it('arrives exactly at the destination', () => {
        const end = path.at(path.S)
        expect(Number.isFinite(end.u)).toBe(true)
        expect(Math.abs(end.u - travel) / travel).toBeLessThan(1e-12)
      })

      it('starts at the departure point and stays finite throughout', () => {
        const start = path.at(0)
        // Measured against W0, not against `travel`. A departure error only shows on
        // screen in units of how far the camera is from what it is leaving, so dividing
        // by `travel` let the 1e23 case tolerate a 1e21 m jump at t = 0. Worst residual
        // over these ratios is 5.8e-4 m against a 1e7 m view, i.e. 5.8e-11. It is a
        // residual, not zero: cosh(r0)*tanh(r0) only equals sinh(r0) in exact arithmetic,
        // and the two disagree by an ulp or two for |b| small enough to still carry
        // digits, so u(0) is exactly 0 at the 1e9, 1e15 and 1e23 ratios but not at 1e2
        // or 1e6. The departure WIDTH does come out exact at every ratio.
        expect(Math.abs(start.u) / W0).toBeLessThan(1e-9)
        expect(start.w).toBe(W0)

        let previous = Number.NEGATIVE_INFINITY
        for (let i = 0; i <= 64; i++) {
          const { u, w } = path.at((i / 64) * path.S)
          expect(Number.isFinite(u)).toBe(true)
          expect(Number.isFinite(w)).toBe(true)
          expect(w).toBeGreaterThan(0)
          // Monotonic: the camera never backs up mid-flight. Equality is allowed
          // because at a 1e23 ratio the first samples are below the float64 resolution
          // of the arrival distance, so they all round to u = 0.
          expect(u).toBeGreaterThanOrEqual(previous)
          previous = u
        }
      })
    })
  }

  it('matches the naive log-and-sqrt form wherever that form is still accurate', () => {
    // Below |b| ~ 1e6 the original expansion has not lost its leading digits yet, so it
    // is a valid reference for the asinh form that replaced it.
    for (const ratio of [1, 10, 1e2, 1e3, 1e4]) {
      const travel = W0 * ratio
      const w1 = W0 * 3
      const rho2 = 2
      const du = travel
      const b = (i: number) => {
        const w = i === 0 ? W0 : w1
        const sign = i === 0 ? 1 : -1
        return (w1 * w1 - W0 * W0 + sign * rho2 * rho2 * du * du) / (2 * w * rho2 * du)
      }
      const naive = (Math.log(-b(1) + Math.sqrt(b(1) * b(1) + 1)) - Math.log(-b(0) + Math.sqrt(b(0) * b(0) + 1))) / Math.SQRT2
      // The asinh form is the more accurate of the two, so the tolerance is the naive
      // form's own residual cancellation error, not a defect in the replacement.
      expect(Math.abs(planZoomPath(0, W0, travel, w1).S - naive) / naive).toBeLessThan(1e-9)
    }
  })

  it('handles a pure zoom with no lateral travel', () => {
    const path = planZoomPath(0, 1e7, 0, 1e21)
    expect(Number.isFinite(path.S)).toBe(true)
    expect(path.at(path.S).w / 1e21).toBeCloseTo(1, 9)
    // The branch exists to hold u still: a pure zoom that drifts laterally would slide
    // the anchor off the optical axis over fourteen decades of scale.
    expect(path.at(path.S).u).toBe(0)
    expect(path.at(path.S / 2).u).toBe(0)
    // And its length is the plain log ratio over rho, not van Wijk's hyperbolic one.
    expect(path.S).toBeCloseTo(Math.log(1e21 / 1e7) / Math.SQRT2, 9)
  })
})
