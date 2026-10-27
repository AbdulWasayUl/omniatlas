import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A map that is never requested is a map that is never drawn.
 *
 * `SphereBody` holds every texture behind a deferred load and keeps a one-pixel
 * placeholder in the material until the owning module calls `requestTextures()`. That is
 * right for the solar module, where it saves 9.9 MB of imagery before the first frame,
 * most of it for bodies under a pixel across. It is a trap for everyone else: a module
 * can hand `SphereBody` a perfectly good map, never ask for it, and render the flat
 * fallback colour forever with nothing failing anywhere.
 *
 * That is exactly what happened. A 213-line surface generator shipped completely dead,
 * and no test saw it because the generator returns null without a DOM and the module was
 * never exercised. This is a source-level check rather than a behavioural one for the
 * same reason: the behaviour needs a canvas, and the invariant does not.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.isFile() && full.endsWith('.ts') ? [full] : []
  })
}

describe('deferred textures', () => {
  it('is requested by every module that gives a SphereBody a map', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      if (file.endsWith('SphereBody.ts')) continue
      const text = fs.readFileSync(file, 'utf8')
      if (!text.includes('new SphereBody(')) continue
      // A body given no map has nothing to request.
      if (!/textureUrl\s*:/.test(text)) continue
      if (!text.includes('requestTextures()')) offenders.push(path.relative(SRC, file))
    }
    expect(offenders, 'these build a textured SphereBody and never ask for the texture').toEqual([])
  })

  it('still finds the modules it is meant to be watching', () => {
    // A check that silently matches nothing is worse than no check. Two modules build
    // textured bodies today; if that falls to zero the test above has stopped working.
    const withBodies = sourceFiles(SRC).filter((f) => {
      const text = fs.readFileSync(f, 'utf8')
      return !f.endsWith('SphereBody.ts') && text.includes('new SphereBody(') && /textureUrl\s*:/.test(text)
    })
    expect(withBodies.length).toBeGreaterThanOrEqual(2)
  })
})
