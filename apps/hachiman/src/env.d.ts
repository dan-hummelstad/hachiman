// Renderer ambient types. The shared lib doesn't depend on Vite directly; the
// platform apps (hachiman-electron, hachiman-browser) provide their own envs.

// Side-effect CSS imports (resolved by bundlers — Vite/electron-vite — at build time).
declare module '*.css'
