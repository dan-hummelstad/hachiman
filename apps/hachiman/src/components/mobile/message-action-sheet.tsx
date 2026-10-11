import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Check } from 'lucide-react'
import { EmojiPicker } from '@/components/chat/emoji-picker'
import {
  findAction,
  liftPlacement,
  useMessageActions,
  type MessageAction,
  type MessageActionId
} from '@/components/chat/message-actions'
import { quoteText } from '@/components/chat/message-summary'
import type { RowPolicy } from '@/components/chat/row-policy'
import { react } from '@/components/chat/transcript-actions'
import {
  MenuSheet,
  MenuSheetContent,
  MenuSheetItem,
  MenuSheetSeparator
} from '@/components/mobile/menu-sheet'
import { focusComposer } from '@/components/mobile/mobile-chat-footer'
import { QuickReactions } from '@/components/mobile/quick-reactions'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useCopy } from '@/hooks/use-copy'
import { useMemberView } from '@/hooks/use-member'
import { reactionKeyOf } from '@/lib/custom-emoji'
import { setSheetOpener } from '@/lib/focus-opener'
import { ROLE_INK_SCOPE } from '@/lib/role-ink'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/stores/messagesStore'
import { useUserStore } from '@/stores/userStore'

/** The action groups of the sheet (M5), in order. A group with no actions draws nothing. */
const GROUPS: readonly (readonly MessageActionId[])[] = [
  ['reply', 'thread', 'copy', 'pin'],
  ['edit', 'info'],
  ['delete']
]

/** Feature icons of M5; the others take the row's secondary text colour. */
const ICON_TINT: Partial<Record<MessageActionId, string>> = {
  thread: 'text-feature-thread',
  pin: 'text-feature-event'
}

/** How long "Copied" shows before the sheet closes. */
const COPIED_MS = 700

/** Longest quote of the message in the delete confirm. */
const QUOTE_MAX = 80

/** The VoiceOver button of a transcript row: the focus goes back to it. */
const ACTIONS_BUTTON = '[data-slot="message-actions-button"]'

/** The actions button of `row`. */
const actionsButtonOf = (row: HTMLElement): HTMLElement | null =>
  row.querySelector<HTMLElement>(ACTIONS_BUTTON)

/**
 * Where the focus goes once `row` is deleted: the actions button of the next row, else of the one
 * before, else the transcript's scroller.
 */
function neighbourOf(row: HTMLElement): HTMLElement | null {
  const scroller = row.closest<HTMLElement>('[data-slot="chat-scroll"]')
  const own = actionsButtonOf(row)
  const buttons = [...(scroller ?? document).querySelectorAll<HTMLElement>(ACTIONS_BUTTON)]
  const i = own ? buttons.indexOf(own) : -1
  return (i >= 0 ? (buttons[i + 1] ?? buttons[i - 1]) : undefined) ?? scroller
}

