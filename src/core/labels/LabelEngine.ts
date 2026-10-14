import * as THREE from 'three'
import type { Engine, SceneNodeHandle } from '../Engine'
import { classStyle } from '../../data/objectClasses'

/**
 * Labels and markers, drawn on a 2D canvas over the WebGL canvas.
 *
 * Three reasons this is not DOM and not 3D text. DOM labels cost a node and a layout
 * per object and fall over somewhere around two hundred of them. Textured 3D text costs
 * an atlas and a draw call each and still needs CPU-side decluttering. A single 2D
 * canvas redrawn once per frame costs one composite, declutters trivially, and gives
 * crisp text at any DPI.
 *
 * ## Markers are the honest answer to scale
 *
 * At true scale, almost everything is sub-pixel almost all the time. Earth seen from
 * Jupiter's orbit is a fraction of a pixel across — physically correct and completely
 * useless. The old renderer answered this by compressing sizes, which made the scene
 * readable by making it false.
 *
 * Instead, when a body's true angular size falls below about two pixels, the mesh fades
 * out and a marker glyph of CONSTANT screen size fades in. The glyph is unmistakably
 * chrome — a hairline ring in the object's class colour, unlit, never shaded — so
 * nobody reads it as the planet itself. The body's true size is never altered; what
 * changes is whether we draw the body or a pointer to it.
 */

export interface LabelItem {
  node: SceneNodeHandle
  /** Higher survives collision. */
  priority: number
}

interface Placed {
  x: number
  y: number
  w: number
  h: number
}

/** Radius of the constant-size marker ring, in CSS pixels. */
const MARKER_RADIUS = 5.5
/** Below this apparent radius in pixels, the marker replaces the mesh entirely. */
const MARKER_FULL_BELOW = 2
/** Above this, the mesh carries itself and the marker is gone. */
const MARKER_GONE_ABOVE = 8

export class LabelEngine {
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly items: LabelItem[] = []
  private readonly index = new Map<string, number>()
  private readonly placed: Placed[] = []
  private readonly projected = new THREE.Vector3()
  private dpr = 1
  private width = 1
  private height = 1

