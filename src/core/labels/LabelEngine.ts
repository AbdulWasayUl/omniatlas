import * as THREE from 'three'
import type { Engine, SceneNodeHandle } from '../Engine'
import type { Layer } from '../Layer'
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

interface Candidate {
  item: LabelItem
  x: number
  y: number
  apparentPixels: number
  score: number
  selected: boolean
  /** Set in pass 2a, so the hit pass can tell which candidates already have one. */
  marked: boolean
}

/** Per-layer values that are constant across a frame's nodes. */
interface LayerConstants {
  pixelsPerUnitAtUnitDistance: number
  metresPerUnit: number
}

interface Placed {
  x: number
  y: number
  w: number
  h: number
}

/**
 * How many objects may be marked and labelled at once.
 *
 * Without a cap the atlas draws every registered object at every scale, which at
 * 1,514 objects buries the solar system under a wall of asteroid designations and
 * globular cluster numbers. A real atlas shows what is relevant *here*, and relevance
 * is the job of the scoring function below.
 */
const MAX_MARKED = 34

/**
 * How sharply to penalise an object for being at the wrong distance for this view.
 *
 * The key insight: an object vastly nearer or farther than the current view span is
 * not what the user is looking at, however important it is in the abstract. Mars is
 * the subject at a 7 AU view span and irrelevant at 7 Mpc; the reverse holds for
 * Andromeda. One decade of mismatch costs this many points of priority, which puts a
 * planet ahead of a globular cluster inside the solar system and behind it outside.
 */
const DISTANCE_MISMATCH_PENALTY = 26

/**
 * Decades of distance mismatch resolved by the penalty above.
 *
 * At 26 points per decade the raw mismatch resolves differences down to the float
 * noise floor, which is far finer than the catalogue it is reading. AT-HYG gives the
 * two components of a visual binary independent parallaxes: Sirius lands at 2.1148e17 m
 * and Sirius B at 2.1183e17 m — 2,300 AU apart where the true separation is ~20 AU.
 * Across that 0.16% gap the penalty differs by 0.018, while the sizeBonus meant to keep
 * the primary differs by 4e-6, so the brightest star in the sky lost its name to its
 * 8th-magnitude white dwarf. A 0.05-decade bucket is ~12% in distance: coarser than any
 * binary pair's catalogue inconsistency, finer than the one-decade granularity the
 * penalty is actually reasoning about.
 */
const MISMATCH_QUANTUM = 0.05

/**
 * How far below the best object on screen something may score and still be marked.
 *
 * The budget alone is not enough. There are nine planets and over a thousand comets,
 * asteroids and catalogue objects, so a simple top-N fills the first few slots with
 * planets and the remaining twenty-five with whatever numbered comet happens to be
 * nearby — which is how the inner solar system ended up labelled almost entirely with
 * cometary designations. A relative floor keeps the set to things of comparable
 * standing to whatever is most relevant here.
 */
const SCORE_FLOOR_BELOW_BEST = 42

/**
 * The score below which an object is not marked at all, whatever else is on screen.
 *
 * The relative floor alone has a failure mode: it is measured from the best object
 * in frame, so when nothing relevant is in frame it drops with everything else and
 * admits the lot. Two thousand kilometres above Titania the best-scoring object was
 * a trans-Neptunian asteroid six decades out of scale, scoring about -140 — which
 * set the floor at -180 and let every other distant rock in with it. The result was
 * Sedna, Varuna, Altjira and Rumina labelled over a moon 5,000 km across.
 *
 * An absolute floor says what the relative one cannot: sometimes the honest answer
 * is that nothing here is worth a label.
 */
const ABSOLUTE_SCORE_FLOOR = 8

/**
 * How much a bare catalogue designation gives up to a name someone would recognise.
 *
 * At the supercluster scale the screen filled with "AGC229053", "UGC 7321" and
 * "LV J0737+4724" — all perfectly real objects, none of them meaningful to a reader,
 * and all crowding out the ones that are. A name carrying no digits is almost always
 * the one a person was taught: Andromeda, the Beehive, the Rosette Nebula, Virgo.
 * This is a tie-breaker, not a filter — a designated object with nothing competing
 * for the slot still gets its label.
 */
