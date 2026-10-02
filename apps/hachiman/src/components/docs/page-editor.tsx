import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import { editorViewCtx, commandsCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { history } from '@milkdown/kit/plugin/history'
import { uploadConfig } from '@milkdown/kit/plugin/upload'
import { clearTextInCurrentBlockCommand } from '@milkdown/kit/preset/commonmark'
import { collab, collabServiceCtx } from '@milkdown/plugin-collab'
import { insertPageLink, pageLinks } from './page-links'
import { pageMedia } from './page-media'
import { PagePicker } from './page-picker'
import './page-editor.css'
import { docsService } from '@/services/docs/DocsService'
import type { DocHandle } from '@/services/docs/types'

// lucide "link" and "file-plus", in the 24px frame of the Crepe menu icons.
const LINK_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>'
const SUBPAGE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18v-6"/></svg>'

export interface PageEditorProps {
  handle: DocHandle
  /** False: read-only (no SEND_MESSAGES, or the doc is not live yet). */
  editable: boolean
  /** A click on a page link. */
  onOpenPage: (pageId: string) => void
  /** "New sub-page" in the slash menu: creates a child of this page. Resolves the new id and title. */
  onNewSubPage: () => Promise<{ id: string; title: string } | null>
}

/** Where the "Link to page" picker opens, and the editor ctx that inserts the pick. */
interface PickAt {
  ctx: Ctx
  left: number
  top: number
}

/**
 * The Crepe editor of one open page, bound to the page's Y.Doc and Awareness through
 * @milkdown/plugin-collab. One editor per handle: a new handle (page switch) destroys the
 * old editor first. Crepe's history plugin is removed: y-prosemirror's undo manager replaces
 * it (it undoes only local edits). Paste and drop of files upload them as encrypted page media
 * (page-media.tsx).
 */
export function PageEditor({
  handle,
  editable,
  onOpenPage,
  onNewSubPage
}: PageEditorProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const crepeRef = useRef<Crepe | null>(null)
  const [pickAt, setPickAt] = useState<PickAt | null>(null)
  const [mediaError, setMediaError] = useState<string | null>(null)
  // The editor lives longer than one render; it calls the newest callbacks.
  const live = useRef({ onOpenPage, onNewSubPage, editable })
  useLayoutEffect(() => {
    live.current = { onOpenPage, onNewSubPage, editable }
  })

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let destroyed = false
    const crepe = new Crepe({
      root,
      features: { [Crepe.Feature.ImageBlock]: false, [Crepe.Feature.TopBar]: false },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: 'Type / for blocks and page links', mode: 'block' },
        [Crepe.Feature.BlockEdit]: {
          advancedGroup: { image: null },
          buildMenu: (builder) => {
            builder
              .addGroup('pages', 'Pages')
              .addItem('link-page', {
                label: 'Link to page',
                icon: LINK_ICON,
                onRun: (ctx: Ctx) => {
                  ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key)
                  const view = ctx.get(editorViewCtx)
                  const at = view.coordsAtPos(view.state.selection.from)
                  setPickAt({ ctx, left: at.left, top: at.bottom })
                }
              })
              .addItem('new-subpage', {
                label: 'New sub-page',
                icon: SUBPAGE_ICON,
                onRun: (ctx: Ctx) => {
                  ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key)
                  void live.current.onNewSubPage().then((page) => {
                    if (!page || destroyed) return
                    insertPageLink(ctx.get(editorViewCtx), ctx, page.id, page.title)
                  })
                }
              })
          }
        }
      }
    })
    crepe.setReadonly(!live.current.editable)
    void crepe.editor.remove(history)
    const media = pageMedia(handle.pageId, (text) => !destroyed && setMediaError(text))
    crepe.editor
      .config((ctx) => ctx.update(uploadConfig.key, media.upload))
      .use(collab)
      .use(media.plugins)
      .use(pageLinks((id) => live.current.onOpenPage(id)))
    const created = crepe.create().then(() => {
      if (destroyed) return
      crepe.editor.action((ctx) => {
        ctx.get(collabServiceCtx).bindDoc(handle.doc).setAwareness(handle.awareness).connect()
      })
      crepe.setReadonly(!live.current.editable)
      crepeRef.current = crepe
      docsService.setMarkdownSource(handle.pageId, () => crepe.getMarkdown())
    })
    created.catch((e) => console.warn('[pages] editor create failed', e))

    return () => {
      destroyed = true
      crepeRef.current = null
      setPickAt(null)
      setMediaError(null)
      docsService.setMarkdownSource(handle.pageId, null)
      void created
        .then(() => crepe.destroy())
        .catch((e) => console.warn('[pages] editor destroy failed', e))
    }
  }, [handle])

  useEffect(() => {
    crepeRef.current?.setReadonly(!editable)
  }, [editable])

  return (
    <div className="hm-page-editor min-h-0 flex-1 overflow-y-auto">
      {mediaError && (
        <div className="bg-destructive/10 text-destructive sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 text-xs">
          <span className="flex-1">{mediaError}</span>
          <button type="button" className="underline" onClick={() => setMediaError(null)}>
            Dismiss
          </button>
        </div>
      )}
      <div ref={rootRef} className="mx-auto w-full max-w-3xl px-2 py-4" />
      {pickAt && (
        <PagePicker
          at={pickAt}
          excludeId={handle.pageId}
          onPick={(page) => {
            const { ctx } = pickAt
            setPickAt(null)
            if (crepeRef.current) insertPageLink(ctx.get(editorViewCtx), ctx, page.id, page.title)
          }}
          onClose={() => setPickAt(null)}
        />
      )}
    </div>
  )
}
