import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    headers: {
      // Required for SharedArrayBuffer support
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  assetsInclude: ['**/*.csv', '**/*.glsl', '**/*.vert', '**/*.frag'],
  worker: {
    format: 'es',
  },
  build: {
    target: 'esnext',
    // 'hidden', not true. Vercel returns 403 for `.map` files on a production
    // deployment, so `sourcemap: true` emitted bundles whose `//# sourceMappingURL`
    // comment pointed at something no browser could fetch — a reference that is worse
    // than no reference, and which Lighthouse duly flagged.
    //
    // 'hidden' emits the maps and omits the comment. They are still uploaded with the
    // deployment, so they can be fetched from it or handed to an error tracker when a
    // production stack trace from a minified 589 KB bundle needs reading; nothing asks
    // for them over the wire, and the audit becomes not-applicable rather than failing.
    sourcemap: 'hidden',
    // Calibrated just above three.js, which is 540 KB on its own and is not going to
    // get smaller by being warned about every build. The point of the limit is to catch
    // a chunk that grew when nobody was looking, and at 600 it still would: the entry
    // chunk is 75 KB and react is 190 KB, so anything here tripping this is news.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Three chunks, because they change on completely different clocks.
        //
        // The entry chunk was 608 KB and the build warned about it every time. Measured
        // through the source map, it was 43% three, 40% react-dom and about 15% this
        // application -- so every one-line change to a label shipped a fresh copy of
        // react and three to everyone who had already downloaded both. Splitting the two
        // vendors out leaves roughly 65 KB that actually changes between deployments,
        // and the other two keep their immutable far-future cache headers across it.
        //
        // This does not reduce what a first-time visitor downloads; it is the same bytes
        // in three files. It reduces what a returning one downloads, which for an atlas
        // people come back to is the number that matters.
        advancedChunks: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'three', test: /node_modules[\\/]three[\\/]/ },
          ],
        },
      },
    },
  },
})
