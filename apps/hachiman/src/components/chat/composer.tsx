import { useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { Attachment } from '@hachiman/client'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import { UploadTray } from './attachments/upload-tray'
import type { Uploads } from './attachments/use-uploads'
import { submitOnEnter } from './submit-on-enter'

interface ComposerProps {
  placeholder: string
  /** A plain reason shown instead of the input when I can't send. */
  disabledReason?: string
  /** This composer's pending attachments (owned by the chat body, which is also the drop target). */
  uploads: Uploads
  /** ATTACH_FILES: shows the attach button and accepts pasted files. */
  canAttach: boolean
  onSend: (text: string, attachments: Attachment[]) => void
  onTyping: () => void
}

/**
 * Square input bar. Enter sends, Shift+Enter adds a newline, grows to about 8 lines. Pending
 * attachments sit in a tray above the text; sending waits until they all finished uploading.
 */
export function Composer({
  placeholder,
  disabledReason,
  uploads,
  canAttach,
  onSend,
  onTyping
}: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('')
  const picker = useRef<HTMLInputElement>(null)

  if (disabledReason) {
    return (
      <div className="bg-card/60 text-muted-foreground border px-3 py-2 text-[13px] leading-[22px]">
        {disabledReason}
      </div>
    )
  }

  const send = (): void => {
    if (uploads.busy) return uploads.setNotices(['Wait for the uploads to finish, then send.'])
    if (uploads.failed) return uploads.setNotices(['Remove the failed uploads to send.'])
    if (!text.trim() && uploads.items.length === 0) return
    onSend(text, uploads.take())
    setText('')
  }

  return (
    <>
      <div className="bg-card focus-within:border-ring border">
        <UploadTray items={uploads.items} onRemove={uploads.remove} />
        <div className="flex">
          {canAttach && (
            <>
              <IconButton
                label="Attach files"
                className="mt-[5px] ml-1.5"
                onClick={() => picker.current?.click()}
              >
                <Plus />
              </IconButton>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                tabIndex={-1}
                onChange={(e) => {
                  uploads.add([...(e.target.files ?? [])])
                  e.target.value = '' // picking the same file again must fire change
                }}
              />
            </>
          )}
          <textarea
            aria-label={placeholder}
            placeholder={placeholder}
            value={text}
            rows={1}
            onChange={(e) => {
              setText(e.target.value)
              if (e.target.value) onTyping()
            }}
            onKeyDown={(e) => submitOnEnter(e, send)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files]
              if (!canAttach || files.length === 0) return
              e.preventDefault()
              uploads.add(files)
            }}
            className={cn(
              'field-sizing-content block max-h-[196px] min-h-[42px] w-full resize-none bg-transparent py-[10px] pr-3',
              canAttach ? 'pl-1.5' : 'pl-3',
              'placeholder:text-muted-foreground font-mono text-[13.5px] leading-[22px] outline-none'
            )}
          />
        </div>
      </div>
      {uploads.notices.length > 0 && (
        <div role="alert" className="text-destructive pt-1 text-xs leading-4">
          {uploads.notices.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </div>
      )}
    </>
  )
}
