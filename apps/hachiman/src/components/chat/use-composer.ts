import { useEffect, useRef, useState } from 'react'
import type { Channel } from '@hachiman/client'
import type { AttachmentPointer } from '@hachiman/crypto'
import { emojiInsert, reactionKeyOf, type EmojiPick } from '@/lib/custom-emoji'
import { emojiDataNow, replaceShortcodes } from '@/lib/emoji-data'
import {
  applyCompletion,
  findTrigger,
  toWire,
  type Trigger,
  type WireInsert
} from '@/lib/mention-complete'
import { usePrefsStore } from '@/stores/prefsStore'
import type { Uploads } from './attachments/use-uploads'
import { insertFor, useMentionItems, type MentionItem } from './mention-items'
import { submitOnEnter } from './submit-on-enter'

export interface ComposerProps {
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

/** The props that both composers put on their textarea. */
export interface ComposerFieldProps {
  value: string
  disabled: boolean
  rows: number
  role: 'combobox'
  'aria-expanded': boolean
  'aria-controls': string | undefined
  'aria-activedescendant': string | undefined
  'aria-autocomplete': 'list'
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void
  onFocus: () => void
  onBlur: () => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
}

export interface ComposerState {
  text: string
  /** The `@`, `#` or `:` at the caret, or null. */
  trigger: Trigger | null
  items: MentionItem[]
  menuOpen: boolean
  /** The highlighted suggestion. */
  active: number
  setActive: (index: number) => void
  emojiOpen: boolean
  setEmojiOpen: (open: boolean | ((open: boolean) => boolean)) => void
  /** The attach controls work: ATTACH_FILES and not paused. */
  attach: boolean
  /** There is text or an upload to send. */
  hasContent: boolean
  send: () => void
  pick: (item: MentionItem) => void
  insertEmoji: (pick: EmojiPick) => void
  /** The `change` of a file input: adds its files and clears it, so the same file can come again. */
  onFilesPicked: (e: React.ChangeEvent<HTMLInputElement>) => void
  field: ComposerFieldProps
}

/**
 * The layout of a composer. desktop: Enter sends, a reply focuses the field, an emoji pick puts
 * the focus back. mobile (docs/ios-mobile-ui-spec.md A6): Return adds a newline, and the blur of
 * the field closes the suggestions only after `MENU_BLUR_MS`, so that a tap on one lands first.
 * Focus on mobile comes only from a tap (`focusComposer`), because WKWebView raises the keyboard
 * only for a focus inside a user gesture.
 */
export type ComposerLayout = 'desktop' | 'mobile'

/** Mobile: the delay between the blur of the field and the close of the suggestions. */
export const MENU_BLUR_MS = 150

/**
 * The state and handlers of the message composer, shared by the desktop `Composer` and the
 * `MobileComposer`. `input` is the caller's ref on its textarea. Picked roles and custom emojis
 * show as `@Name` and `:name:` and are sent as their wire forms (lib/mention-complete `toWire`);
 * a typed `:shortcode:` is sent as the emoji.
 */
export function useComposer(
  { channel, paused, uploads, canAttach, reply, onSend, onTyping, onEditLast }: ComposerProps,
  layout: ComposerLayout,
  input: React.RefObject<HTMLTextAreaElement | null>
): ComposerState {
  const mobile = layout === 'mobile'
  const [text, setText] = useState('')
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [active, setActive] = useState(0)
  /** Picked roles and custom emojis: their display forms become wire forms on send. */
  const pickedInserts = useRef<WireInsert[]>([])
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const addRecentEmoji = usePrefsStore((s) => s.addRecentEmoji)
  const items = useMentionItems(channel, trigger)
  const menuOpen = items.length > 0
  const replying = reply !== undefined
  // Reply moves the focus here, so that the answer can be typed at once. On mobile the Reply tap
  // focuses the field itself (focusComposer): a focus from an effect raises no keyboard.
  useEffect(() => {
    if (replying && !mobile) input.current?.focus()
  }, [replying, mobile, input])
  useEffect(() => () => clearTimeout(blurTimer.current), [])

  const send = (): void => {
    if (paused) return
    if (uploads.busy) return uploads.setNotices(['Wait for the uploads to finish, then send.'])
    if (uploads.failed) return uploads.setNotices(['Remove the failed uploads to send.'])
    if (!text.trim() && uploads.items.length === 0) return
    const wire = toWire(text, pickedInserts.current)
    const data = emojiDataNow()
    onSend(data ? replaceShortcodes(wire, data) : wire, uploads.take())
    setText('')
    setTrigger(null)
    pickedInserts.current = []
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
    const { insert, wire } = insertFor(item)
    const done = applyCompletion(text, trigger, insert)
    if (wire) pickedInserts.current = [...pickedInserts.current, { display: insert, wire }]
    if (item.kind === 'emoji' || item.kind === 'custom-emoji')
      addRecentEmoji(reactionKeyOf(item.pick))
    setText(done.text)
    setTrigger(null)
    // A tap may have taken the focus: get it back inside the gesture, so the keyboard stays up.
    input.current?.focus()
    requestAnimationFrame(() => input.current?.setSelectionRange(done.caret, done.caret))
  }

  /** Puts a picked emoji at the caret (or over the selection), with a space after it. */
  const insertEmoji = (pick: EmojiPick): void => {
    const el = input.current
    const from = el?.selectionStart ?? text.length
    const to = el?.selectionEnd ?? from
    const { insert: display, wire } = emojiInsert(pick)
    if (wire) pickedInserts.current = [...pickedInserts.current, { display, wire }]
    const before = text.slice(0, from)
    const pad = before && !/\s$/.test(before) ? ' ' : ''
    const insert = `${pad}${display} `
    const caret = from + insert.length
    setText(`${before}${insert}${text.slice(to)}`)
    // On mobile the emoji sheet gives the focus back to its button: a focus outside the tap would
    // raise no keyboard. The next tap on the field puts the caret where the user wants it.
    if (mobile) return
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.setSelectionRange(caret, caret)
    })
  }

  /** The menu's keys: arrows move, Enter (desktop) or Tab picks, Escape closes. True when handled. */
  const menuKey = (e: React.KeyboardEvent): boolean => {
    if (!menuOpen || e.nativeEvent.isComposing) return false
    const item = items[active]
    const pickKey = e.key === 'Tab' || (e.key === 'Enter' && !mobile)
    if (e.key === 'ArrowDown') setActive((active + 1) % items.length)
    else if (e.key === 'ArrowUp') setActive((active - 1 + items.length) % items.length)
    else if (pickKey && !e.shiftKey && item) pick(item)
    else if (e.key === 'Escape') setTrigger(null)
    else return false
    e.preventDefault()
    return true
  }

  const attach = canAttach && !paused

  return {
    text,
    trigger,
    items,
    menuOpen,
    active,
    setActive,
    emojiOpen,
    setEmojiOpen,
    attach,
    hasContent: hasContent(text, uploads.items.length),
    send,
    pick,
    insertEmoji,
    onFilesPicked: (e) => {
      uploads.add([...(e.target.files ?? [])])
      e.target.value = '' // picking the same file again must fire change
    },
    field: {
      value: text,
      disabled: !!paused,
      rows: 1,
      role: 'combobox',
      'aria-expanded': menuOpen,
      'aria-controls': menuOpen ? 'mention-menu' : undefined,
      'aria-activedescendant': menuOpen ? `mention-${active}` : undefined,
      'aria-autocomplete': 'list',
      onChange: (e) => {
        setText(e.target.value)
        track(e.target.value, e.target.selectionStart)
        if (e.target.value) onTyping()
      },
      onSelect: (e) => track(e.currentTarget.value, e.currentTarget.selectionStart),
      onFocus: () => clearTimeout(blurTimer.current),
      onBlur: () => {
        if (!mobile) return setTrigger(null)
        clearTimeout(blurTimer.current)
        blurTimer.current = setTimeout(() => setTrigger(null), MENU_BLUR_MS)
      },
      onKeyDown: (e) => {
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
          !e.metaKey
        ) {
          if (onEditLast?.()) e.preventDefault()
        } else if (!mobile) submitOnEnter(e, send)
      },
      onPaste: (e) => {
        const files = [...e.clipboardData.files]
        if (!attach || files.length === 0) return
        e.preventDefault()
        uploads.add(files)
      }
    }
  }
}

/** Something to send: text that is not only white space, or an upload. */
export function hasContent(text: string, uploadCount: number): boolean {
  return text.trim() !== '' || uploadCount > 0
}
