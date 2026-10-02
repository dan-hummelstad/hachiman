/**
 * Unit tests of the shared UI services and hooks. apps/hachiman has no vitest dependency yet, so
 * run it with the vitest binary of a sibling package from apps/hachiman:
 *   ../../pkgs/hachiman-client/node_modules/.bin/vitest run --config src/dev/vitest.config.ts
 * A plain object, not defineConfig: this package cannot import 'vitest/config'.
 */
import { fileURLToPath } from 'node:url'

export default {
  root: fileURLToPath(new URL('../..', import.meta.url)),
  resolve: {
    alias: [{ find: /^@\//, replacement: fileURLToPath(new URL('../', import.meta.url)) }]
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] }
}
