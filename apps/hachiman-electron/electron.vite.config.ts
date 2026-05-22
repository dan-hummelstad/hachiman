import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import commonjsExternals from 'vite-plugin-commonjs-externals'
import { builtinModules } from 'module'
import tailwindcss from '@tailwindcss/vite'

const commonJsPackages: string[] = [
  'electron',
  'electron/main',
  'electron/common',
  'electron/renderer',
  'original-fs',
  'node:events',
  'pem',
  '@discordjs/opus',
  ...builtinModules
] as const

// Path into the shared `@hachiman/hachiman` package. Its renderer source is
// consumed directly (no build step), so the same `@/` alias it relies on
// internally must resolve here too.
const hachimanSrc = resolve(__dirname, '../hachiman/src')

export default defineConfig(({ mode }) => {
  return {
    main: {},
    preload: {},
    renderer: {
      plugins: [react(), tailwindcss(), commonjsExternals({ externals: commonJsPackages })],
      optimizeDeps: {
        include: ['@electron/remote'],
        exclude: commonJsPackages
      },
      resolve: {
        alias: {
          '@': hachimanSrc
        }
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify(mode)
      }
    }
  }
})