const DESIGNATION_PENALTY = 16

/**
 * How much a visual binary's companion gives up to its primary.
 *
 * Both components of a naked-eye binary are registered, both carry the flat priority
 * of 90 that every named star gets, and they land within a pixel of each other, so the
 * declutterer labels exactly one of the pair and the score decides which. Nothing else
 * in the score knows which one a reader means by the pair's name: AT-HYG gives Porrima
 * a radius of 9.351e8 m and Porrima B 9.682e8 m, and that 3% — worth about 1e-8 of a
 * point of sizeBonus at 38 light-years, far too fine for the radius tiebreak below to
 * ever see — was enough to put PORRIMA B on screen with no Porrima anywhere. A
 * companion's designation is its primary's name plus a letter, which is a fact about
 * the name rather than about the catalogue's radii, so that is what this reads.
 *
 * Four points clears a one-bucket difference in the mismatch term (26 x 0.05 = 1.3,
 * for a pair whose independent parallaxes straddle a bucket edge) and is far inside
 * the 42-point relative floor, so it orders a pair without changing who gets marked.
 */
const COMPANION_PENALTY = 4

/** Cheap test for "this is a catalogue number rather than a name". */
function isDesignation(name: string): boolean {
  return /\d/.test(name)
}

/** Radius of the constant-size marker ring, in CSS pixels. */
const MARKER_RADIUS = 5.5

/**
 * Which glyph says "you can click this". A DEMO SWITCH, to be removed once one wins.
 *
 * `rings` is what shipped: a closed hairline circle on every marked object at all
 * times, a second circle under the pointer, and a four-corner bracket on the selection.
 * It is unambiguous and it is also a heads-up display pasted over a photograph of the
 * sky — thirty-four of them in frame at once, none of which the telescope would show.
 *
 * The other three split the marker's jobs apart and ration the ink by job, which is
 * what the resting sky actually needs:
 *
 *   1. LOCATE  — say where a thing is when it is smaller than a pixel. Always drawn,
 *                at full strength, in every style: without it a label points at
 *                nothing. This is the centre dot and the body disc.
 *   2. AFFORD  — say the thing is touchable. Faded by how near the pointer is, so the
 *                sky is quiet where you are not pointing and a pool of touchable marks
 *                follows the cursor. The first mouse move teaches the whole rule.
 *   3. HOVER   — say "this one". Always full strength, and ONE ring rather than two.
 *   4. SELECT  — say "this is what you picked". Always full strength.
 */
export type MarkerStyle = 'rings' | 'proximity' | 'ticks' | 'halo'

export const MARKER_STYLES: readonly MarkerStyle[] = ['rings', 'proximity', 'ticks', 'halo']

/** Inside this many pixels of the pointer, an affordance is at full strength. */
const REVEAL_NEAR_PX = 80
/** Beyond this many, it is down to the resting floor. */
const REVEAL_FAR_PX = 280
/**
 * What is left of an affordance with the pointer nowhere near it.
 *
 * Not zero. A sky with no marks at all is a sky that never says anything is clickable,
 * which is the failure this whole mechanism exists to avoid — and on a touch screen
 * there is no pointer to be near. A quarter of a hairline is a trace: enough that the
 * eye finds it when it looks for it, not enough to read as an instrument.
 */
const REVEAL_FLOOR = 0.25
/** Below this apparent radius in pixels, the marker replaces the mesh entirely. */
const MARKER_FULL_BELOW = 2
/** Above this, the mesh carries itself and the marker is gone. */
const MARKER_GONE_ABOVE = 8

export class LabelEngine {
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly items: LabelItem[] = []
  /**
   * The part of each item's score that depends only on its name, parallel to `items`.
   *
   * A regex over the name and a Set lookup, which used to run once per on-screen
   * candidate per frame. Neither answer can change while the registry does not, and
   * with the deep sky registered the loop that read them runs five thousand times a
   * frame, so they are settled once in `setItems` instead.
   */
  private readonly namePenalty: number[] = []
  private readonly index = new Map<string, number>()
  /** Ids whose name is another registered name plus a component letter. */
  private readonly companions = new Set<string>()
  private readonly placed: Placed[] = []
  /** Reused per frame; see the hoist in `render`. */
  private readonly layerConstants = new Map<Layer, LayerConstants>()
  private readonly projected = new THREE.Vector3()
  private dpr = 1
  private width = 1
  private height = 1

