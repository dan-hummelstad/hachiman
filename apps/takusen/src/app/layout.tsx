import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'

import { figtree, plexMono } from './fonts'
import './globals.css'

export const metadata: Metadata = {
  title: 'Takusen',
  description: 'Sign-in and accounts for Hachiman',
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#15141a' },
    { media: '(prefers-color-scheme: light)', color: '#fbf3e2' },
  ],
}

// Inline script that runs before first paint to avoid a flash of the wrong theme.
// Dark is the default, as in the Hachiman app. A `theme=light|dark` cookie wins (so a
// future toggle can persist the choice); otherwise the page follows prefers-color-scheme
// and keeps following it while open. Do NOT add another copy of this logic in a page.
const themeScript = `
(function(){
  try{
    var root=document.documentElement;
    var cookie=document.cookie.split(';').find(function(c){return c.trim().startsWith('theme=');});
    var theme=cookie?cookie.trim().slice(6).trim():null;
    if(theme==='light'||theme==='dark'){root.classList.toggle('dark',theme==='dark');return;}
    var mq=window.matchMedia('(prefers-color-scheme: light)');
    var apply=function(){if(!/(^|;)\\s*theme=/.test(document.cookie))root.classList.toggle('dark',!mq.matches);};
    apply();
    mq.addEventListener('change',apply);
  }catch(e){document.documentElement.classList.add('dark');}
})();
`.trim()

export default function RootLayout({
  children,
}: {
  children: ReactNode
}): React.JSX.Element {
  return (
    <html
      lang="en"
      className={`dark ${figtree.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
      </body>
    </html>
  )
}
