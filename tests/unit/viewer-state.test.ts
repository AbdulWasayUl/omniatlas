import { describe, expect, it } from 'vitest'
import { oneLabelPerObject } from '../../src/core/AtlasViewer'
import type { SceneNodeHandle } from '../../src/core/Engine'
import { KPC_M, PC_M, vec3d } from '../../src/core/world'
import { SCALE_LADDER } from '../../src/data/scaleLadder'
import { epochIsFitted, EPHEMERIS_VALID_FROM_MS, EPHEMERIS_VALID_TO_MS } from '../../src/astronomy/ephemeris'
import type { AtlasViewer } from '../../src/core/AtlasViewer'
import { serializeUrlState } from '../../src/state/urlState'

/**
 * The pure pieces of the viewer's own state, and the claims the chrome makes about it.
 *
 * Everything here was a lie the atlas told about itself, found by driving the running
 * app: a breadcrumb that put a quasar inside the solar system, a scale rail that
 * captioned a 329,000 light-year view "a planet with its satellites", two labels for
 * one dwarf galaxy, and an ephemeris extrapolated six hundred years past its fit with
 * nothing on screen saying so.
 */

function node(partial: Partial<SceneNodeHandle> & { id: string }): SceneNodeHandle {
  return {
    worldPosition: vec3d(),
    frame: 'icrf',
    radiusMetres: 0,
    layer: 'cosmic',
    objectClass: 'galaxy',
    name: partial.id,
    parentId: null,
    ...partial,
  }
}

describe('one label per object', () => {
  it('keeps a single label when two catalogues register the same galaxy', () => {
    // Segue 1, as the Local Group table and the UNGC each have it: the same direction
    // on the sky, slightly different distances, and only one of them with a size.
    const direction = { x: 0.4, y: -0.7, z: 0.59 }
    const scale = (d: number) => vec3d(direction.x * d, direction.y * d, direction.z * d)
    const kept = oneLabelPerObject([
      node({ id: 'lg:segue-1', name: 'Segue 1', worldPosition: scale(23 * KPC_M), radiusMetres: 7.7e17 }),
      node({ id: 'ungc:segue-1', name: 'Segue 1', worldPosition: scale(26 * KPC_M), radiusMetres: 0 }),
    ])
    expect(kept).toHaveLength(1)
    expect(kept[0].id).toBe('lg:segue-1')
  })

  it('does not fold two different objects that happen to share a name', () => {
    const kept = oneLabelPerObject([
      node({ id: 'a', name: 'NGC 1', worldPosition: vec3d(100 * PC_M, 0, 0) }),
      node({ id: 'b', name: 'NGC 1', worldPosition: vec3d(0, 100 * PC_M, 0) }),
    ])
    expect(kept).toHaveLength(2)
  })

  it('matches across frames, since the two modules do not share one', () => {
    // The same direction stated in galactic coordinates and in ICRF. Comparing the
    // raw components treats these as two objects a hundred degrees apart.
    const galactic = node({
      id: 'lg:draco',
      name: 'Draco',
      frame: 'galactic',
      worldPosition: vec3d(10 * KPC_M, 2 * KPC_M, 70 * KPC_M),
      radiusMetres: 5e18,
    })
    const alone = oneLabelPerObject([galactic])
    expect(alone).toHaveLength(1)
    // Register the same direction a second time, in the frame the other module uses.
    const asIcrf = oneLabelPerObject([galactic, { ...galactic, id: 'ungc:draco', radiusMetres: 0 }])
    expect(asIcrf).toHaveLength(1)
    expect(asIcrf[0].id).toBe('lg:draco')
  })

  it('is independent of the order the modules finished loading in', () => {
    const direction = vec3d(0, 0, 50 * KPC_M)
    const a = node({ id: 'lg:bootes-i', name: 'Bootes I', worldPosition: direction })
    const b = node({ id: 'ungc:bootes-i', name: 'Bootes I', worldPosition: direction })
    expect(oneLabelPerObject([a, b])[0].id).toBe(oneLabelPerObject([b, a])[0].id)
  })
})

