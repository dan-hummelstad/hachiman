import { useEffect, useLayoutEffect, useRef } from 'react'
import { ArrowUp, Lock, Plus, Smile, X } from 'lucide-react'
import { UploadTray } from '@/components/chat/attachments/upload-tray'
import { EmojiPicker } from '@/components/chat/emoji-picker'
import { MobileMentionMenu } from '@/components/chat/mention-menu'
import { dragClosesKeyboard, mentionScope } from '@/components/chat/mobile-mention-model'
import { useComposer, type ComposerProps } from '@/components/chat/use-composer'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import { useGuildStore } from '@/stores/guildStore'

/** About five lines of the 16 px text (22 each) plus the 11 px padding above and below. */
const FIELD_MAX_HEIGHT = 132

/** The 40 squares beside the field: Attach and Send. */
const SQUARE =
  'rounded-option mb-0.5 inline-flex size-10 shrink-0 items-center justify-center outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-line-focus disabled:opacity-40'

/** Keeps the focus (and the keyboard) in the field while a button takes the tap. */
const keepFocus = (e: React.PointerEvent | React.MouseEvent): void => e.preventDefault()

/**
 * Mobile / Composer (kit De0OR, M6), the mobile form of `Composer` over the same `useComposer`:
 * Attach (40) outside the field, a field (44) with a 16 px textarea that grows to about five
 * lines, the E2EE chip and the emoji button (the emoji sheet), then Send (accent, arrow up) while
 * there is text or an upload. With nothing to send the slot is empty: voice messages (Record) do
 * not exist yet (docs/ios-mobile-ui-spec.md §5). Return adds a newline.
 *
 * The one file input has no `accept`, so iOS offers Photo Library, Take Photo and Choose Files.
 * Send and the suggestion rows keep the focus in the field, so the keyboard stays up. A drag down
 * on the transcript closes the keyboard. `focusComposer` (mobile-chat-footer.tsx) finds the
 * textarea in the chat footer.
 *
 * Paused (a verified contact's key changed, M58): the field is disabled and says so, the chip
 * turns red ("PAUSED"), and Attach and Emoji dim. A read-only channel (M62) shows a notice with
 * its action instead.
 */
