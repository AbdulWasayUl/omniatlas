/**
 * Content-address every dataset and texture in `dist/`, and emit the manifest that
 * `src/data/assetUrl.ts` resolves against.
 *
 * Runs after `vite build`. Vite already hashes what it bundles, but everything under
 * `public/` is copied through verbatim, which is 236 files and 20 MB of this project:
 * all the catalogue binaries and every body texture. Those are the files that need a long
 * cache and cannot have one while their names are stable, because a long cache on a stable
 * name is stale content until something purges it, on every layer, forever.
 *
 * Renaming by content hash makes the cache question disappear instead of needing managing.
 * The file's name changes exactly when its bytes change, so a deploy is a set of URLs
 * nothing has ever requested, and the superseded ones are never asked for again. No purge
 * API, no TTL tuning, and it stays correct behind any number of CDNs.
 *
 * `index.html`, `favicon.svg` and the manifest itself are deliberately NOT hashed: they
 * are the entry points, the things a client asks for by name, and they are what must stay
 * revalidated so a client can discover the new hashes at all. `vercel.json` gives those
 * three `must-revalidate` and everything below `/data` and `/textures` a year of
 * `immutable`.
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile, rename, readdir, stat } from 'node:fs/promises'
import { join, relative, dirname, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')

/** Directories whose contents are content-addressed, relative to `dist`. */
const HASHED_DIRS = ['data', 'textures']

/**
 * Hash length in hex characters.
 *
 * 8 hex characters is 32 bits. Over ~250 assets the chance of any collision is about
 * 7e-6 by the birthday bound, and a collision would have to be between two files that
 * are both live in the same deploy to matter at all. The cost of more characters is paid
 * in every manifest entry; this is the usual bundler default for the same reason.
 */
const HASH_LENGTH = 8

async function* walk(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

/**
 * `foo.bin` -> `foo.<hash>.bin`, and `foo.tar.gz` -> `foo.tar.<hash>.gz`.
 *
 * Only the last extension is treated as the extension, which is what `extname` gives and
 * what every bundler does. The point is only that the hash is recoverable by inspection
 * and that the extension stays last, so content-type sniffing by suffix still works.
 */
function hashedName(file, hash) {
  const ext = extname(file)
  const stem = basename(file, ext)
  return `${stem}.${hash}${ext}`
}

async function main() {
  // Fail loudly rather than silently emitting an empty manifest that would make every
  // asset request fall back to an unhashed path that no longer exists.
  try {
    await stat(DIST)
  } catch {
    console.error('[hash-assets] dist/ not found. Run `vite build` first.')
    process.exit(1)
  }

  /** @type {Record<string, string>} */
  const manifest = {}
  let bytes = 0

  for (const dir of HASHED_DIRS) {
    for await (const file of walk(join(DIST, dir))) {
      const contents = await readFile(file)
      const hash = createHash('sha256').update(contents).digest('hex').slice(0, HASH_LENGTH)
      const target = join(dirname(file), hashedName(file, hash))

      // Posix separators: these become URL paths, and the build may run on Windows.
      const logical = '/' + relative(DIST, file).split(/[\\/]/).join('/')
      const deployed = '/' + relative(DIST, target).split(/[\\/]/).join('/')

      if (manifest[logical]) {
        console.error(`[hash-assets] duplicate logical path ${logical}`)
        process.exit(1)
      }

      await rename(file, target)
      manifest[logical] = deployed
      bytes += contents.byteLength
    }
  }

  const count = Object.keys(manifest).length
  if (count === 0) {
    console.error('[hash-assets] no assets found under ' + HASHED_DIRS.join(', ') + '. Refusing to write an empty manifest.')
    process.exit(1)
  }

  // Sorted, so the manifest is a stable diff across builds rather than reordering with
  // whatever the filesystem happened to return.
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : 1)))
  const json = JSON.stringify(sorted)
  await writeFile(join(DIST, 'asset-manifest.json'), json)

  console.log(
    `[hash-assets] ${count} assets hashed (${(bytes / 1048576).toFixed(1)} MB), ` +
      `manifest ${(Buffer.byteLength(json) / 1024).toFixed(1)} KB`,
  )
}

await main()
