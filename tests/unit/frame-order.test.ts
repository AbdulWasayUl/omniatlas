import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { Engine, type AtlasModule, type FrameContext, type SceneNodeHandle } from '../../src/core/Engine'
import { KPC_M, convertFrame, distance3d, vec3d } from '../../src/core/world'

/**
 * The frame ordering invariant.
 *
 * The camera used to be built from an anchor position two frames old: the loop advanced
 * the clock, ran the controller (which rebuilt the pose from an anchor written on the
 * PREVIOUS frame), tracked the anchor against positions the modules had not updated yet,
 * and only then ran the modules. The resulting off-axis error is two times the anchor's
 * orbital speed times the simulated seconds per frame, so it is invisible at live rate
 * and ruinous at every other one — at a month per second the anchored planet left the
 * frustum entirely.
 *
 * `advance` / `draw` exist to make that order impossible to get wrong, and this file
 * pins both halves of it: `advance` moves the world, the camera is placed afterwards,
 * and everything derived from the anchor AND the camera together is computed in `draw`.
 */

/** Metres the test body moves per frame. Stands in for a large time rate. */
const STEP_METRES = 2.5e7
/** Distance the camera is held at from the anchor, exactly, every frame. */
const OFFSET_METRES = 1.5e8

/** A renderer stub: `composite` touches it, and nothing in these tests draws. */
function stubRenderer(): THREE.WebGLRenderer {
  return {
    autoClear: true,
    info: { render: { calls: 0, triangles: 0 } },
    setRenderTarget() {},
    clear() {},
    clearDepth() {},
    render() {},
  } as unknown as THREE.WebGLRenderer
}

/** A module that moves the body it is given, exactly as an ephemeris module would. */
class Mover implements AtlasModule {
  readonly id = 'mover'
  seenEpochMs = -1
  seenAnchorDistance = -1
  seenViewSpan = -1

  constructor(private readonly node: SceneNodeHandle) {}

  init(): void {}

  update(ctx: FrameContext): void {
    this.seenEpochMs = ctx.epochMs
    this.node.worldPosition.x += STEP_METRES
  }

  preRender(ctx: FrameContext): void {
    this.seenAnchorDistance = ctx.anchorDistanceMetres
    this.seenViewSpan = ctx.viewSpanMetres
  }
}

async function makeEngine(node: SceneNodeHandle): Promise<{ engine: Engine; mover: Mover }> {
  const engine = new Engine({ renderer: stubRenderer() })
  engine.setSize(1600, 900)
  engine.register(node)
  const mover = new Mover(node)
  await engine.loadModules([{ id: 'mover', load: async () => mover }])
  engine.setAnchor(node.id)
  return { engine, mover }
}

function body(): SceneNodeHandle {
  return {
    id: 'probe',
    worldPosition: vec3d(7.8e11, 0, 0),
    frame: 'ecliptic',
    radiusMetres: 7e7,
    layer: 'system',
    objectClass: 'planet',
    name: 'Probe',
    parentId: null,
  }
}

/** The loop AtlasViewer runs: advance, re-glue the camera to the anchor, draw. */
function runFrame(engine: Engine, node: SceneNodeHandle, epochMs: number): void {
  engine.advance(epochMs, 1 / 60)
  engine.cameraWorld.x = node.worldPosition.x + OFFSET_METRES
  engine.cameraWorld.y = node.worldPosition.y
  engine.cameraWorld.z = node.worldPosition.z
  engine.draw()
}

