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
  },
})
