// Page links in the editor: a markdown link with the target `hachiman:page/<pageId>`.
// The editor shows the current decrypted title of the target page in place of the link text,
// and a click on it opens that page. The link text stays in the page, so the markdown export
// keeps a valid link. Milkdown's link mark renders an empty DOM href for this scheme (not on
// its list of safe protocols), so the plugin reads the target from the mark attrs.
import { linkSchema } from '@milkdown/kit/preset/commonmark'
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose, type $Prose } from '@milkdown/kit/utils'
import { pageTitle } from '@/services/docs/page-tree'
import { findPage, useDocsStore } from '@/stores/docsStore'

export const PAGE_HREF_PREFIX = 'hachiman:page/'

export const pageHref = (pageId: string): string => PAGE_HREF_PREFIX + pageId

export function pageIdOfHref(href: unknown): string | null {
  if (typeof href !== 'string' || !href.startsWith(PAGE_HREF_PREFIX)) return null
  const id = href.slice(PAGE_HREF_PREFIX.length)
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null
}

/** One run of text with the same page link mark. */
interface LinkRange {
  from: number
  to: number
  pageId: string
}

function linkRanges(state: EditorState): LinkRange[] {
  const out: LinkRange[] = []
  state.doc.descendants((node, pos) => {
    if (!node.isText) return
    const mark = node.marks.find((m) => m.type.name === 'link')
    const pageId = mark ? pageIdOfHref(mark.attrs.href) : null
    if (!pageId) return
    const last = out[out.length - 1]
    if (last && last.to === pos && last.pageId === pageId) last.to = pos + node.nodeSize
    else out.push({ from: pos, to: pos + node.nodeSize, pageId })
  })
  return out
}

const key = new PluginKey<DecorationSet>('HACHIMAN_PAGE_LINKS')

function decorations(state: EditorState, onOpen: (pageId: string) => void): DecorationSet {
  const { from: selFrom, to: selTo } = state.selection
  const decos: Decoration[] = []
  for (const r of linkRanges(state)) {
    const page = findPage(r.pageId)
    // A page of a channel that is not loaded: the raw link text, styled as a page link.
    // While the selection touches the link, the raw text shows so that it can be edited.
    if (!page || (selFrom <= r.to && selTo >= r.from)) {
      decos.push(Decoration.inline(r.from, r.to, { class: 'hm-page-link hm-page-link-raw' }))
      continue
    }
    const title = pageTitle(page)
    decos.push(Decoration.inline(r.from, r.to, { class: 'hm-page-link-hidden' }))
    decos.push(
      Decoration.widget(
        r.from,
        () => {
          const el = document.createElement('span')
          el.className = 'hm-page-link'
          el.contentEditable = 'false'
          el.textContent = title
          el.title = 'Open page'
          el.addEventListener('mousedown', (e) => {
            e.preventDefault()
            e.stopPropagation()
            onOpen(r.pageId)
          })
          return el
        },
        { side: -1, key: `${r.pageId}:${title}`, ignoreSelection: true }
      )
    )
  }
  return DecorationSet.create(state.doc, decos)
}

function pageAt(view: EditorView, pos: number): string | null {
  const node = view.state.doc.nodeAt(pos)
  const mark = node?.marks.find((m) => m.type.name === 'link')
  return mark ? pageIdOfHref(mark.attrs.href) : null
}

/**
 * The editor plugin. `onOpen` opens a page. A click on a raw page link opens it when the editor
 * is read-only (in edit mode the click places the cursor, so that the text can be edited).
 * A click on another link opens it outside the app, never in the app window.
 */
export function pageLinks(onOpen: (pageId: string) => void): $Prose {
  return $prose(
    () =>
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => decorations(state, onOpen),
          apply: (tr, old, _prev, state) =>
            tr.docChanged || tr.selectionSet || tr.getMeta(key) ? decorations(state, onOpen) : old
        },
        props: {
          decorations: (state) => key.getState(state),
          handleClick: (view, pos, event) => {
            const pageId = pageAt(view, pos)
            if (pageId && !view.editable) {
              event.preventDefault()
              onOpen(pageId)
              return true
            }
            return false
          },
          handleDOMEvents: {
            click: (view, event) => {
              const a = (event.target as HTMLElement | null)?.closest?.('a')
              if (!a || !view.dom.contains(a)) return false
              event.preventDefault()
              const href = a.getAttribute('href') ?? ''
              if (!view.editable && /^https?:\/\//i.test(href)) {
                window.open(href, '_blank', 'noopener,noreferrer')
              }
              return false
            }
          }
        },
        // A title change in docsStore redraws the widgets.
        view: (view) => {
          const unsubscribe = useDocsStore.subscribe((s, prev) => {
            if (s.pagesByChannel !== prev.pagesByChannel) {
              view.dispatch(view.state.tr.setMeta(key, true).setMeta('addToHistory', false))
            }
          })
          return { destroy: unsubscribe }
        }
      })
  )
}

export function insertPageLink(
  view: EditorView,
  ctx: Parameters<typeof linkSchema.type>[0],
  pageId: string,
  text: string
): void {
  const type = linkSchema.type(ctx)
  const mark = type.create({ href: pageHref(pageId) })
  const tr = view.state.tr.replaceSelectionWith(
    view.state.schema.text(text || 'Untitled', [mark]),
    false
  )
  view.dispatch(tr.removeStoredMark(type).scrollIntoView())
  view.focus()
}
