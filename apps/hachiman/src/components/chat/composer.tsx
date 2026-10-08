import { useEffect, useRef, useState } from 'react'
import { CircleAlert, ImagePlus, Lock, Plus, Smile, X } from 'lucide-react'
import type { Channel } from '@hachiman/client'
import type { AttachmentPointer } from '@hachiman/crypto'
import { IconButton } from '@/components/ui/icon-button'
import { customEmojiText } from '@/lib/custom-emoji'
import { emojiDataNow, replaceShortcodes } from '@/lib/emoji-data'
import {
  applyCompletion,
  findTrigger,
  toWire,
  type RoleInsert,
  type Trigger
} from '@/lib/mention-complete'
import { cn } from '@/lib/utils'
import { usePrefsStore } from '@/stores/prefsStore'
import { UploadTray } from './attachments/upload-tray'
import type { Uploads } from './attachments/use-uploads'
import { insertFor, useMentionItems, type MentionItem } from './mention-items'
import { EmojiPicker, reactionKeyOf, type EmojiPick } from './emoji-picker'
import { MentionMenu } from './mention-menu'
import { submitOnEnter } from './submit-on-enter'

interface ComposerProps {
  /** The channel the message goes to: the source of the `@` and `#` suggestions. */
  channel: Channel
  placeholder: string
  /** A plain reason shown instead of the input when I can't send. */
  disabledReason?: string
  /** A button at the end of the `disabledReason` notice ("Follow", N9). */
  disabledAction?: React.ReactNode
  /**
   * Sending is paused (a verified contact's key changed, E5): a coral line above a disabled
   * composer that shows this text as its placeholder.
   */
  paused?: { notice: string; placeholder: string }
  /** This composer's pending attachments (owned by the chat body, which is also the drop target). */
  uploads: Uploads
  /** ATTACH_FILES: shows the attach buttons and accepts pasted files. */
  canAttach: boolean
  /** The message that the next send answers (N11): "Replying to <name>" with ✕ above the input. */
  reply?: { name: string; onCancel: () => void }
  onSend: (text: string, attachments: AttachmentPointer[]) => void
  onTyping: () => void
  /** Arrow Up in an empty input: edit my newest message. False when there is none. */
  onEditLast?: () => boolean
}

const TOOL = 'text-text-tertiary hover:bg-surface-hover hover:text-text-primary size-8'

/**
 * Rounded input bar on the raised surface: "+" on the left, the E2EE chip and the image button on
 * the right. Enter sends, Shift+Enter adds a newline, grows to about 8 lines. Pending attachments
 * sit in a tray above the text; sending waits until they all finished uploading. The smiley opens
 * the emoji picker. The sticker button of the mocks has no feature yet and is not rendered.
 *
 * `@`, `#` and `:` open suggestions (mention-menu.tsx): members, roles, @everyone, channels, pages
 * and emojis. A picked role shows as `@Name` and is sent as `<@&roleId>`, a picked custom emoji
 * shows as `:name:` and is sent as `<:name:id>` (lib/mention-complete `toWire`). A typed
 * `:shortcode:` of a Unicode emoji is sent as the emoji.
 */
