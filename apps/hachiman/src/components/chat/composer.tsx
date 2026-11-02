import { useRef } from 'react'
import { CircleAlert, ImagePlus, Lock, Plus, Smile, X } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import { UploadTray } from './attachments/upload-tray'
import { EmojiPicker } from './emoji-picker'
import { MentionMenu } from './mention-menu'
import { useComposer, type ComposerProps } from './use-composer'

const TOOL =
  'text-text-tertiary hover:bg-surface-hover hover:text-text-primary rounded-control mb-[3px] size-8'

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
        className="bg-surface-sunken border-line-hairline rounded-option text-text-secondary flex min-h-[52px] items-center gap-3 border px-4 py-2.5 text-[14px] leading-5 font-medium"
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
          className="border-you/40 bg-you-tint text-you-text rounded-control mb-2 flex items-center gap-2 border px-3 py-2 text-[13px] leading-5 font-semibold"
        >
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          {paused.notice}
        </p>
      )}
      <div
        className={cn(
          'rounded-option bg-surface-raised border-line-hairline relative border transition-colors',
          'focus-within:border-line-strong',
          paused && 'opacity-60'
        )}
      >
        {reply && (
          <div className="border-line-hairline text-text-tertiary flex h-9 items-center gap-2 border-b pr-1.5 pl-4 text-[12.5px]">
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
        <div className="flex min-h-[50px] items-end gap-[5px] px-3 py-[7px]">
          {attach && (
            <>
              <IconButton
                label="Attach files"
                className="text-text-tertiary hover:bg-surface-hover hover:text-text-primary rounded-control mb-[3px] size-8"
                onClick={() => picker.current?.click()}
              >
                <Plus className="size-[17px]" />
              </IconButton>
              <span aria-hidden className="bg-line-hairline mb-[9px] h-5 w-px shrink-0" />
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
              'placeholder:text-text-tertiary text-[14px] leading-5 text-text-primary outline-none disabled:cursor-not-allowed'
            )}
          />
          <span
            className="rounded-pill bg-surface-hover text-text-disabled mb-[7px] inline-flex h-[18px] shrink-0 items-center gap-1 px-1.5 font-mono text-[8px] leading-none tracking-[0.8px]"
            title="Messages and files here are end-to-end encrypted."
          >
            <Lock className="size-2.5" aria-hidden />
            E2EE
          </span>
          {attach && (
            <>
              <IconButton
                label="Attach images or video"
                className={TOOL}
                onClick={() => imagePicker.current?.click()}
              >
                <ImagePlus className="size-4" />
              </IconButton>
              {filePicker(imagePicker, 'image/*,video/*')}
            </>
          )}
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
                <Smile className="size-4" />
              </IconButton>
            </EmojiPicker>
          )}
        </div>
      </div>
      {uploads.notices.length > 0 && (
        <div role="alert" className="text-you-text pt-1 text-xs leading-4">
          {uploads.notices.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </div>
      )}
    </>
  )
}
