import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A quad with a visible edge is not a star.
 *
 * Both the field stars and the landmark glows draw a point source as a textureless quad
 * and shape it in the fragment shader. The shape has to reach exactly zero at the rim,
 * because anything else leaves a faint disc where the quad ends — and a sky full of
 * faint identical discs is what makes a star field read as dots of paint.
 *
 * Reaching zero means subtracting the curve's value at the rim and renormalising, which
 * means a hand-computed constant in the shader that has to agree with the exponents
 * beside it. That constant was wrong the first time it was written here, by a factor of
 * three, and nothing could have caught it except arithmetic: a shader does not fail to
 * compile over it, it just draws a ring. So do the arithmetic.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src')

describe('the star sprite falloff', () => {
  const shader = fs.readFileSync(path.join(SRC, 'modules/stars/index.ts'), 'utf8')

  const num = (re: RegExp): number => {
    const m = re.exec(shader)
    if (!m) throw new Error(`shader no longer matches ${re}`)
    return Number(m[1])
  }

  it('declares an edge constant that matches its own exponents', () => {
    const core = num(/float core = exp\(-([\d.]+) \* r2\)/)
    const halo = num(/float halo = exp\(-([\d.]+) \* r2\)/)
    const weight = num(/float falloff = max\(\(core \+ ([\d.]+) \* halo/)
    const declared = num(/const float EDGE = ([\d.]+);/)
    expect(declared).toBeCloseTo(Math.exp(-core) + weight * Math.exp(-halo), 4)
  })

  it('reaches exactly zero at the rim and exactly one at the centre', () => {
    const core = num(/float core = exp\(-([\d.]+) \* r2\)/)
    const halo = num(/float halo = exp\(-([\d.]+) \* r2\)/)
    const weight = num(/float falloff = max\(\(core \+ ([\d.]+) \* halo/)
    const edge = num(/const float EDGE = ([\d.]+);/)
    const falloff = (r2: number) =>
      (Math.exp(-core * r2) + weight * Math.exp(-halo * r2) - edge) / (1 + weight - edge)
    expect(falloff(1)).toBeCloseTo(0, 4)
    expect(falloff(0)).toBeCloseTo(1, 4)
  })

  it('is a point source rather than a ball', () => {
    // Half the light inside a small fraction of the radius is the difference between a
    // star and a sphere. The curve it replaced was at 0.37 of peak half way out.
    const core = num(/float core = exp\(-([\d.]+) \* r2\)/)
    const halo = num(/float halo = exp\(-([\d.]+) \* r2\)/)
    const weight = num(/float falloff = max\(\(core \+ ([\d.]+) \* halo/)
    const edge = num(/const float EDGE = ([\d.]+);/)
    const falloff = (r2: number) =>
      (Math.exp(-core * r2) + weight * Math.exp(-halo * r2) - edge) / (1 + weight - edge)
    expect(falloff(0.25)).toBeLessThan(0.25)
    // ...but not so tight that nothing is left around it: the halo is what still says
    // "light source" instead of "dot".
    expect(falloff(0.25)).toBeGreaterThan(0.05)
  })
})
