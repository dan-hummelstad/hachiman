// Renderer ambient types. The shared lib doesn't depend on Vite directly; the
// host apps provide their own envs.

// Side-effect CSS imports (resolved by bundlers at build time).
declare module '*.css'

// `import.meta.env` is provided by Vite at runtime; declared loosely so the
// shared lib typechecks without `vite/client`.
interface ImportMetaEnv {
  readonly VITE_HACHIMAN_GATEWAY_URL?: string
  readonly [key: string]: string | boolean | undefined
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
