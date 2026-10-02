import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { SelectableRow } from '@/components/ui/selectable-row'
import { isVisible } from '@/hooks/use-settings-section'
import { cn } from '@/lib/utils'

/** One settings page: nav label = page title. Hidden sections are left out of the nav. */
export interface SettingsSection<S extends string> {
  id: S
  label: string
  /** Default true. */
  visible?: boolean
}

export interface SettingsGroup<S extends string> {
  heading: string
  sections: SettingsSection<S>[]
}

interface SettingsLayoutProps<S extends string> {
  open: boolean
  onClose: () => void
  /** Accessible name of the whole overlay, e.g. "Guild settings". */
  label: string
  groups: SettingsGroup<S>[]
  selected: S
  onSelect: (id: S) => void
  /** Destructive action pinned to the bottom of the nav (Leave guild, Sign out, …). */
  destructive?: { label: string; icon?: React.ReactNode; onClick: () => void; disabled?: boolean }
  children: React.ReactNode
}

/**
 * Discord-style full-window settings overlay: nav column left (on --sidebar), content right
 * (max 720px), square close button + "Esc" hint. Radix Dialog handles focus trap, Esc and scroll lock.
 */
export function SettingsLayout<S extends string>(props: SettingsLayoutProps<S>): React.JSX.Element {
  const { open, onClose, label, groups, selected, onSelect, destructive, children } = props
  const title = groups.flatMap((g) => g.sections).find((s) => s.id === selected)?.label
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
            'bg-background text-foreground fixed inset-0 z-50 flex outline-none',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] duration-150',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98]'
          )}
        >
          <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
          <div className="bg-sidebar flex shrink-0 justify-end overflow-y-auto md:flex-[1_0_232px]">
            <nav aria-label={label} className="flex w-[232px] flex-col px-2 py-12">
              {groups.map((g) => (
                <div key={g.heading} className="mb-3 flex flex-col">
                  <h2 className="section-label px-2.5 pb-1">{g.heading}</h2>
                  {g.sections.filter(isVisible).map((s) => (
                    <SelectableRow
                      key={s.id}
                      selected={s.id === selected}
                      aria-current={s.id === selected ? 'page' : undefined}
                      className="truncate"
                      onClick={() => onSelect(s.id)}
                    >
                      {s.label}
                    </SelectableRow>
                  ))}
                </div>
              ))}
              {destructive && (
                <div className="border-border mt-1 border-t pt-3">
                  <button
                    type="button"
                    disabled={destructive.disabled}
                    onClick={destructive.onClick}
                    className="text-destructive hover:bg-accent flex h-8 w-full items-center justify-between px-2.5 text-left text-sm font-medium disabled:opacity-50 [&_svg]:size-4"
                  >
                    {destructive.label}
                    {destructive.icon}
                  </button>
                </div>
              )}
            </nav>
          </div>
          <div className="flex min-w-0 flex-[1_1_800px] overflow-y-auto">
            <main className="w-full max-w-[720px] min-w-0 px-10 pt-12 pb-20">
              <h1 className="mb-5 text-xl leading-7 font-semibold">{title}</h1>
              {children}
            </main>
            <div className="sticky top-0 flex w-[72px] shrink-0 flex-col items-center gap-1.5 pt-12">
              <DialogPrimitive.Close
                aria-label="Close settings"
                className="border-border text-muted-foreground hover:bg-accent hover:text-foreground flex size-9 items-center justify-center border-2"
              >
                <X className="size-4" />
              </DialogPrimitive.Close>
              <span aria-hidden className="text-muted-foreground text-xs font-semibold">
                Esc
              </span>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
