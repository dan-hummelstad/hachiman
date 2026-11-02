/**
 * Serves Excalidraw's fonts from the app at `excalidraw/fonts/…` (the canvas sets
 * EXCALIDRAW_ASSET_PATH to `excalidraw/`). Excalidraw's fallback is a CDN, which the CSP blocks.
 * Each host adds this plugin to its Vite config. The file names keep their paths: Excalidraw names
 * them, so Vite must not hash them.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FONTS = fileURLToPath(
  new URL('./node_modules/@excalidraw/excalidraw/dist/prod/fonts/', import.meta.url)
)

// ponytail: Xiaolai (the CJK font, 12 MB) stays out of the app; CJK text falls back to a system font.
const fontFiles = (): string[] =>
  readdirSync(FONTS, { recursive: true, encoding: 'utf8' })
    .map((f) => f.split('\\').join('/'))
    .filter((f) => f.endsWith('.woff2') && !f.startsWith('Xiaolai/'))

// The Vite types, structurally: this package does not depend on Vite, the hosts do.
interface FontsPlugin {
  name: string
  configureServer(server: {
    middlewares: {
      use(
        path: string,
        handle: (
          req: { url?: string | undefined },
          res: { setHeader(name: string, value: string): unknown; end(body: Uint8Array): unknown },
          next: () => void
        ) => void
      ): unknown
    }
  }): void
  generateBundle(this: {
    emitFile(file: { type: 'asset'; fileName: string; source: Uint8Array }): string
  }): void
}

export function excalidrawFonts(): FontsPlugin {
  return {
    name: 'hachiman-excalidraw-fonts',
    configureServer(server) {
      const files = new Set(fontFiles())
      server.middlewares.use('/excalidraw/fonts/', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').split('?')[0] ?? '').replace(/^\/+/, '')
        // Only the listed files: no path from the request reaches the file system.
        if (!files.has(name)) return next()
        res.setHeader('Content-Type', 'font/woff2')
        res.end(readFileSync(join(FONTS, name)))
      })
    },
    generateBundle() {
      for (const f of fontFiles())
        this.emitFile({
          type: 'asset',
          fileName: `excalidraw/fonts/${f}`,
          source: readFileSync(join(FONTS, f))
        })
    }
  }
}
