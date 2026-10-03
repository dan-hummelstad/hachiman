// Media in pages (plan "Media in pages"): a drop or paste of files encrypts each one like a
// message attachment (§12.9), uploads the blob, claims it for the page (POST /pages/:id/media),
// then inserts an `hm_media` node that holds the attachment pointer as JSON. The pointer, with
// its file key, lives only in the Y.Doc, so it is encrypted with the page: the clipboard HTML
// carries only the upload id (copyMediaPointer). The node renders the decrypted blob through the
// message attachment views (object URLs, never a file URL).
import { createRoot, type Root } from 'react-dom/client'
import { RestError } from '@hachiman/client'
import type { AttachmentPointer } from '@hachiman/crypto'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import type { Node } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { ReplaceAroundStep, ReplaceStep } from '@milkdown/kit/prose/transform'
import { Decoration, type NodeViewConstructor } from '@milkdown/kit/prose/view'
import type { UploadOptions } from '@milkdown/kit/plugin/upload'
import { $node, $prose, $view } from '@milkdown/kit/utils'
import { ySyncPluginKey } from 'y-prosemirror'
import { MessageAttachments } from '@/components/chat/attachments/message-attachments'
import { uploadIdsOf } from '@/lib/attachments'
import { uploadAttachment, uploadErrorText } from '@/services/UploadService'
import {
  MEDIA_NODE,
  copyMediaPointer,
  parsePointer,
  pastedMediaPointer
} from '@/services/docs/media'
import { hachiman } from '@/services/hachiman'

export const UPLOAD_HREF_PREFIX = 'hachiman:upload/'

/** POST /pages/:id/media takes at most this many ids. */
const CLAIM_BATCH = 20

const mediaSchema = $node(MEDIA_NODE, () => ({
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  attrs: { pointer: { default: '' } },
  parseDOM: [
    {
      tag: 'div[data-hm-media]',
      getAttrs: (dom) => {
        const pointer = pastedMediaPointer((dom as HTMLElement).getAttribute('data-hm-media'))
        return pointer === null ? false : { pointer }
      }
    }
  ],
  // Only serialization (copy, drag) uses toDOM: the node view renders the block.
  toDOM: (node) => ['div', { 'data-hm-media': copyMediaPointer(node.attrs.pointer) }],
  // Markdown never makes a media node: a pointer comes only from an upload.
  parseMarkdown: { match: () => false, runner: () => {} },
  // A normal image or link with the target hachiman:upload/<id>. The file key stays in the page.
  toMarkdown: {
    match: (node) => node.type.name === MEDIA_NODE,
    runner: (state, node) => {
      const p = parsePointer(node.attrs.pointer)
      if (!p) return
      const url = UPLOAD_HREF_PREFIX + p.uploadId
      state.openNode('paragraph')
      if (p.mime.startsWith('image/'))
        state.addNode('image', undefined, undefined, { url, alt: p.name, title: null })
      else
        state
          .openNode('link', undefined, { url, title: null })
          .addNode('text', undefined, p.name)
          .closeNode()
      state.closeNode()
    }
  }
}))

const mediaBlock = (pointer: AttachmentPointer | null): React.JSX.Element =>
  pointer ? (
    <MessageAttachments attachments={[pointer]} />
  ) : (
    <p className="text-muted-foreground text-xs">This file cannot be shown.</p>
  )

const mediaView = $view(mediaSchema, (): NodeViewConstructor => (initial) => {
  const dom = document.createElement('div')
  dom.className = 'hm-page-media'
  dom.contentEditable = 'false'
  const root: Root = createRoot(dom)
  let node: Node = initial
  const render = (): void => root.render(mediaBlock(parsePointer(node.attrs.pointer)))
  render()
  return {
    dom,
    update: (next) => {
      if (next.type !== node.type) return false
      if (next.attrs.pointer !== node.attrs.pointer) {
        node = next
        render()
      }
      return true
    },
    // The players, buttons and links handle their own events; the frame stays draggable.
    stopEvent: (e) => e.target instanceof Element && !!e.target.closest('button,a,video,audio'),
    ignoreMutation: () => true,
    // Unmount after ProseMirror's update, never during a React render.
    destroy: () => void setTimeout(() => root.unmount())
  }
})

