import { createRequire } from "module";
import { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Source path into the shared `@hachiman/hachiman` package. We consume it as
// source (no build step), so the `@/` alias the lib uses internally must
// resolve into the lib's `src` directory.
const hachimanSrc = resolve(__dirname, "../hachiman/src");

// Resolve a concrete path to the `events` polyfill so Vite doesn't treat the
// import specifier as a Node built-in and externalize it.
const require = createRequire(import.meta.url);
const eventsPolyfill = require.resolve("events/");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": hachimanSrc,
      // Polyfill Node's `node:events` (used by @hachiman/hachiman-node) for the browser.
      "node:events": eventsPolyfill,
      events: eventsPolyfill,
    },
  },
  server: {
    port: 5173,
  },
});