describe('frame ordering', () => {
  it('measures the anchor after the modules have moved it', async () => {
    const node = body()
    const { engine, mover } = await makeEngine(node)

    for (let frame = 0; frame < 4; frame++) runFrame(engine, node, 1e12 + frame * 1000)

    // The camera was placed exactly OFFSET_METRES from the body's post-update position,
    // so that is what the engine must have measured. A single frame of lag would show
    // up here as STEP_METRES of error, which is 17% of the offset.
    expect(mover.seenAnchorDistance).toBeCloseTo(OFFSET_METRES, 0)
    expect(engine.anchorWorld.x).toBe(node.worldPosition.x)
  })

  it('leaves the anchor a step away if the camera is placed before advance', async () => {
    const node = body()
    const { engine, mover } = await makeEngine(node)

    // The old order: pose first, then move the world. Kept as a test so the quantity
    // the invariant protects stays visible rather than becoming folklore.
    engine.cameraWorld.x = node.worldPosition.x + OFFSET_METRES
    engine.advance(1e12, 1 / 60)
    engine.draw()

    expect(mover.seenAnchorDistance).toBeCloseTo(OFFSET_METRES - STEP_METRES, 0)
  })

  it('re-origins the near layers onto the post-update anchor', async () => {
    const node = body()
    const { engine } = await makeEngine(node)
    runFrame(engine, node, 1e12)

    const expected = vec3d()
    convertFrame(expected, node.worldPosition, node.frame, engine.layer('system').config.frame)
    expect(distance3d(engine.layer('system').originWorld, expected)).toBeLessThan(1e-3)
    expect(engine.layer('system').anchorId).toBe('probe')
  })

  it('re-origins the near layers in draw alone, with no help from advance', async () => {
    // `advance` used to re-origin them too, a few microseconds before `draw` did it
    // again with the same numbers. Deleting the duplicate is only safe because `draw`
    // owns the job completely, so that is what this asserts: move the body, draw
    // without advancing, and the origin still follows.
    const node = body()
    const { engine } = await makeEngine(node)
    runFrame(engine, node, 1e12)

    node.worldPosition.x += STEP_METRES
    engine.draw()

    const expected = vec3d()
    convertFrame(expected, node.worldPosition, node.frame, engine.layer('system').config.frame)
    expect(distance3d(engine.layer('system').originWorld, expected)).toBeLessThan(1e-3)
    expect(engine.layer('surface').anchorId).toBe('probe')
  })

  it('recomputes anchor distance and view span in draw, not in advance', async () => {
    const node = body()
    const { engine, mover } = await makeEngine(node)
    runFrame(engine, node, 1e12)
    const near = mover.seenViewSpan

    // Nothing but the camera moves. If the span or the distance were carried over from
    // advance, the near plane, the scale ladder and the layer bands would all keep the
    // old value while the body sat centred — the quieter half of the same bug.
    engine.cameraWorld.x = node.worldPosition.x + OFFSET_METRES * 100
    engine.draw()

    expect(mover.seenAnchorDistance).toBeCloseTo(OFFSET_METRES * 100, -2)
    expect(mover.seenViewSpan / near).toBeCloseTo(100, 1)
  })

  it('renderFrame is still advance followed by draw', async () => {
    const node = body()
    const { engine, mover } = await makeEngine(node)
    const before = node.worldPosition.x

    engine.cameraWorld.x = before + STEP_METRES + OFFSET_METRES
    engine.renderFrame(1.5e12, 1 / 60)

    expect(mover.seenEpochMs).toBe(1.5e12)
    expect(node.worldPosition.x).toBe(before + STEP_METRES)
    expect(mover.seenAnchorDistance).toBeCloseTo(OFFSET_METRES, 0)
  })
})

