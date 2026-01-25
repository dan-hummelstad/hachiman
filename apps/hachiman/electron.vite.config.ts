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

export default defineConfig(({ mode }) => {
  const target = process.env.VITE_TARGET || 'electron'
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
          '@': resolve('src'),
          '@renderer': resolve('src/renderer/src'),
          '@platform': resolve(__dirname, `platforms/${target}`)
        }
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify(mode),
        'process.env.VITE_TARGET': JSON.stringify(target)
      }
    }
  }
})