describe('the ephemeris window', () => {
  it('covers the present and rejects what the series were never fitted over', () => {
    expect(epochIsFitted(Date.UTC(2026, 9, 17))).toBe(true)
    expect(epochIsFitted(Date.UTC(1750, 0, 1))).toBe(true)
    expect(epochIsFitted(Date.UTC(2199, 0, 1))).toBe(true)
    // Three minutes on the top rung of the rate ladder reaches this, and the planets
    // keep being drawn at plausible-looking extrapolated positions.
    expect(epochIsFitted(Date.UTC(2600, 0, 1))).toBe(false)
    expect(epochIsFitted(Date.UTC(1200, 0, 1))).toBe(false)
    expect(EPHEMERIS_VALID_FROM_MS).toBeLessThan(EPHEMERIS_VALID_TO_MS)
  })
})

describe('the scale ladder, said without the solar system in it', () => {
  it('gives every rung a second name and caption that state a size and nothing else', () => {
    for (const rung of SCALE_LADDER) {
      expect(rung.scaleCaption, rung.id).toBeTruthy()
      expect(rung.scaleLabel, rung.id).toBeTruthy()
      // The whole point: no solar-system landmark, because the camera may be at a
      // quasar. The rail used to head a 1.12 light-year view at TON 618 "OORT CLOUD".
      const landmarks = /voyager|heliopause|oort|mercury|neptune|kuiper|proxima|hyades|pleiades|milky way/
      expect(rung.scaleCaption.toLowerCase(), rung.id).not.toMatch(landmarks)
      expect(rung.scaleLabel.toLowerCase(), rung.id).not.toMatch(landmarks)
    }
  })
})

describe('the shared link', () => {
  /** Only the fields `serializeUrlState` reads. */
  function viewerLike(state: { epochMs: number; timeRate: number; paused: boolean }): AtlasViewer {
    return {
      anchorId: 'saturn',
      epochMs: state.epochMs,
      timeRate: state.timeRate,
      paused: state.paused,
      // The real getter, copied, so the two cannot drift apart silently.
      get trackingNow() {
        return !this.paused && this.timeRate === 1 && Math.abs(this.epochMs - Date.now()) < 2000
      },
      controls: { distanceMetres: 2.4457e8, yaw: -2.4536, pitch: 0.2624 },
      // A real viewer always has an engine, and the link carries its immersive flag so
      // that a share of an invented world arrives somewhere rather than at an empty star.
      engine: { immersive: false },
    } as unknown as AtlasViewer
  }

  it('leaves the clock out of a link whose view really is the present', () => {
    const url = serializeUrlState(viewerLike({ epochMs: Date.now(), timeRate: 1, paused: false }))
    expect(url).not.toContain('t=')
    expect(url).not.toContain('rate=')
    expect(url).toContain('focus=saturn')
  })

  it('pins the clock when the rate is 1 but the epoch is years away', () => {
    // Run at a year a second for six seconds, then step the ladder back to Real time:
    // the rate is 1 again and the atlas is showing 2031. The link used to drop `t=`
    // on exactly this view, so it reopened in the present — the one thing the URL
    // scheme exists not to do.
    const fiveYearsOn = Date.now() + 5.15 * 365.25 * 86_400_000
    const url = serializeUrlState(viewerLike({ epochMs: fiveYearsOn, timeRate: 1, paused: false }))
    expect(url).toContain('t=')
    expect(url).toContain('rate=1')
    expect(decodeURIComponent(url)).toContain(new Date(fiveYearsOn).toISOString())
  })

  it('still spells a pause as rate zero', () => {
    const url = serializeUrlState(viewerLike({ epochMs: Date.now(), timeRate: 60, paused: true }))
    expect(url).toContain('rate=0')
    expect(url).toContain('t=')
  })
})
