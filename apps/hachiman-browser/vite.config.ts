import { resolve } from "path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { browserCsp } from "./csp.ts";

// Source path into the shared `@hachiman/hachiman` package. We consume it as
// source (no build step), so the `@/` alias the lib uses internally must
// resolve into the lib's `src` directory.
const hachimanSrc = resolve(__dirname, "../hachiman/src");

// VITE_* come from the repo-root .env (see /.env.example), not from this app's
// directory. Real process env still wins over the file.
const envDir = resolve(__dirname, "../..");

/** The built index.html carries the policy as a meta tag; a production server should also send the header (README). */
function cspMeta(meta: string): Plugin {
  return {
    name: "hachiman-csp-meta",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: meta },
        injectTo: "head-prepend",
      },
    ],
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, "VITE_");
  const dev = browserCsp(env, { dev: true });
  const prod = browserCsp(env, { dev: false });
  return {
    plugins: [react(), tailwindcss(), cspMeta(prod.meta)],
    resolve: { alias: { "@": hachimanSrc } },
    // Fixed port: Takusen's CORS allowlist and the seeded OAuth redirect name this origin.
    // The header also covers Worker scripts, which do not inherit the page policy.
    server: {
      port: 5173,
      strictPort: true,
      headers: { "Content-Security-Policy": dev.header },
    },
    preview: { headers: { "Content-Security-Policy": prod.header } },
    // The crypto Worker and the voice transform Worker of @hachiman/crypto are
    // `new Worker(new URL(…, import.meta.url), { type: 'module' })`. ES format
    // keeps them module Workers and lets them split chunks.
    worker: { format: "es" },
    envDir,
  };
});
