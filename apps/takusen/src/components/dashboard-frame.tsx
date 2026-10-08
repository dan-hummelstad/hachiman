'use client'

import { PanelLeftIcon } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { Dialog as DialogPrimitive } from 'radix-ui'
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { CommandPalette } from '@/components/command-palette'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface FrameState {
  /** md and up: the sidebar is hidden. */
  collapsed: boolean
  /** The collapse button in the sidebar head: collapses on desktop, closes the drawer on phones. */
  hideSidebar: () => void
  /** The page bar button: shows the sidebar again (desktop) or opens the drawer (phones). */
  showSidebar: () => void
  openPalette: () => void
}

const FrameContext = createContext<FrameState | null>(null)

function useFrame(): FrameState {
  const ctx = useContext(FrameContext)
  if (!ctx) throw new Error('useFrame outside DashboardFrame')
  return ctx
}

export function useOpenPalette(): () => void {
  return useFrame().openPalette
}

export function useHideSidebar(): () => void {
  return useFrame().hideSidebar
}

/** Tailwind `md`: the sidebar is a column from here up, a drawer below. */
function isDesktop(): boolean {
  return window.matchMedia('(min-width: 48rem)').matches
}

const SCREEN = 'bg-[linear-gradient(180deg,var(--wash),var(--surface-window)_60%)]'

/**
 * The dashboard screen (E1, F1): the sidebar on the window wallpaper, the page in a square
 * content card. Below md the sidebar is a drawer that the page bar's button opens.
 */
export function DashboardFrame({
  sidebar,
  admin,
  children,
}: {
  sidebar: ReactNode
  admin: boolean
  children: ReactNode
}): React.JSX.Element {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  // A navigation closes the drawer (adjusted during render, not in an effect).
  const [shownPath, setShownPath] = useState(pathname)
  if (shownPath !== pathname) {
    setShownPath(pathname)
    setDrawerOpen(false)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const state = useMemo<FrameState>(
    () => ({
      collapsed,
      hideSidebar: () => (isDesktop() ? setCollapsed(true) : setDrawerOpen(false)),
      showSidebar: () => (isDesktop() ? setCollapsed(false) : setDrawerOpen(true)),
      openPalette: () => {
        setDrawerOpen(false)
        setPaletteOpen(true)
      },
    }),
    [collapsed],
  )

  return (
    <FrameContext.Provider value={state}>
      <div className={cn('flex h-dvh text-text-primary', SCREEN)}>
        <aside
          aria-label="Sidebar"
          className={cn('hidden w-[272px] shrink-0', !collapsed && 'md:flex')}
        >
          {sidebar}
        </aside>
        <DialogPrimitive.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-surface-scrim data-[state=open]:animate-in data-[state=open]:fade-in-0 md:hidden" />
            <DialogPrimitive.Content
              aria-describedby={undefined}
              className={cn(
                'fixed inset-y-0 left-0 z-50 flex w-[288px] max-w-[85vw] border-r border-line-hairline shadow-card outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-left md:hidden',
                SCREEN,
              )}
            >
              <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
              {sidebar}
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
        <main
          className={cn(
            'flex min-w-0 flex-1 md:py-2 md:pr-2',
            collapsed ? 'md:pl-2' : 'md:pl-0',
          )}
        >
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface-content md:border md:border-line-hairline">
            {children}
          </div>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} admin={admin} />
    </FrameContext.Provider>
  )
}

/** The page bar's sidebar button: always on phones, on desktop only while the sidebar is collapsed. */
export function SidebarToggle(): React.JSX.Element {
  const { collapsed, showSidebar } = useFrame()
  return (
    <Button
      variant="quiet"
      size="icon"
      aria-label="Show sidebar"
      onClick={showSidebar}
      className={cn('-ml-2', !collapsed && 'md:hidden')}
    >
      <PanelLeftIcon />
    </Button>
  )
}
