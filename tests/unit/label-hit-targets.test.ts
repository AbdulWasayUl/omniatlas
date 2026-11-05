import { describe, expect, it } from 'vitest'
import { Engine, type SceneNodeHandle } from '../../src/core/Engine'
import { LabelEngine } from '../../src/core/labels/LabelEngine'
import { PC_M, sphericalToCartesian, vec3d } from '../../src/core/world'

/**
 * What is on screen can be clicked, whatever else is on screen with it.
 *
 * The hit set used to be `worthShowing` — the candidates that cleared a score floor
 * measured 42 points below the best thing in frame. That is the right rule for INK,
 * which is rationed because a sky full of names is unreadable. It is the wrong rule for
 * clicking, and the difference only became visible once the whole NGC/IC catalogue was
 * registered: a catalogue designation carries a 16-point penalty, so with the Milky Way
 * in frame setting the floor, 2,800 galaxies drawn as visible ellipses had 15 of them
 * reachable. Turn the camera away from the Milky Way and they came back. A thing is
 * clickable, you turn, it is not.
 *
 * The 2D context is stubbed because none of this is about pixels — the canvas is only
 * there so `render` can run.
 */

const ctx2d = new Proxy(
  { measureText: () => ({ width: 40 }), canvas: {} },
  {
    get: (target: Record<string, unknown>, key: string) =>
      key in target ? target[key] : typeof key === 'string' ? () => {} : undefined,
    set: () => true,
  },
)

function labels(width = 960, height = 800): LabelEngine {
  const canvas = { getContext: () => ctx2d, width, height, style: {} } as unknown as HTMLCanvasElement
  const engine = new LabelEngine(canvas)
  engine.setSize(width, height, 1)
  return engine
}

/**
 * An engine with its layers rebased onto a camera that is looking at the scene origin.
 *
 * The scene basis is y-up, so an identity camera orientation looks along world +y;
 * standing the camera off at -y therefore puts anything near the origin in frame.
 */
function sceneAt(cameraDistancePc: number): Engine {
  const engine = new Engine({ renderer: {} as never })
  const camera = vec3d(0, -cameraDistancePc * PC_M, 0)
  for (const layer of engine.layers.values()) {
    layer.rebase(camera, 'icrf', { x: 0, y: 0, z: 0, w: 1 } as never, 50, 1.2, 1)
    layer.active = false
  }
  return engine
}

function node(id: string, name: string, distancePc: number, raOffsetDeg: number, over: Partial<SceneNodeHandle> = {}): SceneNodeHandle {
  return {
    id,
    name,
    // RA 90 is world +y, which is where the camera in `sceneAt` is looking.
    worldPosition: sphericalToCartesian(vec3d(), 90 + raOffsetDeg, 0, distancePc * PC_M),
    frame: 'icrf',
    radiusMetres: 0,
    layer: 'galactic',
    objectClass: 'galaxy',
    parentId: null,
    ...over,
  }
}

/** Roughly what the camera in `sceneAt` spans, so nothing is penalised for depth. */
const SPAN = 1500 * PC_M

/**
 * Something big enough to set the relative score floor above a catalogue designation.
 *
 * Without one, a lone row is inside the ink budget and gets a marker, which is a
 * different kind of hit; these tests are about the ones the budget left out.
 */
const anchor = { node: node('milky-way', 'Milky Way', 1000, 0, { radiusMetres: 2e19 }), priority: 65 }

describe('hit targets', () => {
  it('gives one to everything on screen, not only to what earned a label', () => {
    const engine = sceneAt(500)
    engine.layer('galactic').active = true
    const label = labels()

    // One bright thing to set the floor, and a crowd of catalogue rows well under it.
    const crowd = Array.from({ length: 200 }, (_, i) => ({
      node: node(`ngc:NGC${1000 + i}`, `NGC ${1000 + i}`, 1000 + i, 0.02 * i - 2),
      priority: 65,
    }))
    label.setItems([anchor, ...crowd])

    const { hits } = label.render(engine, SPAN)
    const reachable = new Set(hits.map((hit) => hit.id))
    const onScreen = crowd.filter((item) => reachable.has(item.node.id))
    // Every one of them, not the handful that outscored a galaxy filling the frame.
    expect(onScreen.length).toBeGreaterThan(100)
    expect(reachable.has('milky-way')).toBe(true)
    // ...and they are reachable WITHOUT being marked, which is the point: the ink
    // budget is untouched, so this is not "label everything" wearing a disguise.
    expect(hits.filter((hit) => hit.touch).length).toBeLessThan(5)
  })

  it('keeps the grab radius tight for anything without a marker', () => {
    const engine = sceneAt(500)
    engine.layer('galactic').active = true
    const label = labels()
    label.setItems([anchor, { node: node('ngc:NGC1234', 'NGC 1234', 1000, 1), priority: 65 }])

    const hit = label.render(engine, SPAN).hits.find((h) => h.id === 'ngc:NGC1234')
    expect(hit).toBeDefined()
    // A finger-sized target on something the user cannot see turns a click on empty
    // sky into a selection; `AtlasViewer.pick` only widens a hit that has a ring.
    expect(hit?.touch).toBe(false)
    expect(hit?.r).toBeLessThanOrEqual(4)
  })

  it('projects a node in the layer that is actually drawing it', () => {
    // The deep sky lives in two layers and crossfades between them. A node names one.
    const engine = sceneAt(500)
    engine.layer('stellar').active = false
    engine.layer('galactic').active = true

    const own = labels()
    own.setItems([{ node: node('ngc:NGC1234', 'NGC 1234', 1000, 0, { layer: 'stellar' }), priority: 65 }])
    expect(own.render(engine, SPAN).hits).toHaveLength(0)

    const either = labels()
    either.setItems([
      { node: node('ngc:NGC1234', 'NGC 1234', 1000, 0, { layer: 'stellar', alsoDrawnIn: ['galactic'] }), priority: 65 },
    ])
    expect(either.render(engine, SPAN).hits.map((hit) => hit.id)).toEqual(['ngc:NGC1234'])
  })

  it('sizes a bearing by what is drawn, not by the radius it correctly has none of', () => {
    const engine = sceneAt(500)
    engine.layer('galactic').active = true

    const point = labels()
    point.setItems([anchor, { node: node('ngc:A', 'NGC 1', 1000, 1), priority: 65 }])
    const asPoint = point.render(engine, SPAN).hits.find((hit) => hit.id === 'ngc:A') as { r: number }

    const drawn = labels()
    drawn.setItems([
      anchor,
      { node: node('ngc:A', 'NGC 1', 1000, 1, { drawnRadiusMetres: 4e18, framingRadiusMetres: 4e18 }), priority: 65 },
    ])
    const asEllipse = drawn.render(engine, SPAN).hits.find((hit) => hit.id === 'ngc:A') as { r: number }

    expect(asPoint.r).toBeLessThanOrEqual(4)
    expect(asEllipse.r).toBeGreaterThan(asPoint.r)
  })
})