function claimErrorText(e: unknown): string {
  if (e instanceof RestError && e.code === 'StorageQuotaExceeded')
    return 'The page storage of this server is full.'
  return uploadErrorText(e)
}

async function claim(pageId: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += CLAIM_BATCH)
    await hachiman.rest.claimPageMedia(pageId, ids.slice(i, i + CLAIM_BATCH))
}

export interface PageMedia {
  plugins: MilkdownPlugin[]
  /** For `ctx.update(uploadConfig.key, …)`. */
  upload: (prev: UploadOptions) => UploadOptions
}

/**
 * The media plugins of the editor of `pageId`, and the upload config for its drop and paste.
 * `onError` gets a user-facing line for each file that did not go in.
 */
export function pageMedia(pageId: string, onError: (text: string) => void): PageMedia {
  // The progress widget of each upload, by insert position (the upload plugin creates the widget,
  // then calls the uploader with the same position).
  const widgets = new Map<number, HTMLElement>()
  // Ids that the uploader just claimed: the re-claim below skips them once.
  const claimed = new Set<string>()

  const uploadWidgetFactory: UploadOptions['uploadWidgetFactory'] = (pos, spec) => {
    const el = document.createElement('div')
    el.className = 'hm-page-upload text-muted-foreground text-xs'
    el.textContent = 'Encrypting…'
    widgets.set(pos, el)
    return Decoration.widget(pos, el, spec)
  }

  // The upload plugin leaves its widget for ever when this rejects, so it never does.
  const uploader: UploadOptions['uploader'] = async (files, schema, _ctx, pos) => {
    const el = widgets.get(pos)
    widgets.delete(pos)
    const type = schema.nodes[MEDIA_NODE]
    const list = Array.from(files)
    const nodes: Node[] = []
    if (!type) return nodes
    for (const [i, file] of list.entries()) {
      const label = list.length > 1 ? `${file.name} (${i + 1} of ${list.length})` : file.name
      if (el) el.textContent = `Uploading ${label}…`
      try {
        const pointer = await uploadAttachment(file, {
          onProgress: (f) => {
            if (el) el.textContent = `Uploading ${label}… ${Math.round(f * 100)}%`
          }
        })
        const ids = uploadIdsOf([pointer])
        await claim(pageId, ids)
        for (const id of ids) claimed.add(id)
        nodes.push(type.create({ pointer: JSON.stringify(pointer) }))
      } catch (e) {
        onError(`${file.name || 'A file'} was not added: ${claimErrorText(e)}`)
      }
    }
    return nodes
  }

  // A local insert of a media node (paste, cut and paste, a copy from another page) claims its
  // uploads again, which refreshes last_referenced_at for the media sweep. Remote edits and the
  // undo manager come through y-sync and claim nothing.
  const reclaim = $prose(
    () =>
      new Plugin({
        key: new PluginKey('HM_PAGE_MEDIA_RECLAIM'),
        appendTransaction: (trs) => {
          const ids = new Set<string>()
          for (const tr of trs) {
            if (!tr.docChanged || tr.getMeta(ySyncPluginKey)) continue
            for (const step of tr.steps) {
              if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) continue
              step.slice.content.descendants((n) => {
                if (n.type.name !== MEDIA_NODE) return true
                const p = parsePointer(n.attrs.pointer)
                if (p) for (const id of uploadIdsOf([p])) ids.add(id)
                return false
              })
            }
          }
          const todo = [...ids].filter((id) => !claimed.delete(id))
          if (todo.length > 0)
            claim(pageId, todo).catch((e) =>
              console.warn('[pages] media re-claim failed', e instanceof RestError ? e.code : e)
            )
          return null
        }
      })
  )

  return {
    plugins: [mediaSchema, mediaView, reclaim],
    upload: (prev: UploadOptions): UploadOptions => ({ ...prev, uploader, uploadWidgetFactory })
  }
}
