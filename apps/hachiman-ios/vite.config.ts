import { resolve } from "path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { iosCsp, type IosCsp } from "./csp.ts";

// Source path into the shared `@hachiman/hachiman` package. We consume it as
// source (no build step), so the `@/` alias the lib uses internally must
// resolve into the lib's `src` directory.
const hachimanSrc = resolve(__dirname, "../hachiman/src");

// VITE_* come from the repo-root .env (see /.env.example), not from this app's
// directory. Real process env still wins over the file.
const envDir = resolve(__dirname, "../..");

/** The file in the build that holds the policy for the `Content-Security-Policy` header. */
const CSP_HEADER_FILE = "csp-header.txt";

/**
 * The build carries the policy twice. The WKURLSchemeHandler (Hachiman/AppSchemeHandler.swift)
 * reads `csp-header.txt` and sends it as the header of every response, Worker scripts included,
 * because a Worker does not get the policy of the page. The meta tag in index.html is a second layer.
 */
function cspBuild({ header, meta }: IosCsp): Plugin {
  return {
    name: "hachiman-csp",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: meta },
        injectTo: "head-prepend",
      },
    ],
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: CSP_HEADER_FILE,
        source: header,
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, "VITE_");
  const dev = iosCsp(env, { dev: true });
  const prod = iosCsp(env, { dev: false });
  return {
    plugins: [react(), tailwindcss(), cspBuild(prod)],
    resolve: { alias: { "@": hachimanSrc } },
    // The app is served at hachiman://app/ (Hachiman/AppSchemeHandler.swift), so
    // root-absolute asset paths resolve under that origin, also from the SPA fallback.
    base: "/",
    build: { outDir: "dist" },
    // Fixed port, beside the browser host (5173). The header also covers Worker
    // scripts, which do not inherit the page policy.
    server: {
      port: 5175,
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