  /**
   * The marked object under the pointer, or null.
   *
   * This field existed and was never written to, which is a fair summary of the state
   * of hover in this atlas: markers were clickable but gave no sign of it, so the only
   * way to learn that a dot could be clicked was to click it and see. Written by
   * `AtlasViewer` on pointer move; read here to light the ring under the cursor.
   */
  hovered: string | null = null
  /**
   * Where the pointer is, in CSS pixels, or null while dragging or off the canvas.
   *
   * Null is not "centre of the screen": it means no affordance is near anything, so
   * everything falls to `REVEAL_FLOOR`. Swinging the camera therefore quiets the marks
   * on its own, which is the moment the view is least about picking things out of it.
   */
  pointer: { x: number; y: number } | null = null
  /** See `MarkerStyle`. Demo switch; `rings` is the shipped behaviour. */
  markerStyle: MarkerStyle = 'rings'
  selectedId: string | null = null
  /** The camera's anchor. Always marked, so you can never lose the thing you orbit. */
  anchorId: string | null = null

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
    this.namePenalty.length = 0
    this.index.clear()
    this.companions.clear()
    const names = new Set<string>()
    for (const item of items) {
      this.index.set(item.node.id, this.items.length)
      this.items.push(item)
      names.add(item.node.name)
    }
    // Companions are found here and not in the frame loop: the relation depends only
    // on what is registered, and the set is read for every candidate of every frame.
    for (const item of items) {
      const name = item.node.name
      const cut = name.lastIndexOf(' ')
      // One or two trailing letters only. "Porrima B" and "Alpha Centauri B" are
      // companions of something; "Coma Star Cluster" and "47 Tuc" are not.
      if (cut <= 0 || name.length - cut > 3) continue
      if (!/^[A-Za-z]{1,2}$/.test(name.slice(cut + 1))) continue
      if (names.has(name.slice(0, cut))) this.companions.add(item.node.id)
    }