describe('layer activation', () => {
  function starEngine(): Engine {
    const engine = new Engine({ renderer: stubRenderer() })
    engine.setSize(1600, 900)
    // A star 8.4 kpc away, which is where the sky went black: the Milky Way disc field
    // lives in the galactic layer, that layer was well inside its distance band, and it
    // was blanked anyway because a 2e12 m view span is five decades under its span
    // floor. The floor is right about which rung the ladder is on and wrong as a
    // visibility test when there is no nearer rung.
    const star: SceneNodeHandle = {
      id: 'far-star',
      worldPosition: vec3d(8.4 * KPC_M, 0, 0),
      frame: 'icrf',
      radiusMetres: 0,
      layer: 'stellar',
      objectClass: 'star',
      name: 'Far star',
      parentId: null,
    }
    engine.register(star)
    engine.setAnchor('far-star')
    convertFrame(engine.cameraWorld, star.worldPosition, 'icrf', engine.cameraFrame)
    engine.cameraWorld.x += 1.5e12
    engine.draw()
    return engine
  }

  it('lets the galactic layer stand in as a backdrop when nothing nearer draws', () => {
    const engine = starEngine()
    const galactic = engine.layer('galactic')

    expect(galactic.active).toBe(true)
    expect(galactic.renderOpacity).toBeGreaterThan(0.3)
    expect(galactic.isBackdrop).toBe(true)
    // spanOpacity stays raw: it is the span band and nothing else, so that the engine
    // can compose it with the distance band and the layer's role. renderOpacity is the
    // composed number, and the one a module must fade its materials by.
    expect(galactic.spanOpacity).toBe(0)
  })

  it('does not revive the stellar layer, which is out of reach on purpose', () => {
    // 300k sprites projecting to a sub-pixel clump is not a star field.
    expect(starEngine().layer('stellar').active).toBe(false)
  })

  it('hands the backdrop to exactly one layer', () => {
    const engine = starEngine()
    const backdrops = ['cosmic', 'galactic', 'stellar', 'helio'] as const
    const lit = backdrops.filter((id) => engine.layer(id).active)
    expect(lit).toEqual(['galactic'])
  })

  it('keeps the span floor on a planetary close-up', () => {
    const engine = new Engine({ renderer: stubRenderer() })
    engine.setSize(1600, 900)
    const planet: SceneNodeHandle = {
      id: 'planet',
      worldPosition: vec3d(7.8e11, 0, 0),
      frame: 'ecliptic',
      radiusMetres: 7e7,
      layer: 'system',
      objectClass: 'planet',
      name: 'Planet',
      parentId: null,
    }
    engine.register(planet)
    engine.setAnchor('planet')
    engine.cameraWorld.x = planet.worldPosition.x + 3e8
    engine.draw()

    // The nearer layers are drawing, so nothing far gets the backdrop: 43k galaxies
    // over a planet is what the span floor exists to prevent.
    expect(engine.layer('helio').active).toBe(true)
    expect(engine.layer('galactic').active).toBe(false)
    expect(engine.layer('cosmic').active).toBe(false)
  })

  it('always has something switched on inside the zoom range', () => {
    const engine = new Engine({ renderer: stubRenderer() })
    engine.setSize(1600, 900)
    // No anchor, so no layer is kept alive by the anchor clause: this is purely the
    // bands. The cosmic band used to stop at 6.17e26 m while the controller let the
    // camera out to 1e28, leaving four-fifths of a decade of guaranteed blank screen.
    // The band now outlasts any ceiling the controller can be given, which is the only
    // thing a band CAN fix here — see the next test for the part it cannot.
    for (let log = 6; log <= 28; log += 0.25) {
      engine.cameraWorld.x = 10 ** log
      engine.draw()
      const active = engine.layersByOrder.filter((layer) => layer.active).map((layer) => layer.id)
      expect(active.length, `nothing renders at 1e${log} m`).toBeGreaterThan(0)
    }
  })

  it('an active outermost layer is not the same thing as a visible frame', () => {
    // The assertion above says a layer is switched on. That is not what the user sees,
    // and a test that stops there green-lights a blank screen: at 1e28 m the cosmic
    // layer is active with five draw calls and the frame is empty, because every
    // catalogue it draws sits inside ~2.5e25 m of the supergalactic origin and the
    // whole observable universe is then four pixels across. The fix for that is a zoom
    // CEILING in AtlasControls, not a wider band, so this pins the quantity the ceiling
    // has to be chosen against: how many pixels the outermost content spans.
    const engine = new Engine({ renderer: stubRenderer() })
    engine.setSize(1600, 900)
    const contentRadiusMetres = 2.5e25
    const spanPixels = (distanceMetres: number) => {
      engine.cameraWorld.x = distanceMetres
      engine.draw()
      const viewSpan = 2 * Math.tan((engine.fovDegrees * Math.PI) / 360) * (1600 / 900) * distanceMetres
      return ((2 * contentRadiusMetres) / viewSpan) * 1600
    }

    // AtlasControls.MAX_DISTANCE_METRES is 1e26: a third of the frame, still an object.
    expect(spanPixels(1e26)).toBeGreaterThan(300)
    expect(engine.layer('cosmic').active).toBe(true)
    // A decade and a half further out it is a speck, whatever the bands say.
    expect(spanPixels(1e28)).toBeLessThan(10)
  })

  it('anchoring waives the distance band and not the span band', () => {
    // The anchor clause exists because "how far is the camera from this layer's origin"
    // is unanswerable for a layer whose origin IS the anchor. It was briefly promoted to
    // "active at opacity 1, unconditionally", and system and surface were then on in
    // every frame the atlas drew, listed in the stats overlay, holding nothing.
    const engine = new Engine({ renderer: stubRenderer() })
    engine.setSize(1600, 900)
    const node = body()
    engine.register(node)
    engine.setAnchor(node.id)

    engine.cameraWorld.x = node.worldPosition.x + 3e8
    engine.draw()
    expect(engine.layer('system').anchorId).toBe(node.id)
    expect(engine.layer('system').active).toBe(true)

    // Same anchor, pulled back to a view five decades wider than the system layer's
    // span ceiling. The anchor has not changed; the content has stopped being the
    // right size for the view, which is a question the anchor does not answer.
    engine.cameraWorld.x = node.worldPosition.x + 1e13
    engine.draw()
    expect(engine.layer('system').anchorId).toBe(node.id)
    expect(engine.layer('system').active).toBe(false)
    expect(engine.layer('surface').active).toBe(false)
  })

  it('a force-activated layer covers the sky, so nothing lights up behind it', () => {
    // `forceActive` is the escape hatch for a subject that is out of every band — a
    // 1,300 AU black hole. It used to be applied AFTER the covered bookkeeping, so a
    // forced layer drawing the whole subject at opacity 1 still let an outer layer
    // light up at the backdrop floor behind it. Latent while the only forced layer is
    // the anchor-local `system`, which cannot cover anything; this pins the rule for
    // the first stand-in that is forced into a layer with a band.
    const engine = starEngine()
    expect(engine.layer('galactic').isBackdrop).toBe(true)

    engine.layer('stellar').forceActive = true
    engine.draw()

    expect(engine.layer('stellar').active).toBe(true)
    expect(engine.layer('galactic').active).toBe(false)
    expect(engine.layer('cosmic').active).toBe(false)
  })

  it('feathers the distance band instead of stepping it', () => {
    const engine = new Engine({ renderer: stubRenderer() })
    const galactic = engine.layer('galactic')
    let previous = galactic.bandOpacity()
    let biggestStep = 0
    const seen: number[] = []
    for (let log = 17; log <= 24; log += 0.05) {
      galactic.cameraDistanceMetres = 10 ** log
      const opacity = galactic.bandOpacity()
      biggestStep = Math.max(biggestStep, Math.abs(opacity - previous))
      previous = opacity
      seen.push(opacity)
    }
    expect(Math.max(...seen)).toBe(1)
    expect(Math.min(...seen)).toBe(0)
    // An unfeathered band steps 0 -> 1 in one sample, which is a layer popping on.
    expect(biggestStep).toBeLessThan(0.2)
  })
})

