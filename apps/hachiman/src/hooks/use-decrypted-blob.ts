import { useEffect, useState } from 'react'
import { blobKey } from '@hachiman/client'
import type { AttachmentPointer } from '@hachiman/crypto'
import { BlobUrlCache } from '@/lib/blob-url-cache'
import { errMsg } from '@/lib/utils'
import { cryptoService } from '@/services/CryptoService'
import { hachiman } from '@/services/hachiman'
import { useCryptoStore } from '@/stores/cryptoStore'

/** What a decrypt needs: a file pointer or a thumbnail pointer (§12.9). */
export type BlobPointer = Pick<AttachmentPointer, 'uploadId' | 'key' | 'sha256' | 'mime' | 'size'>

/** Decrypted attachments and thumbnails that stay as object URLs without a holder. */
const CACHE_ENTRIES = 48

const cache = new BlobUrlCache({ capacity: CACHE_ENTRIES })
/** How long the object URL of a download lives. */
const DOWNLOAD_URL_MS = 60_000

/** Sign-out: revokes every decrypted object URL. */
export function clearDecryptedBlobs(): void {
  cache.clear()
}

// The sha256 is part of the key: two pointers that name one upload with other keys never share.
const cacheKey = (p: BlobPointer): string => `${p.uploadId}:${p.sha256}`

/**
 * Downloads `/files/{uploadId}/blob` and decrypts it in the Worker. The Worker checks the length
 * and SHA-256 first and throws CryptoError('Malformed') on any mismatch. The Blob type is the
 * pointer MIME type.
 */
export async function decryptBlob(p: BlobPointer, signal?: AbortSignal): Promise<Blob> {
  const blob = await hachiman.rest.fetchBlob(blobKey(p.uploadId), { signal })
  return cryptoService
    .client()
    .decryptAttachment({ key: p.key, sha256: p.sha256, mime: p.mime, size: p.size }, blob)
}

export interface DecryptedBlob {
  /** An object URL, null while it loads or after an error. */
  url: string | null
  error: string | null
}

const IDLE: DecryptedBlob = { url: null, error: null }

/**
 * The decrypted file of `pointer` as an object URL. `null` loads nothing (for example a video that
 * the user did not start). The URL stays valid while the component is mounted.
 */
export function useDecryptedBlob(pointer: BlobPointer | null): DecryptedBlob {
  const [state, setState] = useState<{ key: string | null; value: DecryptedBlob }>({
    key: null,
    value: IDLE
  })
  const key = pointer ? cacheKey(pointer) : null
  // The Worker decrypts: wait until it runs.
  const ready = useCryptoStore((s) => s.phase === 'ready')

  useEffect(() => {
    if (!pointer || key === null || !ready) return
    let live = true
    const lease = cache.acquire(key, () => decryptBlob(pointer))
    lease.url.then(
      (url) => live && setState({ key, value: { url, error: null } }),
      (e: unknown) => live && setState({ key, value: { url: null, error: errMsg(e) } })
    )
    return () => {
      live = false
      lease.release()
    }
    // The key names the pointer: a new object for the same file must not load again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready])

  return state.key === key ? state.value : IDLE
}

/**
 * Saves a decrypted attachment as a file. The object URL is octet-stream and only feeds a
 * `download` link: a decrypted blob never opens as a page of this origin.
 */
export async function downloadAttachment(pointer: AttachmentPointer): Promise<void> {
  const blob = await decryptBlob(pointer)
  const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }))
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = pointer.name || 'file'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // Some browsers read the URL after click() returns.
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_MS)
  }
}
