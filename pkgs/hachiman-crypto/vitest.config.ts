import { configDefaults, defineConfig } from 'vitest/config'

// Plain node environment: tests hand-roll WebSocket/fetch fakes (no jsdom). The setup file installs
// fake-indexeddb for the store. Benchmarks (*.bench.ts) run only with `vitest bench`.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/store/vitest.setup.ts'],
    exclude: [...configDefaults.exclude, '**/*.bench.ts'],
  },
})
