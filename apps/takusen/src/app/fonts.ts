import localFont from 'next/font/local'

// Same faces as the Hachiman app, self-hosted from src/fonts.
export const figtree = localFont({
  src: [
    { path: '../fonts/figtree-latin-500.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/figtree-latin-600.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/figtree-latin-700.woff2', weight: '700', style: 'normal' },
    { path: '../fonts/figtree-latin-800.woff2', weight: '800', style: 'normal' },
  ],
  variable: '--font-figtree',
  display: 'swap',
})

export const plexMono = localFont({
  src: [
    { path: '../fonts/ibm-plex-mono-latin-500.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/ibm-plex-mono-latin-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-plex-mono',
  display: 'swap',
})
