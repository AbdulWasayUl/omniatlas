import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Every asset path the source names must exist in `public/`.
 *
 * This became worth a test when asset URLs stopped being literal. Requests now go
 * through `assetUrl()`, which looks the path up in a build-time manifest and, on a miss,
 * returns it unchanged and warns. That fallback is deliberate — a missing entry degrades
 * to the old behaviour instead of a mangled URL — but it also means a path that is wrong
 * at the source no longer fails at build time. It fails in production, as one 404 for one
 * texture, which is exactly the class of thing nobody notices until a user reports that
 * Enceladus is grey.
 *
 * So: the paths are checked here, against the real directory, the same way
 * `modules-smoke` boots the modules against the real data files.
 */

const ROOT = resolve(__dirname, '../..')
const PUBLIC = join(ROOT, 'public')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * Literal `/data/...` and `/textures/...` paths appearing in quotes.
 *
 * Deliberately only the literals. The five modules build their dataset URLs by
 * interpolating a `DATA` constant, and those are covered by `modules-smoke`, which boots
 * each module against the real files and would fail on a bad directory. What this adds is
 * the long tail the smoke test does not reach: the ~30 texture paths in the catalogue
 * tables, which no module boot touches because textures load through the renderer.
 */
function literalAssetPaths(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  const pattern = /['"`](\/(?:data|textures)\/[A-Za-z0-9._/-]+\.[a-z0-9]+)['"`]/g
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    // Block comments are stripped first, because this checks CODE and the comments in
    // this codebase are full of prose about paths. `assetUrl.ts` documents the mapping
    // with a worked example of a hashed name, which is not a file and never will be.
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const match of text.matchAll(pattern)) {
      const path = match[1]
      const sources = found.get(path) ?? []
      sources.push(file.slice(ROOT.length + 1))
      found.set(path, sources)
    }
  }
  return found
}

describe('asset paths', () => {
  const paths = literalAssetPaths()

  it('finds the catalogue texture paths at all, so a passing suite means something', () => {
    // Guards the regex itself: if it silently stopped matching, every assertion below
    // would pass over an empty set and the test would be theatre.
    expect(paths.size).toBeGreaterThan(20)
    expect([...paths.keys()]).toContain('/textures/moons/triton.jpg')
  })

  it('names only files that exist in public/', () => {
    const missing: string[] = []
    for (const [path, sources] of paths) {
      if (!existsSync(join(PUBLIC, path))) missing.push(`${path} (from ${sources.join(', ')})`)
    }
    expect(missing).toEqual([])
  })

  it('names only non-empty files', () => {
    // A zero-byte texture is a download that failed at some point in the past and got
    // committed. It loads without throwing and renders as nothing.
    const empty: string[] = []
    for (const path of paths.keys()) {
      const full = join(PUBLIC, path)
      if (existsSync(full) && statSync(full).size === 0) empty.push(path)
    }
    expect(empty).toEqual([])
  })
})
