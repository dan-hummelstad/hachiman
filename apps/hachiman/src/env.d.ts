// Renderer ambient types. The shared lib doesn't depend on Vite directly; the
// platform apps (hachiman-electron, hachiman-browser) provide their own envs.

// Side-effect CSS imports (resolved by bundlers — Vite/electron-vite — at build time).
declare module '*.css'

// `import.meta.env` is provided by Vite/electron-vite at runtime. We declare
// it loosely here so the shared lib typechecks without depending on
// `vite/client`. The host apps already pull in `vite/client`, which supplies
// a narrower `ImportMetaEnv` — TypeScript's structural merging keeps both
// happy.
interface ImportMetaEnv {
  readonly VITE_TAKUSEN_INVITE_SIGNING_KEY?: string
  readonly [key: string]: string | boolean | undefined
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
