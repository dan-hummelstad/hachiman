import { defineConfig } from 'vitest/config'

// Plain node environment: tests hand-roll WebSocket/fetch fakes (no jsdom).
export default defineConfig({ test: { environment: 'node' } })