  /** Set by the host so clicks can hit-test markers. */
  hovered: string | null = null
  selectedId: string | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D context unavailable for the label layer')
    this.ctx = ctx
  }

  setSize(width: number, height: number, dpr: number): void {
    this.width = width
    this.height = height
    this.dpr = dpr
    this.canvas.width = Math.round(width * dpr)
    this.canvas.height = Math.round(height * dpr)
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
  }

  /**
   * Replace the label set. Called when modules register objects, not per frame.
   * The id-to-index map exists because the previous implementation did a linear
   * `items.find()` inside the frame loop, which cost around 134,000 string comparisons
   * per frame once the crater and city layers were on.
   */
  setItems(items: LabelItem[]): void {
    this.items.length = 0
    this.index.clear()
    for (const item of items) {
      this.index.set(item.node.id, this.items.length)
      this.items.push(item)
    }
  }

  item(id: string): LabelItem | null {
    const i = this.index.get(id)
    return i === undefined ? null : this.items[i]
  }

  /**
   * Project, declutter and draw.
   *
   * Greedy: sort by priority, reserve an axis-aligned box for each label that fits,
   * skip any that would collide. Greedy decluttering is stable frame to frame as long
   * as the priority order is stable, which matters more than optimality — a label that
   * flickers in and out is worse than a label that is missing.
   */
  render(engine: Engine): { hits: { id: string; x: number; y: number; r: number }[] } {
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.width, this.height)
    this.placed.length = 0
    const hits: { id: string; x: number; y: number; r: number }[] = []

    const halfHeight = this.height / 2
    const sorted = [...this.items].sort((a, b) => b.priority - a.priority)

    for (const item of sorted) {
      const layer = engine.layers.get(item.node.layer)
      if (!layer || !layer.active) continue

      layer.toLocal(this.projected, item.node.worldPosition, item.node.frame)
      const camera = layer.camera
      const distance = camera.position.distanceTo(this.projected)
      if (distance <= 0) continue

      // Behind the camera?
      this.projected.project(camera)
      if (this.projected.z > 1 || this.projected.z < -1) continue

      const x = (this.projected.x * 0.5 + 0.5) * this.width
      const y = (-this.projected.y * 0.5 + 0.5) * this.height
      if (x < -80 || x > this.width + 80 || y < -40 || y > this.height + 40) continue

      // Apparent radius in pixels, from the TRUE radius — never a display radius.
      const radiusUnits = layer.toLocalLength(item.node.radiusMetres)
      const pixelsPerUnit = halfHeight / Math.tan((camera.fov * Math.PI) / 360) / distance
      const apparentPixels = radiusUnits * pixelsPerUnit

      const style = classStyle(item.node.objectClass)
      const selected = item.node.id === this.selectedId

      // Marker opacity: full when the body is sub-pixel, gone once it carries itself.
      const markerAlpha = selected
        ? 1
        : 1 - smoothstep(MARKER_FULL_BELOW, MARKER_GONE_ABOVE, apparentPixels)

      if (markerAlpha > 0.01) {
        this.drawMarker(x, y, style.color, markerAlpha, apparentPixels, selected)
      }
      hits.push({ id: item.node.id, x, y, r: Math.max(MARKER_RADIUS + 4, apparentPixels) })

      // Labels appear once the object is worth naming: either it has a marker, or it
      // is large enough on screen to be looked at.
      const labelAlpha = Math.max(markerAlpha, apparentPixels > 3 ? 1 : 0)
      if (labelAlpha > 0.05) {
        this.drawLabel(item, x, y, style.color, labelAlpha, apparentPixels, selected)
      }
    }

    return { hits }
  }

  private drawMarker(
    x: number,
    y: number,
    color: string,
    alpha: number,
    apparentPixels: number,
    selected: boolean,
  ): void {
    const ctx = this.ctx
    ctx.save()
    ctx.globalAlpha = alpha

    // The hairline ring. Constant size, so it reads as an instrument mark.
    ctx.beginPath()
    ctx.arc(x, y, MARKER_RADIUS, 0, Math.PI * 2)
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.stroke()

    // A centre dot only while the body itself is too small to see.
    if (apparentPixels < 1.2) {
      ctx.beginPath()
      ctx.arc(x, y, 1.1, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
    }

    // Once the true angular size is a meaningful fraction of the ring, draw it inside
    // as a filled disc. The glyph then teaches how small the object really is: the
    // body grows to fill its own marker as you approach.
    if (apparentPixels > 0.3 && apparentPixels < MARKER_RADIUS) {
      ctx.beginPath()
      ctx.arc(x, y, apparentPixels, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.globalAlpha = alpha * 0.35
      ctx.fill()
    }

    if (selected) {
      // A four-piece corner bracket, not a circle — it reads as a selection reticle
      // rather than as another object in the scene.
      const r = Math.max(MARKER_RADIUS + 6, Math.min(apparentPixels * 1.35, 64))
      const arm = r * 0.42
      ctx.globalAlpha = 1
      ctx.strokeStyle = '#8bdbff'
      ctx.lineWidth = 1.5
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ]) {
        ctx.beginPath()
        ctx.moveTo(x + sx * r, y + sy * r - sy * arm)
        ctx.lineTo(x + sx * r, y + sy * r)
        ctx.lineTo(x + sx * r - sx * arm, y + sy * r)
        ctx.stroke()
      }
    }
    ctx.restore()
  }

  private drawLabel(
    item: LabelItem,
    x: number,
    y: number,
    color: string,
    alpha: number,
    apparentPixels: number,
    selected: boolean,
  ): void {
    const ctx = this.ctx
    const primary = item.priority >= 80
    const text = primary ? item.node.name.toUpperCase() : item.node.name

    ctx.save()
    ctx.font = primary
      ? '600 11px "Inter Variable", Inter, system-ui, sans-serif'
      : '500 11px "Inter Variable", Inter, system-ui, sans-serif'
    if (primary) ctx.letterSpacing = '0.14em'

    const metrics = ctx.measureText(text)
    const padX = 6
    const offset = Math.max(MARKER_RADIUS + 5, Math.min(apparentPixels + 6, 56))
    const lx = x + offset
    const ly = y
    const box: Placed = { x: lx - padX, y: ly - 8, w: metrics.width + padX * 2, h: 16 }

    if (!selected && this.collides(box)) {
      ctx.restore()
      return
    }
    this.placed.push(box)

    ctx.globalAlpha = alpha
    // A short leader so the text is clearly attached to its marker without covering it.
    ctx.strokeStyle = color
    ctx.globalAlpha = alpha * 0.5
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x + MARKER_RADIUS + 1, y)
    ctx.lineTo(lx - 3, y)
    ctx.stroke()

    ctx.globalAlpha = alpha
    ctx.shadowColor = 'rgba(0,0,0,0.9)'
    ctx.shadowBlur = 4
    ctx.fillStyle = selected ? '#8bdbff' : primary ? '#f2f6f9' : '#bdc5cb'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, lx, ly)
    ctx.restore()
  }

  private collides(box: Placed): boolean {
    for (const other of this.placed) {
      if (box.x < other.x + other.w && box.x + box.w > other.x && box.y < other.y + other.h && box.y + box.h > other.y) {
        return true
      }
    }
    return false
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}
