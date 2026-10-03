import { useEffect, useRef, useState } from 'react'
import { embedKind, type EmbedKind } from '@hachiman/client'
import type { AttachmentPointer } from '@hachiman/crypto'
import { errMsg } from '@/lib/utils'
import { currentLimits, ensureLimits, tooLarge, uploadAttachment } from '@/services/UploadService'

export interface PendingUpload {
  /** Local id (the tray key), not the upload id. */
  id: string
  file: File
  kind: EmbedKind
  /** Object URL for the image/video thumbnail. Revoked when the upload leaves the tray. */
  preview: string | null
  controller: AbortController
  /** 0..1 */
  progress: number
  /** Set once the file is encrypted and Takusen stored its blobs. */
  attachment: AttachmentPointer | null
  error: string | null
}

export interface Uploads {
  items: PendingUpload[]
  /** Why the last add or send was refused, one line each. */
  notices: string[]
  /** Some upload is still running. */
  busy: boolean
  /** Some upload failed and is still in the tray. */
  failed: boolean
  /** Validates against Takusen's limits and starts uploading every accepted file right away. */
  add: (files: File[]) => void
  /** Abort (if running) and drop one upload. */
  remove: (id: string) => void
  /** The finished uploads, emptying the tray. Their ids now belong to the message being sent. */
  take: () => AttachmentPointer[]
  setNotices: (notices: string[]) => void
}

/**
 * Pending attachments of one composer. Mount it per channel: unmounting aborts the uploads still
 * running and revokes every thumbnail URL.
 */
export function useUploads(): Uploads {
  const [items, setItems] = useState<PendingUpload[]>([])
  const [notices, setNotices] = useState<string[]>([])
  // Mirrors `items` synchronously, so a burst of adds counts against the limit correctly and
  // unmount sees the latest list. Every change goes through `commit`.
  const current = useRef<PendingUpload[]>([])

  const commit = (next: PendingUpload[]): void => {
    current.current = next
    setItems(next)
  }

  useEffect(ensureLimits, [])

  useEffect(() => {
    const list = current
    return () => {
      list.current.forEach(release)
      list.current = []
    }
  }, [])

  const patch = (id: string, change: Partial<PendingUpload>): void =>
    commit(current.current.map((u) => (u.id === id ? { ...u, ...change } : u)))

  const add = (files: File[]): void => {
    const refused: string[] = []
    let overflow = false
    const accepted: PendingUpload[] = []
    const limits = currentLimits()
    for (const file of files) {
      const large = tooLarge(file)
      if (large) {
        refused.push(large)
        continue
      }
      if (current.current.length + accepted.length >= limits.maxAttachmentsPerMessage) {
        overflow = true
        continue
      }
      const kind = embedKind(file.type)
      accepted.push({
        id: crypto.randomUUID(),
        file,
        kind,
        preview: kind === 'image' || kind === 'video' ? URL.createObjectURL(file) : null,
        controller: new AbortController(),
        progress: 0,
        attachment: null,
        error: null
      })
    }
    if (overflow)
      refused.push(`You can attach up to ${limits.maxAttachmentsPerMessage} files to one message.`)
    setNotices(refused)
    if (accepted.length === 0) return
    commit([...current.current, ...accepted])
    for (const u of accepted) {
      const { signal } = u.controller
      uploadAttachment(u.file, { signal, onProgress: (progress) => patch(u.id, { progress }) })
        .then((attachment) => patch(u.id, { attachment, progress: 1 }))
        .catch((e) => {
          if (!signal.aborted) patch(u.id, { error: errMsg(e) })
        })
    }
  }

  const remove = (id: string): void => {
    current.current.filter((u) => u.id === id).forEach(release)
    commit(current.current.filter((u) => u.id !== id))
    setNotices([])
  }

  const take = (): AttachmentPointer[] => {
    const done = current.current.flatMap((u) => (u.attachment ? [u.attachment] : []))
    current.current.forEach(release)
    commit([])
    setNotices([])
    return done
  }

  return {
    items,
    notices,
    busy: items.some((u) => !u.attachment && !u.error),
    failed: items.some((u) => u.error !== null),
    add,
    remove,
    take,
    setNotices
  }
}

function release(u: PendingUpload): void {
  u.controller.abort()
  if (u.preview) URL.revokeObjectURL(u.preview)
}
