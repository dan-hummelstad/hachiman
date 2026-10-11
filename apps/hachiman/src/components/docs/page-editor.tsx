import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import { editorViewCtx, editorViewOptionsCtx, commandsCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { history } from '@milkdown/kit/plugin/history'
import { uploadConfig } from '@milkdown/kit/plugin/upload'
import {
  addBlockTypeCommand,
  clearTextInCurrentBlockCommand,
  hrSchema
} from '@milkdown/kit/preset/commonmark'
import { Plugin, PluginKey, TextSelection, type Command } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { collab, collabServiceCtx } from '@milkdown/plugin-collab'
import { redo as yRedo, undo as yUndo } from 'y-prosemirror'
import { insertPageLink, pageLinks } from './page-links'
import { pageMedia } from './page-media'
import { PagePicker } from './page-picker'
import './page-editor.css'
import { KEYBOARD_TOOLBAR_HEIGHT, PageKeyboardToolbar } from '@/components/mobile/keyboard-toolbar'
import { useKeyboardOpen } from '@/hooks/use-visual-viewport'
import { cn } from '@/lib/utils'
import { docsService } from '@/services/docs/DocsService'
import type { DocHandle } from '@/services/docs/types'
import { usePlatform } from '@/shared/PlatformContext'
import { blurPageEditor, trackEditorFocus, usePageEditorState } from './page-editor-state'
import {
  NO_SIGNALS,
  blockSignals,
  currentBlockRange,
  insertSlash,
  signalStore,
  slashMenuPlacement,
  turnInto,
  type BlockKind,
  type EditorSignals,
  type SignalStore
} from './touch-editor'

// lucide "link" and "file-plus", in the 24px frame of the Crepe menu icons.
const LINK_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>'
const SUBPAGE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18v-6"/></svg>'

/** A lucide icon (its inner SVG) for the touch slash menu. `page`: in the page colour. */
const lucide = (paths: string, page = false): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${page ? ' class="hm-page-icon"' : ''}>${paths}</svg>`

/** The "Basic blocks" of the touch slash menu (M40), with lucide icons as in the kit. */
const TOUCH_BLOCKS: readonly { key: string; label: string; kind: BlockKind; icon: string }[] = [
  {
    key: 'text',
    label: 'Text',
    kind: 'text',
    icon: lucide(
      '<path d="M12 4v16"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/>'
    )
  },
  {
    key: 'heading',
    label: 'Heading',
    kind: 'h2',
    icon: lucide(
      '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"/>'
    )
  },
  {
    key: 'todo',
    label: 'To-do list',
    kind: 'todo',
    icon: lucide('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>')
  },
  {
    key: 'bullet',
    label: 'Bulleted list',
    kind: 'bullet',
    icon: lucide(
      '<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/>'
    )
  },
  {
    key: 'number',
    label: 'Numbered list',
    kind: 'number',
    icon: lucide(
      '<path d="M11 5h10"/><path d="M11 12h10"/><path d="M11 19h10"/><path d="M4 4h1v5"/><path d="M4 9h2"/><path d="M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02"/>'
    )
  },
  {
    key: 'quote',
    label: 'Quote',
    kind: 'quote',
    icon: lucide('<path d="M17 5H3"/><path d="M21 12H8"/><path d="M21 19H8"/><path d="M3 12v7"/>')
  },
  {
    key: 'code',
    label: 'Code',
    kind: 'code',
    icon: lucide(
      '<path d="m10 9-3 3 3 3"/><path d="m14 15 3-3-3-3"/><rect x="3" y="3" width="18" height="18" rx="2"/>'
    )
  }
]
const DIVIDER_ICON = lucide('<path d="M5 12h14"/>')
const TOUCH_SUBPAGE_ICON = SUBPAGE_ICON.replace('<svg ', '<svg class="hm-page-icon" ')
const TOUCH_LINK_ICON = LINK_ICON.replace('<svg ', '<svg class="hm-page-icon" ')

/** The touch slash menu sits this far (px) from each side of the screen (M40). */
const SLASH_INSET = 12

/**
 * The layer on `<body>` that holds the touch slash menu: there it is fixed over the page screen
 * (which slides with a transform), and Crepe's desktop menu styles (`.milkdown ...`) do not reach
 * it. page-editor.css skins it.
 */
function slashLayer(): HTMLDivElement {
  const layer = document.createElement('div')
  layer.className = 'hm-slash-layer'
  document.body.append(layer)
  return layer
}

/**
 * Tells `onChange` when the slash menu in `layer` shows or hides (Crepe's `data-show`), and makes
 * the menu usable with VoiceOver. Crepe renders its items as plain `<li>`s that run on
 * `pointerup`, and a VoiceOver double-tap sends only a `click`. So each item list becomes a
 * `listbox` of `option`s (`aria-selected` from Crepe's `.hover`), and a click on an item that had
 * no `pointerup` just before it sends one, so Crepe runs the item.
 */
function watchSlashMenu(layer: HTMLElement, onChange: (open: boolean) => void): () => void {
  const label = (): void => {
    for (const list of layer.querySelectorAll<HTMLElement>('.menu-groups ul')) {
      list.setAttribute('role', 'listbox')
      const heading = list.previousElementSibling?.textContent?.trim()
      list.setAttribute('aria-label', heading ? `Insert a block: ${heading}` : 'Insert a block')
      for (const item of list.querySelectorAll<HTMLElement>(':scope > li')) {
        item.setAttribute('role', 'option')
        item.setAttribute('aria-selected', String(item.classList.contains('hover')))
      }
    }
  }
  const observer = new MutationObserver(() => {
    label()
    onChange(layer.querySelector('.milkdown-slash-menu[data-show="true"]') !== null)
  })
  observer.observe(layer, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-show', 'class']
  })
  let pointerUp = false
  const onPointerUp = (): void => {
    pointerUp = true
  }
  const onClick = (e: MouseEvent): void => {
    const had = pointerUp
    pointerUp = false
    const item =
      e.target instanceof Element ? e.target.closest('.menu-groups li[data-index]') : null
    if (!item || had) return
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    // The capture listener saw this `pointerup` too: it must not cover the next click.
    pointerUp = false
  }
  layer.addEventListener('pointerup', onPointerUp, true)
  layer.addEventListener('click', onClick)
  return () => {
    observer.disconnect()
    layer.removeEventListener('pointerup', onPointerUp, true)
    layer.removeEventListener('click', onClick)
  }
}

/**
 * The place of the touch slash menu (floating-ui middleware, fixed strategy): 12 from each side,
 * under or over the caret line (`slashMenuPlacement`), between the top of the page scroller and the
 * keyboard toolbar. The menu's list scrolls inside `--hm-slash-max`.
 */
function placeSlashMenu(
  caret: { y: number; height: number },
  menu: HTMLElement,
  root: HTMLElement
): { x: number; y: number } {
  const scroller = root.closest('[data-slot=page-scroll]') ?? root
  const bar = document.querySelector('[data-slot=keyboard-toolbar]')
  const vv = window.visualViewport
  const bottom = bar
    ? bar.getBoundingClientRect().top
    : vv
      ? vv.offsetTop + vv.height
      : window.innerHeight
  const place = slashMenuPlacement(
    { top: caret.y, bottom: caret.y + caret.height },
    { top: Math.max(0, scroller.getBoundingClientRect().top), bottom }
  )
  menu.dataset.side = place.side
  menu.style.setProperty('--hm-slash-max', `${place.maxHeight}px`)
  return { x: SLASH_INSET, y: place.y }
}

/**
 * The touch editor's block plugin (M39): marks the block at the caret (`hm-current-block`, shown
 * while the editor has the focus) and keeps the toolbar's block signals current.
 */
function touchBlocks(signals: SignalStore<EditorSignals>): ReturnType<typeof $prose> {
  return $prose(
    () =>
      new Plugin({
        key: new PluginKey('HM_TOUCH_BLOCKS'),
        props: {
          decorations: (state) => {
            const range = currentBlockRange(state)
            if (!range) return DecorationSet.empty
            return DecorationSet.create(state.doc, [
              Decoration.node(range.from, range.to, { class: 'hm-current-block' })
            ])
          }
        },
        view: (view) => {
          signals.set(blockSignals(view.state))
          return { update: (next) => signals.set(blockSignals(next.state)) }
        }
      })
  )
}

/**
 * What the touch editor offers to its page (`onReady`) and its keyboard toolbar. Commands keep the
 * focus in the editor when it was there, so the keyboard stays up.
 */
export interface PageEditorApi {
  /** Runs a ProseMirror command (`touch-editor.ts` has the block commands). True when it applied. */
  run: (command: Command) => boolean
  /** The y-prosemirror undo and redo: only this member's own edits. */
  undo: () => boolean
  redo: () => boolean
  /** The "+" tool: a "/" on an empty line at the caret, so the slash menu opens. */
  insertSlash: () => boolean
  /** Takes the focus out of the editor: the keyboard goes down, and the focus goes to More. */
  blur: () => void
  /** Gives the editor the focus. In a tap on iOS, the keyboard comes up. */
  focus: () => void
  /** The focus, the block at the caret and the slash menu, for `useSyncExternalStore`. */
  subscribe: (onChange: () => void) => () => void
  getSignals: () => EditorSignals
}

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

/**
 * Touch: a tap on a to-do box toggles it with no focus, so the keyboard stays down (M38). Crepe's
 * own box handler focuses the editor first. This capture listener on the editor root takes the
 * tap before it: `pointerdown` and `mousedown` are stopped (no Crepe toggle, no focus, no caret),
 * and `click` (a tap, not the start of a scroll) sets the item's `checked`.
 */
function taskBoxTap(getView: () => EditorView | null): (e: Event) => void {
  return (e) => {
    const view = getView()
    const target = e.target
    if (!view || !view.editable || !(target instanceof Element)) return
    const box = target.closest('.label-wrapper')
    const item = box?.closest('.milkdown-list-item-block')
    if (!box || !item || !view.dom.contains(item)) return
    if (!box.querySelector('.checked, .unchecked')) return
    e.preventDefault()
    e.stopPropagation()
    if (e.type !== 'click') return
    const content = item.querySelector('.content-dom')
    if (!content) return
    const $in = view.state.doc.resolve(view.posAtDOM(content, 0))
    for (let d = $in.depth; d > 0; d--) {
      const node = $in.node(d)
      if (node.type.name !== 'list_item') continue
      if (typeof node.attrs.checked !== 'boolean') return
      view.dispatch(view.state.tr.setNodeAttribute($in.before(d), 'checked', !node.attrs.checked))
      return
    }
  }
}

const TASK_TAP_EVENTS = ['pointerdown', 'mousedown', 'click'] as const

export interface PageEditorProps {
  handle: DocHandle
  /** False: read-only (no SEND_MESSAGES, or the doc is not live yet). */
  editable: boolean
  onOpenPage: (pageId: string) => void
  /** "New sub-page" in the slash menu: creates a child of this page. Resolves the new id and title. */
  onNewSubPage: () => Promise<{ id: string; title: string } | null>
  /**
   * `touch` (the phone's page screen, M38 to M40): no block handle and no selection toolbar, the
   * touch placeholder, the kit sizes (page-editor.css), a to-do tap that does not raise the
   * keyboard, the focus in `page-editor-state.ts`, the keyboard toolbar, the touch slash menu and
   * the page picker as a sheet. The page screen scrolls the editor with its hero.
   */
  variant?: 'panel' | 'touch'
  /** Touch only: the editor API once the editor is up, and null when it goes away. */
  onReady?: (api: PageEditorApi | null) => void
}

/** Where the "Link to page" picker opens (the desktop popover), and the editor ctx for the pick. */
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
  onNewSubPage,
  variant = 'panel',
  onReady
}: PageEditorProps): React.JSX.Element {
  const touch = variant === 'touch'
  const platform = usePlatform()
  const rootRef = useRef<HTMLDivElement>(null)
  const crepeRef = useRef<Crepe | null>(null)
  const [pickAt, setPickAt] = useState<PickAt | null>(null)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [api, setApi] = useState<PageEditorApi | null>(null)
  // The editor lives longer than one render; it calls the newest callbacks.
  const live = useRef({ onOpenPage, onNewSubPage, editable, onReady, platform })
  useLayoutEffect(() => {
    live.current = { onOpenPage, onNewSubPage, editable, onReady, platform }
  })

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let destroyed = false
    const getView = (): EditorView | null =>
      crepeRef.current ? crepeRef.current.editor.action((ctx) => ctx.get(editorViewCtx)) : null
    const onKeyDown = editorKeyCapture(getView)
    root.addEventListener('keydown', onKeyDown, true)
    const onTaskTap = touch ? taskBoxTap(getView) : null
    if (onTaskTap) for (const type of TASK_TAP_EVENTS) root.addEventListener(type, onTaskTap, true)
    const stopFocus = touch ? trackEditorFocus(root) : null
    // Touch: the toolbar's signals, and the layer of the slash menu.
    const signals = touch ? signalStore<EditorSignals>(NO_SIGNALS) : null
    const layer = touch ? slashLayer() : null
    const stopSignals = [
      signals && usePageEditorState.subscribe((st) => signals.set({ focused: st.focused })),
      signals && layer && watchSlashMenu(layer, (open) => signals.set({ slash: open }))
    ]
    const newSubPage = (ctx: Ctx): void => {
      ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key)
      void live.current.onNewSubPage().then((page) => {
        if (!page || destroyed) return
        insertPageLink(ctx.get(editorViewCtx), ctx, page.id, page.title)
      })
    }
    /** A touch slash item: the "/" text goes, then the block changes. */
    const touchBlock =
      (kind: BlockKind) =>
      (ctx: Ctx): void => {
        ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key)
        const view = ctx.get(editorViewCtx)
        turnInto(kind)(view.state, view.dispatch, view)
        live.current.platform.haptic('light')
      }
    const crepe = new Crepe({
      root,
      features: {
        [Crepe.Feature.ImageBlock]: false,
        [Crepe.Feature.TopBar]: false,
        // The selection toolbar sits over the text under a finger; the keyboard toolbar does it.
        ...(touch ? { [Crepe.Feature.Toolbar]: false } : {})
      },
      featureConfigs: {
        // Crepe's default CodeMirror theme is oneDark: light grey text (#abb2bf) that, on the
        // light theme, sits on our light code surface and reads as disabled. null keeps it out
        // (Crepe fills only undefined options), so code and LaTeX source use the page ink.
        [Crepe.Feature.CodeMirror]: document.documentElement.classList.contains('dark')
          ? {}
          : { theme: null as never },
        [Crepe.Feature.Placeholder]: {
          text: touch ? 'Tap to write, / for blocks' : 'Type / for blocks and page links',
          mode: 'block'
        },
        [Crepe.Feature.BlockEdit]: layer
          ? {
              // Touch (M40): "Basic blocks" and "In Hachiman" only, in the layer on <body>.
              textGroup: null,
              listGroup: null,
              advancedGroup: null,
              slashMenu: {
                root: layer,
                floatingUIOptions: {
                  strategy: 'fixed',
                  placement: 'bottom-start',
                  middleware: [
                    {
                      name: 'hmTouchSlash',
                      fn: ({ rects, elements }) =>
                        placeSlashMenu(rects.reference, elements.floating, root)
                    }
                  ]
                }
              },
              buildMenu: (builder) => {
                const basic = builder.addGroup('basic', 'Basic blocks')
                for (const block of TOUCH_BLOCKS)
                  basic.addItem(block.key, {
                    label: block.label,
                    icon: block.icon,
                    onRun: touchBlock(block.kind)
                  })
                basic.addItem('divider', {
                  label: 'Divider',
                  icon: DIVIDER_ICON,
                  onRun: (ctx: Ctx) => {
                    const commands = ctx.get(commandsCtx)
                    commands.call(clearTextInCurrentBlockCommand.key)
                    commands.call(addBlockTypeCommand.key, { nodeType: hrSchema.type(ctx) })
                    live.current.platform.haptic('light')
                  }
                })
                builder
                  .addGroup('hachiman', 'In Hachiman')
                  .addItem('new-subpage', {
                    label: 'New sub-page',
                    icon: TOUCH_SUBPAGE_ICON,
                    onRun: newSubPage
                  })
                  .addItem('link-page', {
                    label: 'Link to page',
                    icon: TOUCH_LINK_ICON,
                    onRun: (ctx: Ctx) => {
                      ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key)
                      // A sync render, so the sheet can take the focus in this tap (keyboard up).
                      flushSync(() => setPickAt({ ctx, left: 0, top: 0 }))
                    }
                  })
              }
            }
          : {
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
                    onRun: newSubPage
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
    if (signals) {
      crepe.editor
        // The caret keeps clear of the keyboard toolbar that lies over the bottom of the page.
        .config((ctx) =>
          ctx.update(editorViewOptionsCtx, (prev) => ({
            ...prev,
            scrollMargin: { top: 12, bottom: KEYBOARD_TOOLBAR_HEIGHT + 16, left: 0, right: 0 }
          }))
        )
        .use(touchBlocks(signals))
    }
    let ready: PageEditorApi | null = null
    const created = crepe.create().then(() => {
      if (destroyed) return
      crepe.editor.action((ctx) => {
        ctx.get(collabServiceCtx).bindDoc(handle.doc).setAwareness(handle.awareness).connect()
      })
      crepe.setReadonly(!live.current.editable)
      crepeRef.current = crepe
      docsService.setMarkdownSource(handle.pageId, () => crepe.getMarkdown())
      if (!signals) return
      ready = touchApi(
        crepe.editor.action((ctx) => ctx.get(editorViewCtx)),
        root,
        signals
      )
      setApi(ready)
      live.current.onReady?.(ready)
    })
    created.catch((e) => console.warn('[pages] editor create failed', e))

    return () => {
      destroyed = true
      root.removeEventListener('keydown', onKeyDown, true)
      if (onTaskTap)
        for (const type of TASK_TAP_EVENTS) root.removeEventListener(type, onTaskTap, true)
      stopFocus?.()
      for (const stop of stopSignals) if (stop) stop()
      crepeRef.current = null
      setPickAt(null)
      setMediaError(null)
      setApi(null)
      if (ready) live.current.onReady?.(null)
      docsService.setMarkdownSource(handle.pageId, null)
      void created
        .then(() => crepe.destroy())
        .catch((e) => console.warn('[pages] editor destroy failed', e))
        .finally(() => layer?.remove())
    }
  }, [handle, touch])

  useEffect(() => {
    crepeRef.current?.setReadonly(!editable)
  }, [editable])

  // The keyboard shrinks the screen and leaves the page scroller where it was: a caret in the
  // lower part of the page ends up under the keyboard. Scroll it into view once the keyboard is up.
  const keyboardOpen = useKeyboardOpen()
  useEffect(() => {
    if (!touch || !keyboardOpen) return
    const frame = requestAnimationFrame(() => {
      const view = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx))
      if (view?.hasFocus()) view.dispatch(view.state.tr.scrollIntoView())
    })
    return () => cancelAnimationFrame(frame)
  }, [touch, keyboardOpen])

  /** The "@" tool: the page picker sheet, mounted in the tap so it can take the focus. */
  const openLinkPicker = (): void => {
    const crepe = crepeRef.current
    if (crepe) flushSync(() => setPickAt({ ctx: crepe.editor.ctx, left: 0, top: 0 }))
  }

  return (
    <div
      data-variant={touch ? 'touch' : undefined}
      className={cn('hm-page-editor', touch ? 'shrink-0' : 'min-h-0 flex-1 overflow-y-auto')}
    >
      {mediaError && (
        <div className="bg-destructive/10 text-destructive sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 text-xs">
          <span className="flex-1">{mediaError}</span>
          <button type="button" className="underline" onClick={() => setMediaError(null)}>
            Dismiss
          </button>
        </div>
      )}
      <div ref={rootRef} className={cn('mx-auto w-full max-w-3xl', touch ? 'pt-3' : 'px-2 py-4')} />
      {touch && editable && api && <PageKeyboardToolbar api={api} onLinkPage={openLinkPicker} />}
      {touch ? (
        <PagePicker
          variant="sheet"
          open={pickAt !== null}
          excludeId={handle.pageId}
          onPick={(page) => {
            const at = pickAt
            // Close in a sync render first: the sheet's focus trap lets go, so the link's
            // `view.focus()` lands in this tap and iOS keeps the keyboard up.
            flushSync(() => setPickAt(null))
            if (at && crepeRef.current)
              insertPageLink(at.ctx.get(editorViewCtx), at.ctx, page.id, page.title)
          }}
          onClose={() => setPickAt(null)}
        />
      ) : (
        pickAt && (
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
        )
      )}
    </div>
  )
}

/** The API of a touch editor over its view. */
function touchApi(
  view: EditorView,
  root: HTMLElement,
  signals: SignalStore<EditorSignals>
): PageEditorApi {
  /** Runs `act`; a focus that was in the editor stays there (a block change can drop it). */
  const keepFocus = (act: () => boolean): boolean => {
    const had = root.contains(document.activeElement)
    const ok = act()
    if (had && !root.contains(document.activeElement)) view.focus()
    return ok
  }
  return {
    run: (command) => keepFocus(() => command(view.state, view.dispatch, view)),
    undo: () => keepFocus(() => yUndo(view.state)),
    redo: () => keepFocus(() => yRedo(view.state)),
    insertSlash: () => {
      const ok = insertSlash(view.state, view.dispatch, view)
      // A code block keeps the focus in CodeMirror: the "/" line is outside it.
      if (ok && !view.hasFocus()) view.focus()
      return ok
    },
    blur: () => blurPageEditor({ focusMore: true }),
    focus: () => view.focus(),
    subscribe: signals.subscribe,
    getSignals: signals.get
  }
}
