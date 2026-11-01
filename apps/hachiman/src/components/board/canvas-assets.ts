/**
 * Images on a canvas (contract §4 Pages): Excalidraw keeps each image file as a data URL in its
 * scene, and an image element names its file by id. A file that the doc does not know yet (an
 * insert, a paste, a drop) is encrypted like a message attachment (§12.9), uploaded and claimed for
 * the page, and its pointer goes into the `files` Y.Map under the file id. A file that a visible
 * element needs and the scene lacks is decrypted from its pointer and added. The file key lives
 * only in the Y.Doc. Any member who can edit writes these entries: parsePointer checks each one.
 */
import { getDataURL } from '@excalidraw/excalidraw'
import type { FileId } from '@excalidraw/excalidraw/element/types'
import type {
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI
} from '@excalidraw/excalidraw/types'
import { RestError } from '@hachiman/client'
import type * as Y from 'yjs'
import { decryptBlob } from '@/hooks/use-decrypted-blob'
import { uploadIdsOf } from '@/lib/attachments'
import { claimErrorText, claimPageMedia, uploadAttachment } from '@/services/UploadService'
import { parsePointer } from '@/services/docs/media'
import { filesOf } from './canvas-sync'

export interface CanvasFiles {
  /** Uploads the files of the scene that the doc does not have (from onChange). */
  push(files: BinaryFiles): void
  /** Adds the files that the visible images need (after a remote change). */
  load(): void
  unbind(): void
}

const logShape = (e: unknown): unknown =>
  e instanceof RestError ? e.code : e instanceof Error ? e.name : e

/** Excalidraw's data URLs are base64 (FileReader). */
function dataUrlFile(dataURL: string, mime: string): File {
  const bytes = Uint8Array.from(atob(dataURL.slice(dataURL.indexOf(',') + 1)), (c) =>
    c.charCodeAt(0)
  )
  return new File([bytes], 'image', { type: mime })
}

export function bindFiles(doc: Y.Doc, pageId: string, api: ExcalidrawImperativeAPI): CanvasFiles {
  const known = filesOf(doc)
  // Ids that went up or came down once: a failure is not tried again on every onChange.
  const sent = new Set<string>()
  const fetched = new Set<string>()
  let live = true

  const upload = async (f: BinaryFileData): Promise<void> => {
    try {
      const pointer = await uploadAttachment(dataUrlFile(f.dataURL, f.mimeType))
      await claimPageMedia(pageId, uploadIdsOf([pointer]))
      known.set(f.id, JSON.stringify(pointer))
    } catch (e) {
      console.warn('[canvas] image upload failed', logShape(e))
      if (live) api.setToast({ message: `An image was not added: ${claimErrorText(e)}` })
    }
  }

  const load = (): void => {
    const have = api.getFiles()
    for (const el of api.getSceneElements()) {
      if (el.type !== 'image' || !el.fileId || have[el.fileId] || fetched.has(el.fileId)) continue
      const id = el.fileId
      const pointer = parsePointer(known.get(id))
      if (!pointer || !pointer.mime.startsWith('image/')) continue
      fetched.add(id)
      decryptBlob(pointer)
        .then(getDataURL)
        .then((dataURL) => {
          if (!live) return
          const mimeType = pointer.mime as BinaryFileData['mimeType']
          api.addFiles([{ id: id as FileId, mimeType, dataURL, created: Date.now() }])
        })
        .catch((e: unknown) => console.warn('[canvas] image not loaded', logShape(e)))
    }
  }

  known.observe(load)
  load()
  return {
    push(files) {
      for (const f of Object.values(files)) {
        if (known.has(f.id) || sent.has(f.id)) continue
        sent.add(f.id)
        void upload(f)
      }
    },
    load,
    unbind() {
      live = false
      known.unobserve(load)
    }
  }
}
