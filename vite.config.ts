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
    // Lighthouse flags their absence under Best Practices, and the real reason to want
    // them is that a production stack trace from a minified 589 KB bundle names nothing.
    // They are a separate download that only a devtools session asks for, so they cost
    // visitors nothing.
    sourcemap: true,
  },
})