describe('transit anchor', () => {
  /** A destination far enough away that measuring against it is visibly wrong. */
  const DESTINATION_METRES = 1.7e26

  function flightEngine(): { engine: Engine; node: SceneNodeHandle } {
    const engine = new Engine({ renderer: stubRenderer() })
    engine.setSize(1600, 900)
    const node: SceneNodeHandle = {
      id: 'quasar',
      worldPosition: vec3d(DESTINATION_METRES, 0, 0),
      frame: 'supergalactic',
      radiusMetres: 1.9e14,
      layer: 'cosmic',
      objectClass: 'black-hole',
      name: 'Quasar',
      parentId: null,
    }
    engine.register(node)
    engine.setAnchor('quasar')
    return { engine, node }
  }

  it('measures against the point the camera orbits, not the destination', () => {
    const { engine } = flightEngine()
    // Mid-flight: the camera is 6.8e15 m from the point it is circling and 1.7e26 m
    // from where it is going. Feeding the bands the latter switched the star field off
    // and left eleven seconds of black screen in the middle of every long flight.
    const orbitPoint = vec3d(1e16, 0, 0)
    engine.setTransitAnchor(orbitPoint, 'ecliptic')
    engine.cameraWorld.x = 1e16 + 6.8e15
    engine.draw()

    expect(distance3d(engine.cameraWorld, engine.anchorWorld)).toBeCloseTo(6.8e15, -12)
    // Identity is untouched: the atlas is still focused on the destination.
    expect(engine.anchorId).toBe('quasar')
  })

  it('re-origins the near layers onto the orbit point, never the destination', () => {
    const { engine, node } = flightEngine()
    engine.setTransitAnchor(vec3d(1e16, 0, 0), 'ecliptic')
    engine.cameraWorld.x = 1e16 + 6.8e15
    engine.advance(1e12, 1 / 60)
    engine.draw()

    // 1.7e26 m is 1.7e20 of the system layer's units — nine decades past what a float32
    // vertex attribute holds, so anything drawn into it there is noise.
    const system = engine.layer('system')
    expect(system.cameraDistanceMetres).toBeLessThan(1e17)
    expect(system.anchorId).toBeNull()

    // And it goes back to the destination the moment the flight lands.
    engine.setTransitAnchor(null, 'ecliptic')
    engine.advance(1e12, 1 / 60)
    engine.draw()
    expect(system.anchorId).toBe(node.id)
  })

  it('names the body being left behind for the length of the flight', async () => {
    const { engine } = flightEngine()
    const seen: { inTransit: boolean; from: string | null; anchor: string | null }[] = []
    const updates: typeof seen = []
    const snapshot = (ctx: FrameContext) => ({
      inTransit: ctx.inTransit,
      from: ctx.transitFromId,
      anchor: ctx.anchorId,
    })
    const spy: AtlasModule = {
      id: 'spy',
      init() {},
      // Both halves: `update` is where a stand-in is built and torn down, so the pair
      // has to be coherent there too, not only by the time `draw` runs.
      update(ctx: FrameContext) {
        updates.push(snapshot(ctx))
      },
      preRender(ctx: FrameContext) {
        seen.push(snapshot(ctx))
      },
    }
    await engine.loadModules([{ id: 'spy', load: async () => spy }])

    // Frame 0 of a flight is still a close-up of the body being LEFT. A module that
    // reads `anchorId` alone tears down whatever it drew for that body on exactly this
    // frame: measured in the real app as M87* filling the screen one frame and an
    // empty star field the next, the instant 'fly to Earth' was clicked.
    engine.setTransitAnchor(vec3d(7.8e11, 0, 0), 'ecliptic', 'earth')
    engine.cameraWorld.x = 7.8e11 + 3e8
    engine.renderFrame(1e12, 1 / 60)
    expect(updates.at(-1)).toEqual({ inTransit: true, from: 'earth', anchor: 'quasar' })
    expect(seen.at(-1)).toEqual({ inTransit: true, from: 'earth', anchor: 'quasar' })

    // ... and it clears on arrival, so nothing keeps drawing the departure body once
    // the destination is the thing in front of the camera.
    engine.setTransitAnchor(null, 'ecliptic')
    engine.renderFrame(1e12, 1 / 60)
    expect(updates.at(-1)).toEqual({ inTransit: false, from: null, anchor: 'quasar' })
    expect(seen.at(-1)).toEqual({ inTransit: false, from: null, anchor: 'quasar' })
  })

  it('keeps the near layers on at the start of a flight, and fades them by span', () => {
    // The first frames of a flight are still a close-up of the body being left. The
    // anchor clause is matched by id, and in transit the near layers have no id, so
    // they switched off on the click — the departure body vanishing instantly is a
    // worse pop than the destination appearing late.
    const { engine } = flightEngine()
    const orbitPoint = vec3d(7.8e11, 0, 0)
    engine.setTransitAnchor(orbitPoint, 'ecliptic')
    engine.cameraWorld.x = 7.8e11 + 3e8
    engine.draw()
    expect(engine.layer('system').active).toBe(true)

    // Five decades out along the same flight, the span band has taken it off again.
    engine.cameraWorld.x = 7.8e11 + 1e13
    engine.draw()
    expect(engine.layer('system').active).toBe(false)
  })
})
