import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import { editorViewCtx, commandsCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { history } from '@milkdown/kit/plugin/history'
import { uploadConfig } from '@milkdown/kit/plugin/upload'
import { clearTextInCurrentBlockCommand } from '@milkdown/kit/preset/commonmark'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { collab, collabServiceCtx } from '@milkdown/plugin-collab'
import { redo as yRedo, undo as yUndo } from 'y-prosemirror'
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

/**
 * Editor keys that a code block (CodeMirror node view) would otherwise swallow. Its node view
 * stops every event, so ProseMirror's keymaps never see them, and it binds Mod-z to
 * prosemirror-history, which is removed here, so CodeMirror's own history ran instead and could
 * not undo the block itself (e.g. a `$$` LaTeX block). This capture listener runs first:
 * - Mod-z / Mod-Shift-z / Mod-y anywhere in the editor go to the y-prosemirror undo manager.
 * - Backspace / Delete with the whole LaTeX source selected (or empty) removes the block.
 */
function editorKeyCapture(getView: () => EditorView | null): (e: KeyboardEvent) => void {
  return (e) => {
    const view = getView()
    const target = e.target
    if (!view || !view.editable || e.isComposing || !(target instanceof Node)) return
    if (!view.dom.contains(target) || target instanceof HTMLInputElement) return

    const key = e.key.toLowerCase()
    const isRedoY = key === 'y' && !e.shiftKey
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (key === 'z' || isRedoY)) {
      e.preventDefault()
      e.stopPropagation()
      if (key === 'z' && !e.shiftKey) yUndo(view.state)
      else yRedo(view.state)
      if (!view.dom.contains(document.activeElement)) view.focus()
      return
    }

    if ((key !== 'backspace' && key !== 'delete') || e.metaKey || e.ctrlKey || e.altKey) return
    const { $from, from, to } = view.state.selection
    const block = $from.parent
    if (block.type.name !== 'code_block' || !/^latex$/i.test(String(block.attrs.language))) return
    if (from !== $from.start() || to !== $from.end()) return
    e.preventDefault()
    e.stopPropagation()
    const at = $from.before()
    const tr = view.state.tr.replaceWith(
      at,
      $from.after(),
      view.state.schema.nodes.paragraph!.create()
    )
    view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1))).scrollIntoView())
    view.focus()
  }
}

export interface PageEditorProps {
  handle: DocHandle
  /** False: read-only (no SEND_MESSAGES, or the doc is not live yet). */
  editable: boolean
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
 * it (it undoes only local edits), also inside code blocks (editorKeyCapture). Paste and drop
 * of files upload them as encrypted page media (page-media.tsx).
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
    const onKeyDown = editorKeyCapture(() =>
      crepeRef.current ? crepeRef.current.editor.action((ctx) => ctx.get(editorViewCtx)) : null
    )
    root.addEventListener('keydown', onKeyDown, true)
    const crepe = new Crepe({
      root,
      features: { [Crepe.Feature.ImageBlock]: false, [Crepe.Feature.TopBar]: false },
      featureConfigs: {
        // Crepe's default CodeMirror theme is oneDark: light grey text (#abb2bf) that, on the
        // light theme, sits on our light code surface and reads as disabled. null keeps it out
        // (Crepe fills only undefined options), so code and LaTeX source use the page ink.
        [Crepe.Feature.CodeMirror]: document.documentElement.classList.contains('dark')
          ? {}
          : { theme: null as never },
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
      root.removeEventListener('keydown', onKeyDown, true)
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
