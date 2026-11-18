// Run the renderer in a plain browser against the in-memory mock bridge:
//   npx vite --config src/renderer/vite.preview.config.ts
// (window.faibots is missing there, so src/lib/bridge.ts loads lib/mock-bridge.ts).

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root,
  resolve: {
    alias: {
      '@shared': resolve(root, '../shared'),
      '@renderer': resolve(root, 'src')
    }
  },
  plugins: [react(), tailwindcss()],
  server: { port: 5199, host: '127.0.0.1' },
  preview: { port: 5198, host: '127.0.0.1' },
  build: { outDir: resolve(root, '../../out/renderer-preview'), emptyOutDir: true }
})
