import { type Rng, hashSeed, rngFrom } from './random'
import type { WorldKind } from './system'

/**
 * A surface for an invented world, drawn once into a canvas and used as its map.
 *
 * The descriptions were writing cheques the renderer would not cash. A gas giant whose
 * text says "bands of cloud run east and west at different speeds, and the storms where
 * they shear are older than any coastline" was rendering as an untextured brown ball; a
 * world whose text says "there is weather, and from orbit it is the most obvious thing
 * about the place" had nothing on it at all. After three or four arrivals a reader has
 * learned that every arrival looks the same, which is the difference between a
 * destination and a label.
 *
 * The maps are equirectangular, 256 by 128, and generated from the world's own seed, so
 * they cost nothing to ship and are the same for everyone. They are deliberately coarse:
 * at the range these bodies are actually viewed from, bands, continents and ice caps are
 * the features that read, and anything finer is noise that costs memory.
 *
 * Nothing here is a photograph of anything. It is the same invention as the rest of
 * immersive mode, and the inspector says so.
 */

/** Smooth value noise on a lattice, tiled in x so the map wraps at the seam. */
function noiseField(rng: Rng, w: number, h: number): (x: number, y: number) => number {
  const grid: number[][] = []
  for (let j = 0; j <= h; j++) {
    const row: number[] = []
    for (let i = 0; i < w; i++) row.push(rng.next())
    row.push(row[0]) // wrap
    grid.push(row)
  }
  return (x, y) => {
    const fx = x * w
    const fy = Math.min(h - 1e-6, Math.max(0, y * h))
    const i = Math.floor(fx) % w
    const j = Math.floor(fy)
    const tx = fx - Math.floor(fx)
    const ty = fy - j
    // Smoothstep the interpolation so the lattice does not show as a square grid.
    const sx = tx * tx * (3 - 2 * tx)
    const sy = ty * ty * (3 - 2 * ty)
    const a = grid[j][i] * (1 - sx) + grid[j][i + 1] * sx
    const b = grid[j + 1][i] * (1 - sx) + grid[j + 1][i + 1] * sx
    return a * (1 - sy) + b * sy
  }
}

/** Several octaves of it, which is what turns blobs into coastlines. */
function fbm(rng: Rng, octaves: number, base: number): (x: number, y: number) => number {
  const layers = Array.from({ length: octaves }, (_, k) =>
    noiseField(rng, Math.max(2, Math.round(base * 2 ** k)), Math.max(2, Math.round((base / 2) * 2 ** k))),
  )
  return (x, y) => {
    let sum = 0
    let amp = 1
    let total = 0
    for (const layer of layers) {
      sum += layer(x, y) * amp
      total += amp
      amp *= 0.5
    }
    return sum / total
  }
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  const k = Math.min(1, Math.max(0, t))
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

function shade(c: [number, number, number], k: number): [number, number, number] {
  return [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)]
}

/** Which of the three painters a kind uses, and how hard. */
function styleOf(kind: WorldKind): 'banded' | 'continents' | 'mottled' {
  switch (kind) {
    case 'gasGiant':
    case 'hotJupiter':
    case 'iceGiant':
    case 'subNeptune':
    case 'hycean':
    case 'greenhouse':
      return 'banded'
    case 'terrestrial':
    case 'ocean':
      return 'continents'
    default:
      return 'mottled'
  }
}

/**
 * An equirectangular map for one world, as a data URL, or null where no canvas exists.
 *
 * Returns null under a test runner rather than throwing: the map is a rendering detail,
 * and `SphereBody` already falls back to the flat colour when it has no texture.
 */
