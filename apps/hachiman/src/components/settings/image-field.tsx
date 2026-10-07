import { useEffect, useId, useRef, useState } from 'react'
import { PROFILE_IMAGE_TYPES } from '@hachiman/client'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { ErrorText, Field } from '@/components/ui/field'
import { useAction } from '@/hooks/use-action'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import {
  PROFILE_IMAGE_FORMATS,
  ensureLimits,
  uploadErrorText,
  uploadFile
} from '@/services/UploadService'

const ACCEPTED: readonly string[] = PROFILE_IMAGE_TYPES

/**
 * Pick, upload and apply one profile image (avatar, guild icon or banner). The picked file shows
 * as a local preview while it uploads, until the saved key comes back through the gateway.
 * ponytail: no cropper; the image is shown with object-fit cover wherever it is used.
 */
export function ImageField({
  label,
  hint,
  value,
  fallback,
  wide,
  row,
  onSave
}: {
  label: string
  hint?: string
  /** Current file key, or null. */
  value: string | null
  /** Shown when there is no image or it fails to load. */
  fallback: React.ReactNode
  /** A wide banner strip instead of a circle. */
  wide?: boolean
  /** One row: a small circle, the label and hint, then the buttons (My account). */
  row?: boolean
  /** Apply an upload id, or null to remove the image. */
  onSave: (uploadId: string | null) => Promise<unknown>
}): React.JSX.Element {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const { run, busy, error, setError } = useAction()
  // `base` is the key the preview replaces; once the key changes, the saved image takes over.
  const [preview, setPreview] = useState<{ url: string; base: string | null } | null>(null)
  const inflight = useRef<AbortController | null>(null)

  useEffect(ensureLimits, [])
  useEffect(() => () => inflight.current?.abort(), [])

  useEffect(() => {
    if (!preview) return undefined
    return () => URL.revokeObjectURL(preview.url)
  }, [preview])

  const src =
    preview && preview.base === value ? preview.url : value ? hachiman.rest.fileUrl(value) : null

  const pick = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = '' // so picking the same file again still fires change
    if (!file) return
    if (!ACCEPTED.includes(file.type)) {
      setError(`${file.name} is not a ${PROFILE_IMAGE_FORMATS} image.`)
      return
    }
    const controller = new AbortController()
    inflight.current = controller
    const { signal } = controller
    setPreview({ url: URL.createObjectURL(file), base: value })
    const saved = await run('upload the image', async () => {
      const upload = await uploadFile(file, { signal })
      if (signal.aborted) return
      await onSave(upload.id).catch((err: unknown) => {
        throw new Error(uploadErrorText(err), { cause: err })
      })
    })
    if (!saved.ok) setPreview(null)
  }

  const remove = async (): Promise<void> => {
    setPreview(null)
    await run('remove the image', () => onSave(null))
  }

  const thumb = (
    <Avatar
      className={cn(
        'bg-surface-raised border-line-hairline border',
        wide ? 'aspect-[11/2] size-auto w-full rounded-none' : row ? 'size-14' : 'size-24'
      )}
    >
      {src && <AvatarImage src={src} alt="" />}
      <AvatarFallback
        className={cn('bg-surface-raised text-text-secondary', wide ? 'rounded-none' : 'text-2xl')}
      >
        {fallback}
      </AvatarFallback>
      {busy && preview && (
        <span className="bg-surface-window/70 absolute inset-0 flex items-center justify-center text-xs">
          Uploading…
        </span>
      )}
    </Avatar>
  )
  const buttons = (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        variant="secondary"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {value ? 'Change' : 'Upload image'}
      </Button>
      {value && (
        <Button type="button" variant="quiet" disabled={busy} onClick={() => void remove()}>
          Remove
        </Button>
      )}
    </div>
  )
  const picker = (
    <input
      ref={input}
      id={id}
      type="file"
      accept={ACCEPTED.join(',')}
      className="hidden"
      disabled={busy}
      onChange={(e) => void pick(e)}
    />
  )

  if (row)
    return (
      <div className="grid gap-1.5">
        <div className="flex items-center gap-4">
          {thumb}
          <label htmlFor={id} className="grid min-w-0 flex-1">
            <span className="text-label">{label}</span>
            {hint && <span className="text-meta text-text-tertiary">{hint}</span>}
          </label>
          {buttons}
          {picker}
        </div>
        <ErrorText>{error}</ErrorText>
      </div>
    )

  return (
    <Field id={id} label={label}>
      <div className="grid gap-2">
        {thumb}
        <div className="flex items-center gap-2">
          {buttons}
          {hint && <span className="text-meta text-text-tertiary flex-1 text-right">{hint}</span>}
        </div>
        {picker}
      </div>
      <ErrorText>{error}</ErrorText>
    </Field>
  )
}
