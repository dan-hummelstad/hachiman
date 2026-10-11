import { useEffect, useId, useRef, useState } from 'react'
import { PROFILE_IMAGE_TYPES } from '@hachiman/client'
import { useAction } from '@/hooks/use-action'
import { hachiman } from '@/services/hachiman'
import {
  PROFILE_IMAGE_FORMATS,
  ensureLimits,
  uploadErrorText,
  uploadFile
} from '@/services/UploadService'

const ACCEPTED: readonly string[] = PROFILE_IMAGE_TYPES

export interface ImageUpload {
  /** The image to show: the picked file while it uploads, else the saved file. Null: none. */
  src: string | null
  busy: boolean
  /** A picked file is uploading: its preview shows. */
  uploading: boolean
  error: string | null
  /** Spread on the one hidden `<input type="file">`. */
  input: React.ComponentProps<'input'> & { ref: React.RefObject<HTMLInputElement | null> }
  /** Opens the file picker. Call it in the tap handler: iOS opens it only inside a gesture. */
  pick: () => void
  /** Removes the image (`onSave(null)`). */
  remove: () => Promise<void>
}

/**
 * Pick, upload and apply one profile image (avatar, guild icon or banner). The picked file shows
 * as a local preview while it uploads, until the saved key comes back through the gateway. An
 * unmount aborts the upload; the preview's object URL is revoked when it goes.
 */
export function useImageUpload(
  /** The current file key, or null. */
  value: string | null,
  /** Applies an upload id, or null to remove the image. */
  onSave: (uploadId: string | null) => Promise<unknown>
): ImageUpload {
  const id = useId()
  const ref = useRef<HTMLInputElement>(null)
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

  const onChange = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
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

  return {
    src,
    busy,
    uploading: busy && preview !== null,
    error,
    input: {
      ref,
      id,
      type: 'file',
      accept: ACCEPTED.join(','),
      className: 'hidden',
      disabled: busy,
      onChange: (e) => void onChange(e)
    },
    pick: () => ref.current?.click(),
    remove
  }
}
