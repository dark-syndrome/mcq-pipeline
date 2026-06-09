import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'

// Renderer (React) is served by Vite; the Electron main + preload processes are
// bundled by vite-plugin-electron. `npm run dev` launches both together.
export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        // sql.js + yaml stay external so they load from node_modules at runtime
        // (sql.js needs its .wasm resolved via require.resolve).
        vite: { build: { rollupOptions: { external: ['sql.js', 'yaml'] } } },
      },
      preload: { input: 'electron/preload.ts' },
      renderer: {},
    }),
  ],
})