export function Composer({
  channel,
  placeholder,
  disabledReason,
  disabledAction,
  paused,
  uploads,
  canAttach,
  reply,
  onSend,
  onTyping,
  onEditLast
}: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  const imagePicker = useRef<HTMLInputElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [active, setActive] = useState(0)
  /** Picked roles and custom emojis: their display forms become wire forms on send. */
  const pickedRoles = useRef<RoleInsert[]>([])
  const [emojiOpen, setEmojiOpen] = useState(false)
  const addRecentEmoji = usePrefsStore((s) => s.addRecentEmoji)
  const items = useMentionItems(channel, trigger)
  const menuOpen = items.length > 0
  const replying = reply !== undefined
  // Reply moves the focus here, so that the answer can be typed at once.
  useEffect(() => {
    if (replying) input.current?.focus()
  }, [replying])

  if (disabledReason) {
    return (
      <div
        role="note"
        className="bg-surface-panel border-line-hairline text-text-secondary flex min-h-[52px] items-center gap-3 border px-4 py-2.5 text-[14px] leading-5 font-medium"
      >
        <Lock className="text-text-tertiary size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">{disabledReason}</span>
        {disabledAction}
      </div>
    )
  }

  const send = (): void => {
    if (paused) return
    if (uploads.busy) return uploads.setNotices(['Wait for the uploads to finish, then send.'])
    if (uploads.failed) return uploads.setNotices(['Remove the failed uploads to send.'])
    if (!text.trim() && uploads.items.length === 0) return
    const wire = toWire(text, pickedRoles.current)
    const data = emojiDataNow()
    onSend(data ? replaceShortcodes(wire, data) : wire, uploads.take())
    setText('')
    setTrigger(null)
    pickedRoles.current = []
  }

  /** The trigger at the caret after a change or a caret move; a new trigger starts at the top. */
  const track = (value: string, caret: number | null): void => {
    const next = caret === null ? null : findTrigger(value, caret)
    setTrigger((prev) => {
      if (prev?.start !== next?.start || prev?.char !== next?.char) setActive(0)
      return next
    })
  }

  const pick = (item: MentionItem): void => {
    if (!trigger) return
    const { insert, role } = insertFor(item)
    const done = applyCompletion(text, trigger, insert)
    if (role) pickedRoles.current = [...pickedRoles.current, role]
    if (item.kind === 'emoji') addRecentEmoji(item.id)
    else if (item.kind === 'custom-emoji')
      addRecentEmoji(reactionKeyOf({ kind: 'custom', emoji: item.emoji }))
    setText(done.text)
    setTrigger(null)
    requestAnimationFrame(() => input.current?.setSelectionRange(done.caret, done.caret))
  }

  /** Puts a picked emoji at the caret (or over the selection), with a space after it. */
  const insertEmoji = (pick: EmojiPick): void => {
    const el = input.current
    const from = el?.selectionStart ?? text.length
    const to = el?.selectionEnd ?? from
    let insert: string = pick.kind === 'unicode' ? pick.emoji : `:${pick.emoji.name}:`
    if (pick.kind === 'custom') {
      pickedRoles.current = [...pickedRoles.current, { display: insert, wire: customEmojiText(pick.emoji) }]
    }
    const before = text.slice(0, from)
    const pad = before && !/\s$/.test(before) ? ' ' : ''
    insert = `${pad}${insert} `
    const caret = from + insert.length
    setText(`${before}${insert}${text.slice(to)}`)
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.setSelectionRange(caret, caret)
    })
  }

  /** The menu's keys: arrows move, Enter or Tab picks, Escape closes. True when handled. */
  const menuKey = (e: React.KeyboardEvent): boolean => {
    if (!menuOpen || e.nativeEvent.isComposing) return false
    const item = items[active]
    if (e.key === 'ArrowDown') setActive((active + 1) % items.length)
    else if (e.key === 'ArrowUp') setActive((active - 1 + items.length) % items.length)
    else if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && item) pick(item)
    else if (e.key === 'Escape') setTrigger(null)
    else return false
    e.preventDefault()
    return true
  }

  const filePicker = (
    ref: React.RefObject<HTMLInputElement | null>,
    accept?: string
  ): React.JSX.Element => (
    <input
      ref={ref}
      type="file"
      accept={accept}
      multiple
      hidden
      tabIndex={-1}
      onChange={(e) => {
        uploads.add([...(e.target.files ?? [])])
        e.target.value = '' // picking the same file again must fire change
      }}
    />
  )
  const attach = canAttach && !paused

  return (
    <>
      {paused && (
        <p
          role="alert"
          className="border-feature-danger/40 bg-feature-danger/10 text-feature-danger-text mb-2 flex items-center gap-2 border px-3 py-2 text-[13px] leading-5 font-semibold"
        >
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          {paused.notice}
        </p>
      )}
      <div
        className={cn(
          'rounded-option bg-surface-raised relative border border-transparent transition-colors',
          'focus-within:border-line-focus',
          paused && 'opacity-60'
        )}
      >
        {reply && (
          <div className="border-line-hairline text-text-secondary flex h-9 items-center gap-2 border-b pr-1.5 pl-4 text-[13px]">
            <span className="min-w-0 flex-1 truncate">
              Replying to <span className="text-text-primary font-semibold">{reply.name}</span>
            </span>
            <IconButton
              label="Cancel reply"
              size="sm"
              className="text-text-tertiary hover:bg-surface-hover hover:text-text-primary rounded-full"
              onClick={reply.onCancel}
            >
              <X />
            </IconButton>
          </div>
        )}
        {menuOpen && (
          <MentionMenu items={items} active={active} onPick={pick} onHover={setActive} />
        )}
        <UploadTray items={uploads.items} onRemove={uploads.remove} />
        <div className="flex min-h-[52px] items-end gap-1 px-2.5 py-2.5">
          {attach && (
            <>
              <IconButton
                label="Attach files"
                className="bg-surface-hover text-text-secondary hover:text-text-primary size-8 rounded-full"
                onClick={() => picker.current?.click()}
              >
                <Plus />
              </IconButton>
              {filePicker(picker)}
            </>
          )}
          <textarea
            ref={input}
            aria-label={paused ? paused.placeholder : placeholder}
            placeholder={paused ? paused.placeholder : placeholder}
            disabled={!!paused}
            value={text}
            rows={1}
            role="combobox"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? 'mention-menu' : undefined}
            aria-activedescendant={menuOpen ? `mention-${active}` : undefined}
            aria-autocomplete="list"
            onChange={(e) => {
              setText(e.target.value)
              track(e.target.value, e.target.selectionStart)
              if (e.target.value) onTyping()
            }}
            onSelect={(e) => track(e.currentTarget.value, e.currentTarget.selectionStart)}
            onBlur={() => setTrigger(null)}
            onKeyDown={(e) => {
              if (menuKey(e)) return
              if (e.key === 'Escape' && reply) {
                e.preventDefault()
                reply.onCancel()
              } else if (
                e.key === 'ArrowUp' &&
                !text &&
                !e.shiftKey &&
                !e.altKey &&
                !e.ctrlKey &&
                !e.metaKey &&
                onEditLast?.()
              ) {
                e.preventDefault()
              } else submitOnEnter(e, send)
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files]
              if (!attach || files.length === 0) return
              e.preventDefault()
              uploads.add(files)
            }}
            className={cn(
              'field-sizing-content block max-h-[196px] min-h-8 w-full flex-1 resize-none bg-transparent px-1.5 py-[5px]',
              'placeholder:text-text-tertiary text-body text-text-primary outline-none disabled:cursor-not-allowed'
            )}
          />
          <span
            className="rounded-check bg-feature-voice/15 text-feature-voice-text mb-[5px] inline-flex h-[22px] shrink-0 items-center gap-1 px-1.5 text-[11px] leading-none font-extrabold tracking-[0.4px]"
            title="Messages and files here are end-to-end encrypted."
          >
            <Lock className="size-3" aria-hidden />
            E2EE
          </span>
          {!paused && (
            <EmojiPicker
              open={emojiOpen}
              onOpenChange={setEmojiOpen}
              guildId={channel.guildId}
              onPick={insertEmoji}
            >
              <IconButton
                label="Emoji"
                className={TOOL}
                pressed={emojiOpen}
                onClick={() => setEmojiOpen((v) => !v)}
              >
                <Smile className="size-[18px]" />
              </IconButton>
            </EmojiPicker>
          )}
          {attach && (
            <>
              <IconButton
                label="Attach images or video"
                className={TOOL}
                onClick={() => imagePicker.current?.click()}
              >
                <ImagePlus className="size-[18px]" />
              </IconButton>
              {filePicker(imagePicker, 'image/*,video/*')}
            </>
          )}
        </div>
      </div>
      {uploads.notices.length > 0 && (
        <div role="alert" className="text-feature-danger-text pt-1 text-xs leading-4">
          {uploads.notices.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </div>
      )}
    </>
  )
}
