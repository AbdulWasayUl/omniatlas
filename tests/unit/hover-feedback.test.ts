import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A marker that cannot say it is clickable.
 *
 * `LabelEngine.hovered` was declared, documented as "set by the host so clicks can
 * hit-test markers", and never written to or read from anywhere in the application. The
 * markers were the only pick targets in the atlas and the only way to discover that one
 * could be clicked was to click it and see what happened — on a sky where most of what
 * is drawn is NOT clickable, which teaches the opposite lesson.
 *
 * Nothing failed, because nothing was wired up to fail: an unused field compiles. These
 * are source-level checks for the same reason `texture-request` is one — the behaviour
 * needs a canvas and a pointer, and the invariant needs neither.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')

describe('hover feedback', () => {
  const viewer = read('core/AtlasViewer.ts')
  const labels = read('core/labels/LabelEngine.ts')

  it('listens for the pointer moving over the canvas', () => {
    expect(viewer).toMatch(/addEventListener\('pointermove', this\.handlePointerMove\)/)
    expect(viewer).toMatch(/addEventListener\('pointerleave', this\.handlePointerLeave\)/)
  })

  it('lets go of those listeners when the viewer is disposed', () => {
    // The viewer outlives a React effect; a listener that survives it holds the whole
    // engine alive through the closure.
    expect(viewer).toMatch(/removeEventListener\('pointermove', this\.handlePointerMove\)/)
    expect(viewer).toMatch(/removeEventListener\('pointerleave', this\.handlePointerLeave\)/)
  })

  it('writes what the pointer is over, and clears it on the way out', () => {
    expect(viewer).toMatch(/this\.labels\.hovered = id/)
    expect(viewer).toMatch(/this\.labels\.hovered = null/)
  })

  it('does not light anything up mid-drag', () => {
    // Swinging the camera drags the pointer across half the sky. Highlighting whatever
    // it crosses on the way is noise.
    expect(viewer).toMatch(/if \(event\.buttons !== 0\) return/)
  })

  it('turns the cursor into something that says "clickable"', () => {
    expect(viewer).toMatch(/cursor = id \? 'pointer' : ''/)
  })

  it('actually reads the field when it draws a marker', () => {
    // The whole failure was a field written at one end and read at neither.
    expect(labels).toMatch(/item\.node\.id === this\.hovered/)
    expect(labels).toMatch(/hovered = false/)
    expect(labels).toMatch(/hovered \? 1\.75 : 1/)
  })

  it('keeps a hovered marker visible even below the alpha cut', () => {
    // The pointer is on it: showing nothing there is the one unacceptable answer.
    expect(labels).toMatch(/Math\.max\(markerAlphaFor\(apparentPixels, selected\), 0\.9\)/)
  })
})