export function surfaceTexture(id: string, kind: WorldKind, baseColor: string): string | null {
  if (typeof document === 'undefined') return null
  const W = 256
  const H = 128
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const rng = rngFrom(hashSeed(`surface:${id}`))
  const base = hexToRgb(baseColor)
  const style = styleOf(kind)
  const image = ctx.createImageData(W, H)
  const data = image.data

  const warp = fbm(rng, 3, 4)
  const detail = fbm(rng, 4, 6)
  const bandCount = 5 + Math.floor(rng.next() * 9)
  const bandPhase = rng.range(0, Math.PI * 2)
  // How far the colour is allowed to wander from the world's own colour. Small, because
  // the colour is what says which KIND of world this is.
  const swing = style === 'banded' ? 0.4 : style === 'continents' ? 0.55 : 0.32
  const seaLevel = rng.range(0.44, 0.58)
  const iceLatitude = rng.range(0.72, 0.93)
  const sea = kind === 'ocean' ? shade(base, 0.85) : shade(base, 0.6)
  const land: [number, number, number] =
    kind === 'ocean' ? shade(base, 1.35) : [base[0] * 0.75 + 60, base[1] * 0.8 + 45, base[2] * 0.6 + 30]

  for (let y = 0; y < H; y++) {
    const v = y / (H - 1)
    // Latitude, 0 at the equator and 1 at either pole.
    const lat = Math.abs(v * 2 - 1)
    for (let x = 0; x < W; x++) {
      const u = x / W
      let rgb: [number, number, number]

      if (style === 'banded') {
        // Bands run along latitude, pushed sideways by the noise so they are not stripes.
        const wobble = (warp(u, v) - 0.5) * 0.22
        const band = Math.sin((v + wobble) * Math.PI * bandCount + bandPhase)
        const t = 0.5 + band * 0.5
        rgb = mix(shade(base, 1 - swing * 0.5), shade(base, 1 + swing * 0.5), t)
        // A little high-frequency turbulence along the band, which is what makes a band
        // look like moving cloud rather than a painted stripe.
        rgb = mix(rgb, shade(rgb, 1.18), (detail(u, v) - 0.5) * 0.9)
      } else if (style === 'continents') {
        const h = detail(u + warp(u, v) * 0.08, v)
        rgb = h > seaLevel ? mix(land, shade(land, 0.78), (h - seaLevel) * 2.2) : mix(sea, shade(sea, 1.25), h * 1.4)
        // A shelf where the land meets the water, because a hard edge reads as a decal.
        if (Math.abs(h - seaLevel) < 0.035) rgb = mix(rgb, shade(sea, 1.5), 0.55)
      } else {
        const h = detail(u, v)
        rgb = mix(shade(base, 1 - swing), shade(base, 1 + swing), h)
        if (kind === 'lava') {
          // Cracks: the ridges of the noise rather than its peaks.
          const crack = 1 - Math.abs(h - 0.5) * 4
          if (crack > 0) rgb = mix(rgb, [255, 170, 70], crack * 0.85)
        }
        if (kind === 'volcanic') {
          const vent = detail(u * 1.7 + 0.3, v * 1.7)
          if (vent > 0.72) rgb = mix(rgb, [70, 50, 40], (vent - 0.72) * 3)
        }
      }

      // Polar caps, for anything that could hold them.
      if (style !== 'banded' && kind !== 'lava' && kind !== 'hotJupiter') {
        const capNoise = warp(u, v) * 0.12
        if (lat + capNoise > iceLatitude) {
          rgb = mix(rgb, [236, 242, 248], Math.min(1, (lat + capNoise - iceLatitude) * 7))
        }
      }

      const o = (y * W + x) * 4
      data[o] = rgb[0]
      data[o + 1] = rgb[1]
      data[o + 2] = rgb[2]
      data[o + 3] = 255
    }
  }

  ctx.putImageData(image, 0, 0)

  // One storm, for the big banded worlds that the text keeps promising one.
  if (style === 'banded' && (kind === 'gasGiant' || kind === 'hotJupiter') && rng.chance(0.65)) {
    const cx = rng.range(0, W)
    const cy = rng.range(H * 0.25, H * 0.75)
    const rx = rng.range(W * 0.05, W * 0.11)
    const ry = rx * rng.range(0.45, 0.7)
    const storm = shade(base, rng.chance(0.5) ? 1.45 : 0.62)
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx)
    gradient.addColorStop(0, `rgb(${storm.map(Math.round).join(',')})`)
    gradient.addColorStop(1, `rgba(${storm.map(Math.round).join(',')},0)`)
    ctx.save()
    ctx.translate(cx, cy)
    ctx.scale(1, ry / rx)
    ctx.translate(-cx, -cy)
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(cx, cy, rx, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  return canvas.toDataURL('image/png')
}
