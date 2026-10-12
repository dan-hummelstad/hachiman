import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ChevronDown, Lock } from 'lucide-react'
import type { Guild } from '@hachiman/client'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { GuildTile } from '@/components/ui/guild-tile'
import { GuildMenuItems } from '@/components/shell/guild-menu-items'
import { useLayout } from '@/hooks/use-layout'
import { useOnlineCount } from '@/hooks/use-online-count'
import { cn } from '@/lib/utils'
import { useDialogStore } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'

/** The lifted copy of the header row (M43) is 38 tall and 4 px wider than the row on each side. */
const LIFT_HEIGHT = 38
const LIFT_OUTSET = 4

/**
 * Guild header row of the sidebar (B4): crest, name and chevron; on the right the lock (every
 * guild is encrypted) and the online count. A click opens the guild menu as a popover that has
 * the width of the sidebar, under the row. On the mobile layout (M43) the menu is a sheet, and a
 * lifted copy of the row stays lit above the sheet's scrim. The row stays 36 tall.
 */
export function GuildHeader({ guildId }: { guildId: string }): React.JSX.Element {
  const guild = useGuildStore((s) => s.guilds.get(guildId))
  const online = useOnlineCount(guildId)
  const mobile = useLayout() === 'mobile'
  const [open, setOpen] = useState(false)
  const row = useRef<HTMLButtonElement>(null)
  // The centred leave or delete confirm (M50) keeps this row in view (components/ui/dialog.tsx).
  const removing = useDialogStore(
    (s) => s.dialog?.kind === 'removeGuild' && s.dialog.guildId === guildId
  )

  // The lift stands at the rect that the row had when the sheet opened.
  useEffect(() => {
    if (!mobile || !open) return
    const close = (): void => setOpen(false)
    window.addEventListener('resize', close)
    return () => window.removeEventListener('resize', close)
  }, [mobile, open])

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          ref={row}
          type="button"
          data-dialog-mark={(mobile && removing) || undefined}
          className="group/header hover:bg-surface-hover data-[state=open]:bg-surface-hover rounded-control mobile:pl-0.5 mobile:pr-1 flex h-9 w-full shrink-0 items-center gap-2 px-1.5 text-left"
        >
          <HeaderFace guild={guild} online={online} />
        </button>
      </DropdownMenuTrigger>
      {mobile && (
        // On mobile the root is the sheet's Radix Dialog: this portal comes before the sheet's.
        <DialogPrimitive.Portal>
          <HeaderLift row={row} open={open}>
            <HeaderFace guild={guild} online={online} lifted />
          </HeaderLift>
        </DialogPrimitive.Portal>
      )}
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        aria-label={mobile ? guild?.name : undefined}
        className="w-[var(--radix-dropdown-menu-trigger-width)] p-1.5"
      >
        <GuildMenuItems
          guildId={guildId}
          Item={DropdownMenuItem}
          Separator={DropdownMenuSeparator}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The content of the row. `lifted`: the copy over the scrim, with the chevron up and lit. */
function HeaderFace({
  guild,
  online,
  lifted = false
}: {
  guild: Guild | undefined
  online: number
  lifted?: boolean
}): React.JSX.Element {
  return (
    <>
      {guild && (
        <GuildTile
          guild={guild}
          className="bg-surface-raised mobile:size-6 mobile:text-[10px] size-[22px] border-0 text-[9px]"
        />
      )}
      <span className="text-label mobile:text-[15px] min-w-0 truncate font-extrabold">
        {guild?.name ?? 'Loading…'}
      </span>
      <ChevronDown
        className={
          lifted
            ? 'text-text-primary size-3.5 shrink-0 rotate-180'
            : 'text-text-tertiary size-3.5 shrink-0 transition-transform group-data-[state=open]/header:rotate-180'
        }
      />
      <span className="flex-1" />
      <Lock
        aria-label="End-to-end encrypted"
        className="text-feature-voice mobile:size-3 size-3.5 shrink-0"
      />
      <span
        className="text-text-tertiary mobile:gap-2 mobile:font-bold flex shrink-0 items-center gap-1 text-xs font-semibold tabular-nums"
        aria-label={`${online} online`}
      >
        <span aria-hidden className="bg-status-online size-1.5 rounded-full" />
        {online}
      </span>
    </>
  )
}

/** The room between the lifted copy and the top of the sheet. */
const LIFT_GAP = 8

/**
 * Where the lifted copy goes: at the row (`rowTop`), or above the open sheet when the sheet would
 * cover it (an owner's menu on an iPhone SE), so the guild name stays in view. `offsetTop` is the
 * sheet's laid-out top, without its slide-in transform.
 */
function liftTop(rowTop: number): number {
  const sheets = document.querySelectorAll<HTMLElement>('[data-slot="sheet-content"]')
  const sheet = sheets[sheets.length - 1]
  if (!sheet) return rowTop
  return Math.max(LIFT_GAP, Math.min(rowTop, sheet.offsetTop - LIFT_HEIGHT - LIFT_GAP))
}

/**
 * The lift (M43): the sheet scrim and an inert copy of the header row (38, r8, raised, accent
 * edge) at the row's measured rect, or above the sheet when the sheet covers the row (`liftTop`). The copy's padding is the row's plus the outset, less the
 * 1 px edge, so its content sits where the row's does.
 *
 * It is a portal of the sheet's own dialog, just before the sheet's scrim
 * (`[data-slot=sheet-overlay]`, the next sibling in `<body>`): it draws the scrim itself and
 * turns the sheet's one transparent. The sheet's scrim stays on top and keeps its job, so a tap on
 * the copy closes the sheet. `ref` comes from the portal's Presence, which plays the fade-out.
 * The message lift (M5, `components/mobile/message-action-sheet.tsx`) works the same way.
 */
function HeaderLift({
  row,
  open,
  children,
  ref
}: {
  row: React.RefObject<HTMLButtonElement | null>
  open: boolean
  children: React.ReactNode
  ref?: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const place = (): void => {
      const at = row.current?.getBoundingClientRect()
      const el = box.current
      if (!at || !el) return
      el.style.top = `${liftTop(at.top + (at.height - LIFT_HEIGHT) / 2)}px`
      el.style.left = `${at.left - LIFT_OUTSET}px`
      el.style.width = `${at.width + 2 * LIFT_OUTSET}px`
    }
    place()
    // The sheet's portal can mount one render later: place the copy again once it is laid out.
    const frame = requestAnimationFrame(place)
    return () => cancelAnimationFrame(frame)
  }, [row])

  return (
    <div
      ref={ref}
      aria-hidden
      inert
      data-slot="guild-header-lift"
      data-state={open ? 'open' : 'closed'}
      className={cn(
        'bg-surface-scrim fixed inset-0 z-50 duration-250',
        'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:[--tw-animation-fill-mode:forwards]',
        '[&+[data-slot=sheet-overlay]]:bg-transparent'
      )}
    >
      <div
        ref={box}
        className={cn(
          'bg-surface-raised border-accent-primary/40 rounded-control absolute flex h-[38px] items-center gap-2 border pr-[7px] pl-[5px]',
          'shadow-[0_12px_32px_rgb(22_21_31/0.18)] dark:shadow-[0_12px_32px_#00000099]'
        )}
      >
        {children}
      </div>
    </div>
  )
}
