/** Unit tests of the shared UI services and hooks: `pnpm -F @hachiman/hachiman test`. */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  resolve: {
    alias: [{ find: /^@\//, replacement: fileURLToPath(new URL('../', import.meta.url)) }]
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] }
})
