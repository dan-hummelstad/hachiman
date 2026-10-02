import { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Source path into the shared `@hachiman/hachiman` package. We consume it as
// source (no build step), so the `@/` alias the lib uses internally must
// resolve into the lib's `src` directory.
const hachimanSrc = resolve(__dirname, "../hachiman/src");

// VITE_* come from the repo-root .env (see /.env.example), not from this app's
// directory. Real process env still wins over the file.
const envDir = resolve(__dirname, "../..");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": hachimanSrc } },
  // Fixed port: Takusen's CORS allowlist and the seeded OAuth redirect name this origin.
  server: { port: 5173, strictPort: true },
  envDir,
});
