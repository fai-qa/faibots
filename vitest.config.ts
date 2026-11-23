import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      'agent-graph-clean': resolve(__dirname, 'src/renderer/src/components/ui/agent-graph-clean.tsx')
    }
  },
  test: {
    // Process-recovery tests spawn child workers; bound aggregate startup load.
    maxWorkers: 4,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'],
    environment: 'node'
  }
})
