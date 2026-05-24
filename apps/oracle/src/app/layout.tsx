import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'

import './globals.css'

export const metadata: Metadata = {
  title: 'Takusen',
  description: 'Hachiman identity and server registry',
}

// Inline script that runs before first paint to avoid flash of wrong theme.
// Checks a `theme` cookie first (so a future toggle can persist the choice),
// then falls back to prefers-color-scheme. Adds/removes the `dark` class on
// <html>. Specialist agents: do NOT add another copy of this logic in your
// pages — it already runs once here at the document root.
const themeScript = `
(function(){
  try{
    var cookie=document.cookie.split(';').find(function(c){return c.trim().startsWith('theme=');});
    var theme=cookie?cookie.trim().slice(6).trim():null;
    if(theme==='dark'||(!theme&&window.matchMedia('(prefers-color-scheme: dark)').matches)){
      document.documentElement.classList.add('dark');
    }
  }catch(e){}
})();
`.trim()

export default function RootLayout({
  children,
}: {
  children: ReactNode
}): React.JSX.Element {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint: intentional inline script for theme init */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
      </body>
    </html>
  )
}
