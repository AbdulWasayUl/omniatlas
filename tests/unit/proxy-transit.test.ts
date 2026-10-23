import { beforeAll, describe, expect, it } from 'vitest'
import { Engine, type FrameContext, type SceneNodeHandle } from '../../src/core/Engine'
import { ProxyModule } from '../../src/modules/proxy/index'
import { vec3d } from '../../src/core/world'

beforeAll(() => {
  // The additive point representations share one canvas-drawn sprite, so building a
  // galaxy proxy needs a 2D context. Nothing here looks at a pixel: the stub exists so
  // the module can be constructed at all, the same way `modules-smoke` stubs the image
  // loader the solar module reaches for.
  ;(globalThis as { document?: unknown }).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createRadialGradient: () => ({ addColorStop() {} }),
        fillRect() {},
        set fillStyle(_v: unknown) {},
      }),
    }),
  }
})

/**
 * Which stand-ins exist while a flight is in the air.
 *
 * The proxy module draws whatever the camera is anchored to when that node owns no
 * geometry of its own, which is 1,480 of the registry's objects. It used to hold
 * exactly one at a time, and during a flight it held the DEPARTURE body, so that
 * leaving a black hole did not tear down the thing filling the screen.
 *
 * The cost of that was the other end. The destination had no stand-in until
 * `inTransit` cleared — which is arrival — so flying to an object with no mesh showed
 * empty sky for the whole approach and then the object, whole, at arrival size, in a
 * single frame. Flying from the Sun to Andromeda was three seconds of nothing followed
 * by a galaxy across the viewport.
 *
 * Both ends are now held, and `preRender` fades each on its own apparent size, so the
 * one shrinks out while the other grows in. These tests pin that, because the symptom
 * is a frame of pop in the middle of an animation: invisible in a diff, invisible in a
 * screenshot taken a moment too late, and the kind of thing a refactor quietly undoes.
 */

/** A node with no `object3D`, which is what makes the proxy module want to draw it. */
function proxyNode(id: string, radiusMetres: number): SceneNodeHandle {
  return {
    id,
    worldPosition: vec3d(radiusMetres * 50, 0, 0),
    frame: 'icrf',
    radiusMetres,
    layer: 'stellar',
    objectClass: 'galaxy',
    name: id,
    parentId: null,
  }
}

function frame(engine: Engine, over: Partial<FrameContext>): FrameContext {
  return {
    epochMs: 0,
    delta: 1 / 60,
    cameraWorld: vec3d(),
    cameraFrame: 'ecliptic',
    anchorDistanceMetres: 1e21,
    anchorId: null,
    fovDegrees: 50,
    width: 1200,
    height: 800,
    viewSpanMetres: 1e21,
    inTransit: false,
    transitFromId: null,
    engine,
    ...over,
  }
}

function setup() {
  const engine = new Engine({ renderer: {} as never })
  const module = new ProxyModule()
  module.init(engine)
  engine.register(proxyNode('from', 1e20))
  engine.register(proxyNode('to', 6e20))
  return { engine, module }
}

describe('proxy stand-ins during a flight', () => {
  it('holds only the anchor when no flight is in the air', () => {
    const { engine, module } = setup()
    module.update(frame(engine, { anchorId: 'to' }))

    expect(module.isProxy('to')).toBe(true)
    expect(module.isProxy('from')).toBe(false)
  })

  it('holds BOTH ends while in transit, so neither pops', () => {
    const { engine, module } = setup()
    module.update(frame(engine, { anchorId: 'to', inTransit: true, transitFromId: 'from' }))

    // The destination: absent for the whole approach before this, which is the bug.
    expect(module.isProxy('to')).toBe(true)
    // The departure body: present before this, and it must stay present, because it is
    // what is actually filling the screen on frame 0 of the flight.
    expect(module.isProxy('from')).toBe(true)
  })

  it('drops the departure body once the flight lands', () => {
    const { engine, module } = setup()
    module.update(frame(engine, { anchorId: 'to', inTransit: true, transitFromId: 'from' }))
    module.update(frame(engine, { anchorId: 'to' }))

    expect(module.isProxy('to')).toBe(true)
    expect(module.isProxy('from')).toBe(false)
  })

  it('keeps a proxy layer forced on while either end still needs it', () => {
    const { engine, module } = setup()
    // Both ends are stellar nodes, so both draw into the `system` layer, which has no
    // distance band and is skipped unless something forces it. Tearing down one end
    // used to clear the flag the other was still relying on.
    module.update(frame(engine, { anchorId: 'to', inTransit: true, transitFromId: 'from' }))
    expect(engine.layer('system').forceActive).toBe(true)

    module.update(frame(engine, { anchorId: 'to' }))
    expect(engine.layer('system').forceActive).toBe(true)

    module.update(frame(engine, { anchorId: null }))
    expect(engine.layer('system').forceActive).toBe(false)
  })

  it('releases everything on dispose', () => {
    const { engine, module } = setup()
    module.update(frame(engine, { anchorId: 'to', inTransit: true, transitFromId: 'from' }))
    module.dispose()

    expect(module.isProxy('to')).toBe(false)
    expect(module.isProxy('from')).toBe(false)
    expect(engine.layer('system').forceActive).toBe(false)
    expect(engine.layer('system').scene.children.length).toBe(0)
  })
})
