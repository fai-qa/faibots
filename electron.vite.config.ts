import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve(__dirname, 'src/shared')

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } }
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      // Sandboxed preload scripts must be CommonJS.
      rolldownOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        'agent-graph-clean': resolve(__dirname, 'src/renderer/src/components/ui/agent-graph-clean.tsx')
      }
    },
    plugins: [react(), tailwindcss()],
    // Smaller, faster-to-parse bundle for the installed app (main and preload stay readable).
    build: { minify: true }
  }
})
