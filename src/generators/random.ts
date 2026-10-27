/**
 * The deterministic random source the generators share.
 *
 * Split out because more than one generator needs it and they must agree: the atlas puts
 * its camera state in the URL, so a permalink to an invented moon has to show the next
 * person that same moon, with the same description, forever and on any machine. Every
 * number here comes from a seed and nothing consults the clock, the device, or the order
 * in which things happened to load.
 *
 * `mulberry32` is the generator `scripts/build-galaxy.mjs` already seeds the Milky Way's
 * disc field with, so the atlas has one answer to "how do we invent something twice".
 */

/** 32-bit string hash (xmur3), for turning a stable id into a stable seed. */
export function hashSeed(text: string): number {
  let h = 1779033703 ^ text.length
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^= h >>> 16) >>> 0
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A small deterministic random source with the shapes the generators actually need. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number
  /** Log-uniform in [lo, hi): the right default for a quantity spanning decades. */
  logRange(lo: number, hi: number): number
  /** True with probability p. */
  chance(p: number): boolean
  /** One item, uniformly. */
  pick<T>(items: readonly T[]): T
  /** Roughly normal, via the sum of three uniforms; clamped to +/- 1. */
  signed(): number
}

export function rngFrom(seed: number): Rng {
  const r = mulberry32(seed)
  return {
    next: r,
    range: (lo, hi) => lo + (hi - lo) * r(),
    logRange: (lo, hi) => Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * r()),
    chance: (p) => r() < p,
    pick: (items) => items[Math.min(items.length - 1, Math.floor(r() * items.length))],
    signed: () => Math.min(1, Math.max(-1, ((r() + r() + r()) / 3 - 0.5) * 3.4)),
  }
}