    for (const item of this.items) {
      this.namePenalty.push(
        (isDesignation(item.node.name) ? DESIGNATION_PENALTY : 0) +
          (this.companions.has(item.node.id) ? COMPANION_PENALTY : 0),
      )
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
  render(engine: Engine, viewSpanMetres: number): { hits: { id: string; x: number; y: number; r: number; touch: boolean }[] } {
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.width, this.height)
    this.placed.length = 0
    const hits: { id: string; x: number; y: number; r: number; touch: boolean }[] = []

    const halfHeight = this.height / 2
    const logSpan = Math.log10(Math.max(viewSpanMetres, 1))

    // Pass 1: project everything on screen and score it for relevance to this view.
    const candidates: Candidate[] = []
    // Per-layer constants, computed on first use rather than per node; see below.
    const layerConstants = this.layerConstants
    layerConstants.clear()
    /** The best score among the non-selected candidates, for the relative floor. */
    let best = -Infinity

    for (let index = 0; index < this.items.length; index++) {
      const item = this.items[index]
      const layer = activeLayerFor(engine, item.node)
      if (!layer) continue

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
      //
      // The two per-layer constants are hoisted out of the loop: with the whole deep-sky
      // catalogue in the registry this runs fifteen thousand times a frame, and a
      // Math.tan per node is fifteen thousand transcendental calls to get eight answers.
      let perLayer = layerConstants.get(layer)
      if (perLayer === undefined) {
        perLayer = {
          pixelsPerUnitAtUnitDistance: halfHeight / Math.tan((camera.fov * Math.PI) / 360),
          metresPerUnit: layer.config.unitMetres,
        }
        layerConstants.set(layer, perLayer)
      }
      // The size on SCREEN, which is what ink and clicks are rationed by; see
      // `SceneNodeHandle.drawnRadiusMetres`.
      const drawnRadius = item.node.drawnRadiusMetres ?? item.node.radiusMetres
      const radiusUnits = drawnRadius / perLayer.metresPerUnit
      const pixelsPerUnit = perLayer.pixelsPerUnitAtUnitDistance / distance
      const apparentPixels = radiusUnits * pixelsPerUnit

      const selected = item.node.id === this.selectedId || item.node.id === this.anchorId

      const distanceMetres = distance * perLayer.metresPerUnit
      const mismatch =
        Math.round(Math.abs(Math.log10(Math.max(distanceMetres, 1)) - logSpan) / MISMATCH_QUANTUM) * MISMATCH_QUANTUM
      // Objects big enough to see get credit for it; a planet filling the screen
      // should never lose its label to a better-scoring point source.
      const sizeBonus = Math.min(apparentPixels, 40)
      const score = selected
        ? Number.POSITIVE_INFINITY
        : item.priority + sizeBonus - DISTANCE_MISMATCH_PENALTY * mismatch - this.namePenalty[index]

      if (score > best && Number.isFinite(score)) best = score
      candidates.push({ item, x, y, apparentPixels, score, selected, marked: false })
    }

    // The floor is measured from the best NON-selected score. Selected and anchored
    // objects score Infinity so they are never dropped, but letting that set the
    // reference would push the floor to -Infinity and mark everything on screen the
    // moment the user clicks something.
    const floor = Math.max((Number.isFinite(best) ? best : 0) - SCORE_FLOOR_BELOW_BEST, ABSOLUTE_SCORE_FLOOR)

    // Two sets, and the difference between them is the point.
    //
    // `worthShowing` is everything that cleared the score floor: the objects this view
    // is about. `marked` is the first MAX_MARKED of those, and that cap is an INK
    // budget — 34 rings and names is what a frame can carry before the sky is a list.
    //
    // The hit test used to run off `marked`, so the ink budget silently decided what was
    // clickable. With 788 UNGC galaxies drawn as points in the cosmic layer, that left
    // hundreds of visible dots that no click could reach, and which 34 were reachable
    // changed as the camera moved — a thing is clickable, you zoom, it is not. That is
    // the "artifacts that weren't clickable at all" half of the report.
    //
    // Clicking is not drawing and does not have to be rationed: `AtlasViewer.pick` is a
    // linear scan over this array, run once per pointer-up, and a few hundred entries
    // costs nothing. The score floor still applies, so this does not make the empty sky
    // clickable — only the things the view already considers worth showing.
    //
    // Filtered BEFORE the sort, which is only an ordering of a set the floor does not
    // depend on, and which the sort therefore does not have to see. With the deep sky
    // registered that is eight thousand on-screen candidates reduced to the eight
    // hundred the view is about, and a comparison sort over a tenth as many elements.
    const worthShowing = candidates.filter((c) => c.selected || c.score >= floor)
    // Ties are now common by design (see MISMATCH_QUANTUM), so they have to be broken
    // deliberately rather than by whichever float happened to compare larger. True
    // physical size is the right discriminator where the catalogue's radii are
    // comparable — a planet before its own moon, Sirius A 1.03e9 m before Sirius B
    // 3.5e7 m — but it is NOT what settles a binary in general: AT-HYG has Porrima B
    // larger than Porrima, so the pairs are ordered by COMPANION_PENALTY in the score
    // above and this only has to be stable. The id makes it so, frame to frame, which
    // the greedy declutterer depends on.
    worthShowing.sort(
      (a, b) =>
        b.score - a.score ||
        b.item.node.radiusMetres - a.item.node.radiusMetres ||
        (a.item.node.id < b.item.node.id ? -1 : 1),
    )
    const marked = worthShowing.slice(0, MAX_MARKED)
    for (const candidate of marked) candidate.marked = true

    // Pass 2a: markers, LOWEST score first.
    //
    // Co-located markers are not decluttered — suppressing one would erase Earth from
    // the solar-system overview — and identical hairline rings composite to one ring
    // anyway. What is visible is the colour: drawn in score order, Jupiter's and
    // Saturn's rings were overpainted by their moons' grey at the outer-system rung.
    // Painting back to front puts the object the view is actually about on top.
    for (let i = marked.length - 1; i >= 0; i--) {
      const { item, x, y, apparentPixels, selected } = marked[i]
      const hovered = item.node.id === this.hovered
      // A hovered marker is always drawn, even below the alpha cut: the pointer is on
      // it, so the one thing the view must not do is show nothing there.
      const markerAlpha = hovered
        ? Math.max(markerAlphaFor(apparentPixels, selected), 0.9)
        : markerAlphaFor(apparentPixels, selected)
      if (markerAlpha > 0.01) {
        const reveal = hovered || selected ? 1 : this.revealAt(x, y)
        this.drawMarker(x, y, classStyle(item.node.objectClass).color, markerAlpha, apparentPixels, selected, hovered, reveal)
      }
    }

    // Hit targets for EVERYTHING on screen, not only for what cleared the score floor.
    //
    // The floor used to apply here, and the reasoning was that it stops the empty sky
    // being clickable. It does not: what stops that is the four-pixel radius below. What
    // the floor actually did was ration clicking by the same budget that rations ink,
    // one view at a time — and once the whole NGC/IC catalogue was in the registry that
    // meant thousands of galaxies drawn as visible ellipses with 15 of them reachable,
    // because the Milky Way was in frame and set a floor 16 points above what a
    // catalogue designation can score. Fly away from the Milky Way and they came back.
    // A thing is clickable, you turn the camera, it is not.
    //
    // A smaller radius for the unmarked ones: an object with no ring on screen should
    // not win a click from a neighbour that has one, so it gets the apparent size it
    // actually occupies rather than the marker's generous floor. `AtlasViewer.pick`
    // takes the NEAREST hit within its own radius, so a dense field costs precision
    // nothing — it is a linear scan of a few thousand comparisons per pointer event.
    for (const { item, x, y, apparentPixels, marked: hasMarker } of candidates) {
      if (hasMarker) continue
      // `touch: false` — see `AtlasViewer.pick`. These have no ring on screen, so they
      // do not get the generous finger-sized grab radius a drawn marker does.
      hits.push({ id: item.node.id, x, y, r: Math.max(apparentPixels, 4), touch: false })
    }

    // Pass 2b: hits and labels, highest score first so declutter favours them.
    for (const { item, x, y, apparentPixels, selected } of marked) {
      hits.push({ id: item.node.id, x, y, r: Math.max(MARKER_RADIUS + 4, apparentPixels), touch: true })

      // Labels appear once the object is worth naming: either it has a marker, or it
      // is large enough on screen to be looked at.
      const labelAlpha = Math.max(markerAlphaFor(apparentPixels, selected), apparentPixels > 3 ? 1 : 0)
      if (labelAlpha > 0.05) {
        this.drawLabel(item, x, y, classStyle(item.node.objectClass).color, labelAlpha, apparentPixels, selected)
      }
    }

    return { hits }
  }