export interface MessageActionSheetProps {
  message: ChatMessage
  /** The row that the long press lifted: an inert clone of it rises above the sheet. */
  row: HTMLElement
  guildId: string | null
  policy: RowPolicy
  onEditingChange: (messageId: string | null) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The message action sheet of the mobile layout (M5, spec A3), in place of the desktop hover
 * toolbar. The held row lifts above a darker scrim, and the sheet rises with quick reactions and
 * the actions of `useMessageActions`. A tap on the scrim or on the lifted row closes it, as do
 * Escape and a swipe down on the handle. Delete asks first; "More reactions" opens the emoji
 * picker as a sheet. Mount it once per transcript, keyed per press.
 */
export function MessageActionSheet({
  message,
  row,
  guildId,
  policy,
  onEditingChange,
  open,
  onOpenChange
}: MessageActionSheetProps): React.JSX.Element {
  const startEdit = useCallback(() => onEditingChange(message.id), [onEditingChange, message.id])
  const actions = useMessageActions(message, policy, startEdit)
  const reactAction = findAction(actions, 'react')
  const deleteAction = findAction(actions, 'delete')
  const [picking, setPicking] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const { copied, failed: copyFailed, copy } = useCopy({ resetMs: null })
  /** An element inside the sheet: the lifted row finds the sheet's top through it. */
  const anchor = useRef<HTMLDivElement>(null)
  /** An action moved the focus on (to a field or another sheet): closing leaves it there. */
  const handedOff = useRef(false)
  /** Where the focus goes after a delete, found before the row goes. */
  const afterDelete = useRef<HTMLElement | null>(null)

  /** The row's actions button takes the focus back; after a delete, its neighbour does. */
  const focusRow = (e: Event): void => {
    e.preventDefault()
    const target = row.isConnected ? actionsButtonOf(row) : afterDelete.current
    target?.focus({ preventScroll: true })
  }

  useEffect(() => {
    if (copied === null) return
    const t = setTimeout(() => onOpenChange(false), COPIED_MS)
    return () => clearTimeout(t)
  }, [copied, onOpenChange])

  /**
   * Closes the sheet at once, so that its focus trap lets go, then runs `then` in the same tap:
   * WKWebView raises the keyboard only for a focus inside the gesture (spec §2.8).
   */
  const closeThen = (then: () => void): void => {
    handedOff.current = true
    flushSync(() => onOpenChange(false))
    then()
  }

  const select =
    (action: MessageAction) =>
    (event: Event): void => {
      switch (action.id) {
        case 'react':
          return
        case 'reply':
          event.preventDefault()
          return closeThen(() => {
            action.run()
            focusComposer()
          })
        case 'edit':
          // The edit box focuses its field as it mounts, inside this tap.
          event.preventDefault()
          return closeThen(() => flushSync(() => void action.run()))
        case 'copy':
          // The row says "Copied", then the sheet closes.
          event.preventDefault()
          return copy(async () => {
            await action.run()
          })
        case 'delete':
          handedOff.current = true
          return setConfirming(true)
        case 'thread':
        case 'info':
          handedOff.current = true
          return void action.run()
        case 'pin':
          return void action.run()
      }
    }

  const item = (action: MessageAction): React.JSX.Element => {
    const isCopy = action.id === 'copy'
    const Icon = isCopy && copied !== null ? Check : action.icon
    const label = !isCopy
      ? action.label
      : copied !== null
        ? 'Copied'
        : copyFailed
          ? 'Copy failed'
          : action.label
    return (
      <MenuSheetItem
        key={action.id}
        variant={action.tone === 'danger' ? 'destructive' : 'default'}
        hint={action.hint ?? undefined}
        onSelect={select(action)}
      >
        <Icon className={ICON_TINT[action.id]} aria-hidden />
        {label}
      </MenuSheetItem>
    )
  }

  return (
    <>
      <MenuSheet open={open} onOpenChange={onOpenChange}>
        {/* Before the sheet's own portals, so the lift sits right before its scrim (see LiftLayer). */}
        <DialogPrimitive.Portal>
          <LiftLayer row={row} open={open} anchor={anchor} />
        </DialogPrimitive.Portal>
        <MenuSheetContent
          title="Message actions"
          onOpenAutoFocus={(e) => {
            // A dialog or the picker that a row of this sheet opens outlives it: its focus goes
            // back to the row's VoiceOver button (lib/focus-opener).
            if (e.currentTarget instanceof Element)
              setSheetOpener(e.currentTarget, actionsButtonOf(row))
          }}
          onCloseAutoFocus={(e) => {
            if (handedOff.current) {
              e.preventDefault()
              return
            }
            // The press opened the sheet, so no control did: the row's VoiceOver button takes it.
            focusRow(e)
          }}
        >
          <div ref={anchor} className="contents">
            <span role="status" className="sr-only">
              {copied !== null ? 'Copied' : ''}
            </span>
            {reactAction && (
              <QuickReactions
                channelId={message.channelId}
                target={message.clientMsgId}
                onReact={(key, mine) => {
                  react(message.channelId, message.clientMsgId, key, mine)
                  onOpenChange(false)
                }}
                onMore={() => {
                  handedOff.current = true
                  onOpenChange(false)
                  setPicking(true)
                }}
              />
            )}
            {GROUPS.map((ids, i) => (
              <Fragment key={ids[0]}>
                {i > 0 && <MenuSheetSeparator />}
                {ids.map((id) => {
                  const action = actions.find((a) => a.id === id)
                  return action ? item(action) : null
                })}
              </Fragment>
            ))}
          </div>
        </MenuSheetContent>
      </MenuSheet>
      {reactAction && (
        <EmojiPicker
          open={picking}
          onOpenChange={setPicking}
          guildId={guildId}
          label="Pick a reaction"
          autoFocusSearch={false}
          onPick={(pick) => reactAction.run(reactionKeyOf(pick))}
        >
          {null}
        </EmojiPicker>
      )}
      {deleteAction && (
        <ConfirmDialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title="Delete message"
          icon={<deleteAction.icon />}
          tone="danger"
          confirmLabel="Delete"
          what="delete the message"
          body={<DeleteText message={message} guildId={guildId} />}
          onCloseAutoFocus={focusRow}
          onConfirm={async () => {
            afterDelete.current = neighbourOf(row)
            await deleteAction.run()
          }}
        />
      )}
    </>
  )
}

/** The delete question: the message in bold, and whose it is when it is not mine. */
function DeleteText({
  message,
  guildId
}: {
  message: ChatMessage
  guildId: string | null
}): React.JSX.Element {
  const { name } = useMemberView(guildId, message.author.id, message.author)
  const mine = useUserStore((s) => s.me?.id === message.author.id)
  const quote = message.decrypt.status === 'ok' ? quoteText(message) : 'Encrypted message'
  const clipped = quote.length > QUOTE_MAX ? `${quote.slice(0, QUOTE_MAX - 1)}…` : quote
  return (
    <p className="text-text-secondary">
      Delete {mine ? '' : `${name}'s message `}
      <strong className="text-text-primary font-bold">“{clipped}”</strong>?{' '}
      {message.failed
        ? 'It was not sent.'
        : "It goes for everyone in the conversation. This can't be undone."}
    </p>
  )
}

/**
 * The lift (M5): the `--surface-scrim-lift` scrim and an inert clone of the held row, which moves
 * from the row to 12 px above the sheet. A row too tall for the room is cut and fades out.
 *
 * It renders in its own portal just before the sheet's scrim, so the sheet's 72 % scrim
 * (`[data-slot=sheet-overlay]`, the next sibling in `<body>`) turns transparent and this one
 * shows. The sheet's scrim stays on top and keeps its job: a tap on it (or on the lifted row
 * under it) closes the sheet. `ref` comes from the portal's Presence, which plays the fade-out.
 */
function LiftLayer({
  row,
  open,
  anchor,
  ref
}: {
  row: HTMLElement
  open: boolean
  anchor: React.RefObject<HTMLDivElement | null>
  ref?: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  const frame = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const host = frame.current
    const root = host?.parentElement
    if (!host || !root) return
    const rect = row.getBoundingClientRect()
    const clone = row.cloneNode(true) as HTMLElement
    clone.removeAttribute('data-message-id')
    clone.querySelector(ACTIONS_BUTTON)?.remove()
    // A played video or voice message is an autoplay element: its copy would play a second time.
    for (const media of clone.querySelectorAll<HTMLMediaElement>('video, audio')) {
      media.autoplay = false
      media.removeAttribute('autoplay')
      media.pause()
      media.removeAttribute('src')
      for (const source of media.querySelectorAll('source')) source.remove()
      media.load()
    }
    // The ids belong to the live row (Radix triggers, aria-controls targets).
    for (const el of clone.querySelectorAll('[id]')) el.removeAttribute('id')
    clone.style.margin = '0'
    clone.style.padding = '8px 12px'
    host.replaceChildren(clone)
    host.style.top = `${rect.top}px`
    host.style.left = `${rect.left}px`
    host.style.width = `${rect.width}px`
    // The sheet is in the page now, but its children's refs attach after this effect.
    const raf = requestAnimationFrame(() => {
      const sheet = anchor.current?.closest<HTMLElement>('[data-sheet]')
      if (!sheet) return
      // offsetTop ignores the sheet's slide-in transform: it is where the sheet comes to rest.
      // Reading offsetHeight also lays the clone out at the row, so the move below animates.
      const place = liftPlacement({
        rowHeight: host.offsetHeight,
        sheetTop: sheet.offsetTop,
        minTop: parseFloat(getComputedStyle(root).paddingTop) || 0
      })
      host.dataset.clamped = String(place.clamped)
      host.style.maxHeight = `${place.height}px`
      host.style.transform = `translate3d(0, ${place.top - rect.top}px, 0)`
    })
    return () => cancelAnimationFrame(raf)
  }, [row, anchor])

  return (
    <div
      ref={ref}
      aria-hidden
      inert
      data-slot="message-lift"
      data-state={open ? 'open' : 'closed'}
      className={cn(
        'bg-surface-scrim-lift fixed inset-0 z-50 pt-[calc(var(--safe-top,0px)+8px)] duration-250',
        // Outside the chat card: the author's role colour needs the scope that the live row has.
        ROLE_INK_SCOPE,
        'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:[--tw-animation-fill-mode:forwards]',
        '[&+[data-slot=sheet-overlay]]:bg-transparent'
      )}
    >
      <div
        ref={frame}
        className={cn(
          'bg-surface-raised border-accent-primary/40 absolute overflow-hidden rounded-[9px] border',
          'shadow-[0_12px_32px_rgb(22_21_31/0.18)] dark:shadow-[0_12px_32px_#00000099]',
          'transition-transform duration-250 ease-[cubic-bezier(.32,.72,0,1)] will-change-transform',
          'data-[clamped=true]:[mask-image:linear-gradient(to_bottom,#000_calc(100%-40px),transparent)]'
        )}
      />
    </div>
  )
}