export function MobileComposer(props: ComposerProps): React.JSX.Element {
  const { channel, placeholder, disabledReason, disabledAction, paused, uploads, reply } = props
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const c = useComposer(props, 'mobile', input)
  const { text } = c
  const guildId = channel.guildId
  const guildName = useGuildStore((s) => (guildId ? (s.guilds.get(guildId)?.name ?? null) : null))

  // Grow with the text up to the max height, then scroll. `field-sizing` is not in iOS 18.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, FIELD_MAX_HEIGHT)}px`
  }, [input, text])

  useEffect(() => dismissKeyboardOnDrag(input), [input])

  if (disabledReason) return <ReadOnlyNotice reason={disabledReason} action={disabledAction} />

  const fieldLabel = paused ? paused.placeholder : placeholder
  const canSend = c.hasContent && !paused

  return (
    <div className="relative flex flex-col">
      {paused && (
        <p role="alert" className="sr-only">
          {paused.notice}
        </p>
      )}
      {c.menuOpen && c.trigger && (
        <MobileMentionMenu
          items={c.items}
          active={c.active}
          scope={mentionScope(c.trigger.char, guildName)}
          char={c.trigger.char}
          guildId={guildId}
          onPick={c.pick}
          onHover={c.setActive}
        />
      )}
      {reply && (
        <div className="border-line-hairline text-text-secondary flex h-9 items-center gap-2 border-t pr-2 pl-4 text-[13.5px]">
          <span className="min-w-0 flex-1 truncate">
            Replying to <span className="text-text-primary font-bold">{reply.name}</span>
          </span>
          <IconButton
            label="Cancel reply"
            size="touch"
            className="text-text-tertiary rounded-control"
            onClick={reply.onCancel}
          >
            <X />
          </IconButton>
        </div>
      )}
      <UploadTray items={uploads.items} onRemove={uploads.remove} />
      <div className="flex items-end gap-2 px-3 py-2">
        {/* Attach shows when I may attach; while sending is paused it dims (M58). */}
        {props.canAttach && (
          <>
            <button
              type="button"
              aria-label="Attach files"
              disabled={!c.attach}
              className={cn(SQUARE, 'bg-fill-control-strong text-text-primary')}
              onClick={() => picker.current?.click()}
            >
              <Plus className="size-5" aria-hidden />
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              tabIndex={-1}
              onChange={c.onFilesPicked}
            />
          </>
        )}
        <div
          data-swipe-ignore
          className="rounded-option bg-surface-raised flex min-h-11 min-w-0 flex-1 items-end gap-2 pr-0.5 pl-3.5"
        >
          <textarea
            ref={input}
            aria-label={fieldLabel}
            placeholder={paused ? 'Sending is paused' : placeholder}
            autoCapitalize="sentences"
            autoCorrect="on"
            enterKeyHint="enter"
            {...c.field}
            className={cn(
              'block min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-[11px] outline-none',
              'text-text-primary caret-accent-primary text-[16px] leading-[22px] font-medium',
              'placeholder:text-text-tertiary placeholder:truncate disabled:cursor-not-allowed'
            )}
          />
          <span
            className={cn(
              'mb-[11px] inline-flex h-[22px] shrink-0 items-center gap-1 px-[7px] text-[11px] leading-none font-extrabold tracking-[0.4px]',
              paused
                ? 'bg-feature-danger/10 text-feature-danger-text'
                : 'bg-feature-voice/10 text-feature-voice-text'
            )}
            title="Messages and files here are end-to-end encrypted."
          >
            <Lock
              className={cn('size-3', paused ? 'text-feature-danger' : undefined)}
              aria-hidden
            />
            {paused ? 'PAUSED' : 'E2EE'}
          </span>
          <EmojiPicker
            open={c.emojiOpen}
            onOpenChange={c.setEmojiOpen}
            guildId={guildId}
            onPick={c.insertEmoji}
            autoFocusSearch={false}
          >
            <IconButton
              label="Emoji"
              size="touch"
              disabled={!!paused}
              pressed={c.emojiOpen}
              className="text-text-secondary rounded-control mb-1 -ml-1.5 disabled:opacity-40"
              onClick={() => c.setEmojiOpen((v) => !v)}
            >
              <Smile className="size-[21px]" />
            </IconButton>
          </EmojiPicker>
        </div>
        {canSend && (
          <button
            type="button"
            aria-label="Send"
            className={cn(SQUARE, 'bg-accent-primary text-text-on-accent active:opacity-85')}
            onPointerDown={keepFocus}
            onMouseDown={keepFocus}
            onClick={c.send}
          >
            <ArrowUp className="size-[19px]" strokeWidth={2.4} aria-hidden />
          </button>
        )}
      </div>
      {uploads.notices.length > 0 && (
        <div role="alert" className="text-feature-danger-text px-4 pb-1.5 text-xs leading-4">
          {uploads.notices.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </div>
      )}
    </div>
  )
}

/** M62: why I can't post here, with the channel's action (Follow) at the end. */
function ReadOnlyNotice({
  reason,
  action
}: {
  reason: string
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="px-3 py-2">
      <div
        role="note"
        className="bg-surface-hover/50 border-fill-control flex min-h-[60px] items-center gap-2.5 border py-2 pr-2 pl-3.5"
      >
        <Lock className="text-text-tertiary size-[17px] shrink-0" aria-hidden />
        <span className="text-text-secondary min-w-0 flex-1 text-[14px] leading-[1.35] font-medium">
          {reason}
        </span>
        {action}
      </div>
    </div>
  )
}

/**
 * While the field has the focus, a drag down that starts on the transcript (`data-slot=chat-scroll`)
 * blurs it, so the keyboard goes down (M6 check). Returns the cleanup.
 */
function dismissKeyboardOnDrag(input: React.RefObject<HTMLTextAreaElement | null>): () => void {
  let startY: number | null = null
  const onStart = (e: TouchEvent): void => {
    const touch = e.touches.length === 1 ? e.touches[0] : undefined
    const onTranscript =
      e.target instanceof Element && e.target.closest('[data-slot="chat-scroll"]') !== null
    const focused = input.current !== null && document.activeElement === input.current
    startY = touch && onTranscript && focused ? touch.clientY : null
  }
  const onMove = (e: TouchEvent): void => {
    const y = e.touches[0]?.clientY
    if (startY === null || y === undefined || !dragClosesKeyboard(startY, y)) return
    startY = null
    input.current?.blur()
  }
  const onEnd = (): void => {
    startY = null
  }
  const opts: AddEventListenerOptions = { capture: true, passive: true }
  document.addEventListener('touchstart', onStart, opts)
  document.addEventListener('touchmove', onMove, opts)
  document.addEventListener('touchend', onEnd, opts)
  document.addEventListener('touchcancel', onEnd, opts)
  return () => {
    document.removeEventListener('touchstart', onStart, opts)
    document.removeEventListener('touchmove', onMove, opts)
    document.removeEventListener('touchend', onEnd, opts)
    document.removeEventListener('touchcancel', onEnd, opts)
  }
}
