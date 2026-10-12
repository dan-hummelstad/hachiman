import { useRef } from 'react'
import { CircleAlert, ImagePlus, Lock, Plus, Smile, X } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import { UploadTray } from './attachments/upload-tray'
import { EmojiPicker } from './emoji-picker'
import { MentionMenu } from './mention-menu'
import { useComposer, type ComposerProps } from './use-composer'

const TOOL = 'text-text-tertiary hover:bg-surface-hover hover:text-text-primary size-8'

/**
 * Rounded input bar on the raised surface: "+" on the left, the E2EE chip and the image button on
 * the right. Enter sends, Shift+Enter adds a newline, grows to about 8 lines. Pending attachments
 * sit in a tray above the text; sending waits until they all finished uploading. The smiley opens
 * the emoji picker. The sticker button of the mocks has no feature yet and is not rendered.
 *
 * `@`, `#` and `:` open suggestions (mention-menu.tsx): members, roles, @everyone, channels, pages
 * and emojis. The state and the handlers live in `useComposer` (use-composer.ts), which the
 * mobile composer (components/mobile/mobile-composer.tsx) shares.
 */
export function Composer(props: ComposerProps): React.JSX.Element {
  const { channel, placeholder, disabledReason, disabledAction, paused, uploads, reply } = props
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const imagePicker = useRef<HTMLInputElement>(null)
  const {
    field,
    items,
    menuOpen,
    active,
    setActive,
    pick,
    attach,
    emojiOpen,
    setEmojiOpen,
    insertEmoji,
    onFilesPicked
  } = useComposer(props, 'desktop', input)

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
      onChange={onFilesPicked}
    />
  )

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
            {...field}
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
