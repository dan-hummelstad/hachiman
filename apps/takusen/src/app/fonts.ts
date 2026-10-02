import localFont from 'next/font/local'

// Same faces as the Hachiman app (docs/ui-redesign.md §3), self-hosted from src/fonts.
export const plexSans = localFont({
  src: [
    { path: '../fonts/ibm-plex-sans-latin.woff2', weight: '100 700', style: 'normal' },
    { path: '../fonts/ibm-plex-sans-italic-latin.woff2', weight: '100 700', style: 'italic' },
  ],
  variable: '--font-plex-sans',
  display: 'swap',
})

export const geistMono = localFont({
  src: '../fonts/geist-mono-latin.woff2',
  weight: '100 900',
  variable: '--font-geist-mono',
  display: 'swap',
})
