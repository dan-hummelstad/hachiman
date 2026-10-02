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
  onSave
}: {
  label: string
  hint?: string
  /** Current file key, or null. */
  value: string | null
  /** Shown when there is no image or it fails to load. */
  fallback: React.ReactNode
  /** A 16:9 banner strip instead of a square. */
  wide?: boolean
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

  return (
    <Field id={id} label={label} hint={hint}>
      <div className="grid justify-items-start gap-3">
        <Avatar className={cn('bg-rail border', wide ? 'aspect-video size-auto w-60' : 'size-20')}>
          {src && <AvatarImage src={src} alt="" />}
          <AvatarFallback className={cn('bg-rail', !wide && 'text-2xl')}>{fallback}</AvatarFallback>
          {busy && preview && (
            <span className="bg-background/70 absolute inset-0 flex items-center justify-center text-xs">
              Uploading…
            </span>
          )}
        </Avatar>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {value ? 'Change' : 'Upload image'}
          </Button>
          {value && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void remove()}
            >
              Remove
            </Button>
          )}
        </div>
        <input
          ref={input}
          id={id}
          type="file"
          accept={ACCEPTED.join(',')}
          className="hidden"
          disabled={busy}
          onChange={(e) => void pick(e)}
        />
      </div>
      <ErrorText>{error}</ErrorText>
    </Field>
  )
}
