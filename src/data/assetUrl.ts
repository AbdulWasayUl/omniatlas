/**
 * Resolve a logical asset path to the content-addressed URL actually deployed.
 *
 * Every dataset and texture in the atlas is referenced by a stable, readable path
 * (`/textures/moons/triton.webp`, `/data/stars/l2/0.bin`). The build rewrites those files
 * to carry a hash of their own contents (`/textures/moons/triton.4f2a91c3.webp`) and emits
 * a manifest mapping one to the other; this module is the single place that applies it.
 *
 * WHY, because the alternative looks simpler and is wrong. The goal is a long browser and
 * CDN cache that still never serves a stale file. Those two cannot both be had from cache
 * headers on a stable filename: a one-year `immutable` on `/textures/moons/triton.webp`
 * means every browser and every edge keeps the old bytes for a year unless something
 * purges them, and Vercel's own documentation says so for exactly this case, noting that a
 * CDN in front "may hold the asset with its original one-year immutable cache header until
 * you purge it". Purging is a thing you must remember, per layer, forever.
 *
 * Changing the URL instead removes the problem rather than managing it. New bytes produce
 * a new name, every cache misses it on the way in, and the old name is simply never asked
 * for again. It needs no purge API, holds across arbitrarily many cache layers, and is
 * what makes putting a second CDN in front safe rather than a second thing to invalidate.
 *
 * Failure behaviour is deliberate. A path the manifest does not know is returned unchanged
 * rather than mangled, so a missing entry degrades to the pre-hashing behaviour instead of
 * a guaranteed 404, and the module warns once so it is visible rather than silent.
 */

/** Logical path -> deployed path. Empty in development, where files are served as named. */
type AssetManifest = Record<string, string>

const MANIFEST_URL = '/asset-manifest.json'

/**
 * Loaded with a top-level await, so that importing this module is enough to guarantee the
 * mapping is ready.
 *
 * The ordering problem is otherwise genuinely nasty: `SphereBody` resolves texture URLs
 * synchronously inside a constructor that runs during module init, and the surface layers
 * resolve theirs from inside a React hook much later. Any scheme where callers must
 * remember to await something first has a failure mode that only appears in production,
 * only for whichever module happens to win a race, and shows up as a 404 for one texture.
 * A top-level await costs one small request before the first frame and makes the question
 * unaskable. It needs `build.target: 'esnext'`, which `vite.config.ts` already sets.
 */
const manifest: AssetManifest = await loadManifest()

async function loadManifest(): Promise<AssetManifest> {
  // The dev server serves `public/` verbatim at the logical paths, so there is nothing to
  // map and no manifest to fetch. Checking this first also keeps a 404 out of the console
  // on every `npm run dev` boot.
  if (import.meta.env.DEV) return {}
  try {
    const response = await fetch(MANIFEST_URL)
    if (!response.ok) {
      console.error(`[omniatlas] asset manifest returned ${response.status}; serving unhashed paths`)
      return {}
    }
    return (await response.json()) as AssetManifest
  } catch (error) {
    console.error('[omniatlas] asset manifest unavailable; serving unhashed paths', error)
    return {}
  }
}

const missing = new Set<string>()

/**
 * The deployed URL for a logical asset path.
 *
 * Call this at the point a path becomes a request, not where it is declared: the
 * catalogue's `textureUrl` fields and the modules' `DATA` constants stay readable, and
 * there is one place to look when a URL is wrong.
 */
export function assetUrl(path: string): string {
  const hashed = manifest[path]
  if (hashed) return hashed
  // Nothing to say in development, where the manifest is empty by design.
  if (!import.meta.env.DEV && !missing.has(path)) {
    missing.add(path)
    console.warn(`[omniatlas] no manifest entry for ${path}; requesting it unhashed`)
  }
  return path
}

/** Number of assets the manifest knows about. Exposed for the stats overlay and tests. */
export function assetManifestSize(): number {
  return Object.keys(manifest).length
}
