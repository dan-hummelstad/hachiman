import { useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { SettingsNav } from '@/components/settings/settings-nav'
import { SettingsPage } from '@/components/settings/settings-page'
import type { SettingsTarget } from '@/components/settings/settings-model'
import { cn } from '@/lib/utils'

const targetKey = (t: SettingsTarget): string =>
  t.kind === 'user' ? 'user' : t.kind === 'guild' ? `g:${t.guildId}` : `c:${t.channelId}`

/**
 * The window-covering frame of settings, until the shell mounts `SettingsNav` in the sidebar
 * middle and `SettingsPage` in the content card. Radix Dialog handles the focus trap, `Esc` and
 * scroll lock. The picked section is kept per target; a hidden one falls back to the first one.
 */
export function SettingsOverlay({
  open,
  onClose,
  label,
  target,
  initialSection = null
}: {
  open: boolean
  onClose: () => void
  /** Accessible name of the whole overlay, e.g. "Guild settings". */
  label: string
  target: SettingsTarget
  initialSection?: string | null
}): React.JSX.Element {
  const key = targetKey(target)
  const [picked, setPicked] = useState<{ key: string; section: string | null }>(() => ({
    key,
    section: initialSection
  }))
  const section = picked.key === key ? picked.section : null
  const select = (s: string): void => setPicked({ key, section: s })

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          // Focus the overlay itself rather than ringing the first nav row.
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            ;(e.currentTarget as HTMLElement).focus()
          }}
          // Radix catches Esc in the capture phase, before the field sees it; fields that
          // use Esc locally (e.g. cancel an inline edit) opt out with `data-esc-local`.
          onEscapeKeyDown={(e) => {
            if ((e.target as Element | null)?.closest?.('[data-esc-local]')) e.preventDefault()
          }}
          tabIndex={-1}
          className={cn(
            'bg-surface-window text-text-primary fixed inset-0 z-50 flex gap-2 p-2 outline-none',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 duration-150',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0'
          )}
        >
          <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
          <div className="w-[272px] shrink-0 overflow-y-auto pt-2">
            <SettingsNav target={target} section={section} onSelect={select} onBack={onClose} />
          </div>
          <div className="bg-surface-content border-line-hairline min-w-0 flex-1 border">
            <SettingsPage target={target} section={section} onClose={onClose} />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
