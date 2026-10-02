import { resolve } from "path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Path into the shared `@hachiman/hachiman` package. Its renderer source is
// consumed directly (no build step), so the same `@/` alias it relies on
// internally must resolve here too.
const hachimanSrc = resolve(__dirname, "../hachiman/src");

// VITE_* come from the repo-root .env (see /.env.example) for all three
// bundles. Main needs them too: it builds the renderer CSP from them
// (src/main/csp.ts). Real process env still wins over the file.
const envDir = resolve(__dirname, "../..");

// The renderer is a plain sandboxed web bundle (no Node, no electron imports);
// everything privileged goes through the preload bridge.
export default defineConfig(({ mode }) => ({
  main: {
    envDir,
    // Bundle (do not externalize) the shared lib: main imports its pure
    // takusen-env resolver as TS source for the CSP (src/main/csp.ts).
    build: { externalizeDeps: { exclude: ["@hachiman/hachiman"] } },
  },
  preload: { envDir },
  renderer: {
    envDir,
    // Fixed port: Takusen's CORS allowlist (TAKUSEN_ALLOWED_ORIGINS) names this origin.
    // strictPort fails loudly instead of drifting to an origin Takusen rejects.
    server: { port: 5174, strictPort: true },
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": hachimanSrc } },
    define: { "process.env.NODE_ENV": JSON.stringify(mode) },
  },
}));
