import type { AtlasViewer } from '../core/AtlasViewer'

/**
 * Deep links.
 *
 * Every view in the atlas is a URL, and opening that URL reproduces the view. This is
 * worth more than it looks: it is the share mechanism, the bug-report mechanism, the
 * bookmark mechanism, and the harness that visual-regression tests drive the app with.
 * Building it later means retrofitting an addressing scheme onto a camera that already
 * has none.
 *
 * The URL is deliberately small and human-legible:
 *
 *     ?focus=europa&d=3.4e6&yaw=1.21&pitch=-0.18&t=2026-10-14T16:00:00Z&rate=3600
 *
 * `d` is a distance in metres from the anchor's centre, which is stable across texture
 * and model changes in a way that a raw camera position is not.
 */

export interface AtlasUrlState {
  focus: string | null
  distanceMetres: number | null
  yaw: number | null
  pitch: number | null
  /** Whether the link was shared with immersive mode on. */
  immersive: boolean
  epochMs: number | null
  rate: number | null
}

export function parseUrlState(search: string = window.location.search): AtlasUrlState {
  const params = new URLSearchParams(search)
  const num = (key: string): number | null => {
    const raw = params.get(key)
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }

  const time = params.get('t')
  let epochMs: number | null = null
  if (time) {
    const parsed = Date.parse(time)
    if (Number.isFinite(parsed)) epochMs = parsed
  }

  return {
    focus: params.get('focus'),
    distanceMetres: num('d'),
    yaw: num('yaw'),
    pitch: num('pitch'),
    immersive: params.get('immersive') === '1',
    epochMs,
    rate: num('rate'),
  }
}

/** Apply a parsed URL state to a live viewer. Called once, after modules have loaded. */
export function applyUrlState(viewer: AtlasViewer, state: AtlasUrlState): void {
  if (state.epochMs !== null) {
    viewer.epochMs = state.epochMs
    // A link that pins an instant should not immediately drift away from it.
    viewer.setTimeRate(state.rate ?? 0)
  } else if (state.rate !== null) {
    viewer.setTimeRate(state.rate)
  }

  // Focus first, orbit second. `focus` picks a sunward arrival angle of its own, so
  // setting the orbit before it would silently discard the angle the link encoded —
  // which defeats the point of sharing a view.
  if (state.focus) {
    // An invented world does not exist until immersive mode has built the system it
    // belongs to, and that happens a frame after its star becomes the anchor. A link
    // straight to one therefore resolved to nothing and fell back to the Sun, which
    // made every shared view of a generated world a lie about where it pointed.
    //
    // The id carries its own host: `gen:star:88/d` is the fourth world of `star:88`.
    // Anchor the star, let the module build, then land on the world itself. The wait is
    // bounded because a system that has not appeared within a few frames is not going to.
    const generated = state.focus.startsWith('gen:') && viewer.engine.node(state.focus) === null
    if (generated) {
      const host = state.focus.slice(4).split('/')[0]
      viewer.focus(host, { instant: true })
      let framesLeft = 12
      const land = () => {
        if (viewer.engine.node(state.focus!) !== null) {
          viewer.focus(state.focus!, { instant: true, distanceMetres: state.distanceMetres ?? undefined })
          if (state.yaw !== null || state.pitch !== null) {
            viewer.controls.setOrbit(state.yaw ?? viewer.controls.yaw, state.pitch ?? viewer.controls.pitch, true)
          }
          return
        }
        if (framesLeft-- > 0) requestAnimationFrame(land)
      }
      requestAnimationFrame(land)
    } else {
      viewer.focus(state.focus, { instant: true, distanceMetres: state.distanceMetres ?? undefined })
    }
  } else if (state.distanceMetres !== null) {
    viewer.controls.setDistance(state.distanceMetres)
  }

  if (state.yaw !== null || state.pitch !== null) {
    viewer.controls.setOrbit(state.yaw ?? viewer.controls.yaw, state.pitch ?? viewer.controls.pitch, true)
    viewer.controls.update(0)
  }
}

function round(value: number, places: number): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

export function serializeUrlState(viewer: AtlasViewer): string {
  const params = new URLSearchParams()
  // The viewer owns anchor identity; controls.anchorId is the same string except
  // during a flight, when it is still the body being left behind.
  if (viewer.anchorId) params.set('focus', viewer.anchorId)
  params.set('d', viewer.controls.distanceMetres.toExponential(4))
  params.set('yaw', String(round(viewer.controls.yaw, 4)))
  params.set('pitch', String(round(viewer.controls.pitch, 4)))
  // Only written when it is on. A link to the real atlas should carry no trace of the
  // invented one, and a link to an invented world has to carry it or the recipient
  // arrives at an empty star.
  if (viewer.engine.immersive) params.set('immersive', '1')
  // The clock is only pinned when it is not simply tracking the present, so a casual
  // share link stays "live" rather than freezing the recipient at the sharer's instant.
  //
  // "Tracking the present" is a question about the EPOCH, not about the rate. Testing
  // `timeRate !== 1` instead silently dropped `t=` from any view whose rate happened
  // to be 1 — run the clock forward a year a second for six seconds, step the ladder
  // back to Real time, and the atlas wrote itself a link that reopened five years
  // earlier, which is the one thing this URL scheme exists not to do.
  if (!viewer.trackingNow) {
    params.set('t', new Date(viewer.epochMs).toISOString())
    // A clock paused by the space key still reports its old rate, so writing timeRate
    // raw made a paused view reopen running. Rate 0 is how this URL spells "paused".
    params.set('rate', String(viewer.paused ? 0 : viewer.timeRate))
  }
  return `?${params.toString()}`
}

/**
 * Keep the address bar in step with the camera, throttled.
 *
 * `replaceState`, never `pushState`: a continuous camera would otherwise write
 * thousands of history entries and make the browser Back button useless.
 */
export function startUrlSync(viewer: AtlasViewer, intervalMs = 700): () => void {
  let last = ''
  const timer = window.setInterval(() => {
    if (viewer.controls.flying) return
    const next = serializeUrlState(viewer)
    if (next === last) return
    last = next
    window.history.replaceState(null, '', next)
  }, intervalMs)

  return () => window.clearInterval(timer)
}