  /**
   * How much of an affordance to draw at a point, given how near the pointer is.
   *
   * See `MarkerStyle`. `rings` keeps every mark at full strength, which is what it
   * shipped as; the rest fall away from the cursor so the sky is quiet where nobody is
   * looking for anything to click.
   */
  private revealAt(x: number, y: number): number {
    if (this.markerStyle === 'rings') return 1
    const pointer = this.pointer
    if (!pointer) return REVEAL_FLOOR
    const near = 1 - smoothstep(REVEAL_NEAR_PX, REVEAL_FAR_PX, Math.hypot(pointer.x - x, pointer.y - y))
    return REVEAL_FLOOR + (1 - REVEAL_FLOOR) * near
  }

  private drawMarker(
    x: number,
    y: number,
    color: string,
    alpha: number,
    apparentPixels: number,
    selected: boolean,
    hovered = false,
    reveal = 1,
  ): void {
    const ctx = this.ctx
    const style = this.markerStyle
    ctx.save()
    ctx.strokeStyle = color
    ctx.globalAlpha = alpha

    // Job 2, the affordance: the only part the pointer's distance is allowed to fade.
    // Hover and selection come after it and are never rationed.
    if (style === 'halo') {
      // No outline at rest: a soft disc of the object's own colour, which reads as
      // light rather than as a mark drawn over the sky. The quietest of the four, and
      // the one that leans hardest on the proximity reveal — so it keeps the glow when
      // the pointer arrives and gains a ring on top rather than swapping for one.
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, MARKER_RADIUS + 4)
      gradient.addColorStop(0, color)
      gradient.addColorStop(1, 'transparent')
      ctx.globalAlpha = alpha * (hovered ? 1 : reveal) * 0.5
      ctx.fillStyle = gradient
      ctx.beginPath()
      ctx.arc(x, y, MARKER_RADIUS + 4, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = alpha
    }

    if (hovered) {
      // One ring, not two. The second ring was the whole of the hover language in
      // `rings` and it is what reads as a targeting reticle; weight and brightness say
      // the same thing on a single circle.
      //
      // `halo` answers with the BROKEN ring rather than a closed one. It is the glyph
      // that still reads as deliberate against a star field — nothing out there is a
      // dashed circle — without putting a bubble round the thing you are pointing at,
      // which is the whole reason the resting state dropped the outline in the first
      // place.
      ctx.lineWidth = style === 'rings' ? 1.75 : 1.5
      if (style === 'halo') strokeBrokenRing(ctx, x, y, MARKER_RADIUS)
      else {
        ctx.beginPath()
        ctx.arc(x, y, MARKER_RADIUS, 0, Math.PI * 2)
        ctx.stroke()
      }
      if (style === 'rings') {
        ctx.globalAlpha = alpha * 0.55
        ctx.beginPath()
        ctx.arc(x, y, MARKER_RADIUS + 3.5, 0, Math.PI * 2)
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.globalAlpha = alpha
      }
    } else if (style === 'ticks') {
      ctx.globalAlpha = alpha * reveal
      ctx.lineWidth = 1
      strokeBrokenRing(ctx, x, y, MARKER_RADIUS)
      ctx.globalAlpha = alpha
    } else if (style !== 'halo') {
      // `rings` and `proximity`: the same closed hairline, drawn at the same constant
      // size. The only difference between the two is what `revealAt` returns.
      ctx.globalAlpha = alpha * reveal
      ctx.beginPath()
      ctx.arc(x, y, MARKER_RADIUS, 0, Math.PI * 2)
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.globalAlpha = alpha
    }

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
      // Shorter arms and a hairline outside `rings`. The bracket is the one mark that
      // has to be unmistakable — there is exactly one on screen and it answers "what
      // did I pick" — so it keeps its shape; what it does not need is the weight of a
      // mark competing with thirty-three others.
      const arm = r * (style === 'rings' ? 0.42 : 0.3)
      ctx.globalAlpha = style === 'rings' ? 1 : 0.85
      ctx.strokeStyle = '#8bdbff'
      ctx.lineWidth = style === 'rings' ? 1.5 : 1
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

/** Marker opacity: full when the body is sub-pixel, gone once it carries itself. */
function markerAlphaFor(apparentPixels: number, selected: boolean): number {
  return selected ? 1 : 1 - smoothstep(MARKER_FULL_BELOW, MARKER_GONE_ABOVE, apparentPixels)
}

/**
 * The layer to project a node in: its own, or the nearest active copy of it.
 *
 * See `SceneNodeHandle.alsoDrawnIn`. Nodes that name one layer — almost all of them —
 * take the first branch and pay one map lookup, exactly as before.
 */
function activeLayerFor(engine: Engine, node: SceneNodeHandle): Layer | null {
  const own = engine.layers.get(node.layer)
  if (own?.active) return own
  for (const id of node.alsoDrawnIn ?? []) {
    const alt = engine.layers.get(id)
    if (alt?.active) return alt
  }
  return null
}

/**
 * A ring with the gaps facing up, down, left and right.
 *
 * It keeps the circular read that says "this is a mark" without closing a bubble
 * around the object, which is what makes thirty-four closed hairlines look like a
 * heads-up display. Nothing in a star field is a dashed circle, so it stays
 * unmistakably deliberate at four arcs of twenty-five degrees.
 */
function strokeBrokenRing(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  for (let quadrant = 0; quadrant < 4; quadrant++) {
    const centre = Math.PI / 4 + (quadrant * Math.PI) / 2
    ctx.beginPath()
    ctx.arc(x, y, radius, centre - 0.44, centre + 0.44)
    ctx.stroke()
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}
