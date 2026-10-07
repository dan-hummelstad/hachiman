import { useRef, useState } from 'react'
import { CircleAlert, ImagePlus, Lock, Plus } from 'lucide-react'
import type { AttachmentPointer } from '@hachiman/crypto'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import { UploadTray } from './attachments/upload-tray'
import type { Uploads } from './attachments/use-uploads'
import { submitOnEnter } from './submit-on-enter'

interface ComposerProps {
  placeholder: string
  /** A plain reason shown instead of the input when I can't send. */
  disabledReason?: string
  /**
   * Sending is paused (a verified contact's key changed, E5): a coral line above a disabled
   * composer that shows this text as its placeholder.
   */
  paused?: { notice: string; placeholder: string }
  /** This composer's pending attachments (owned by the chat body, which is also the drop target). */
  uploads: Uploads
  /** ATTACH_FILES: shows the attach buttons and accepts pasted files. */
  canAttach: boolean
  onSend: (text: string, attachments: AttachmentPointer[]) => void
  onTyping: () => void
}

const TOOL = 'text-text-tertiary hover:bg-surface-hover hover:text-text-primary size-8'

/**
 * Rounded input bar on the raised surface: "+" on the left, the E2EE chip and the image button on
 * the right. Enter sends, Shift+Enter adds a newline, grows to about 8 lines. Pending attachments
 * sit in a tray above the text; sending waits until they all finished uploading. The emoji and
 * sticker buttons of the mocks have no feature yet and are not rendered.
 */
export function Composer({
  placeholder,
  disabledReason,
  paused,
  uploads,
  canAttach,
  onSend,
  onTyping
}: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  const imagePicker = useRef<HTMLInputElement>(null)

  if (disabledReason) {
    return (
      <div
        role="note"
        className="bg-surface-panel border-line-hairline text-text-secondary flex min-h-[52px] items-center gap-3 border px-4 py-2.5 text-[14px] leading-5 font-medium"
      >
        <Lock className="text-text-tertiary size-4 shrink-0" aria-hidden />
        {disabledReason}
      </div>
    )
  }

  const send = (): void => {
    if (paused) return
    if (uploads.busy) return uploads.setNotices(['Wait for the uploads to finish, then send.'])
    if (uploads.failed) return uploads.setNotices(['Remove the failed uploads to send.'])
    if (!text.trim() && uploads.items.length === 0) return
    onSend(text, uploads.take())
    setText('')
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
          'rounded-option bg-surface-raised border border-transparent transition-colors',
          'focus-within:border-line-focus',
          paused && 'opacity-60'
        )}
      >
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
            aria-label={paused ? paused.placeholder : placeholder}
            placeholder={paused ? paused.placeholder : placeholder}
            disabled={!!paused}
            value={text}
            rows={1}
            onChange={(e) => {
              setText(e.target.value)
              if (e.target.value) onTyping()
            }}
            onKeyDown={(e) => submitOnEnter(e, send)}
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
