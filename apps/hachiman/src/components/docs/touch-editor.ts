import { lift, setBlockType, wrapIn } from '@milkdown/kit/prose/commands'
import type { Node, ResolvedPos } from '@milkdown/kit/prose/model'
import { liftListItem, sinkListItem, wrapInList } from '@milkdown/kit/prose/schema-list'
import {
  EditorState,
  TextSelection,
  type Command,
  type Transaction
} from '@milkdown/kit/prose/state'
import { StepMap } from '@milkdown/kit/prose/transform'

/*
 * The pure parts of the touch page editor (docs/ios-mobile-ui-spec.md F3a, M39 and M40): the block
 * at the caret, "turn into", the toolbar's list toggles, the "/" line of the "+" tool, the current
 * block mark and the place of the slash menu. The commands look up the node types by the names of
 * the Milkdown commonmark and GFM schema, so they also run on a small test schema.
 */

const PARAGRAPH = 'paragraph'
const HEADING = 'heading'
const QUOTE = 'blockquote'
const CODE = 'code_block'
const BULLET_LIST = 'bullet_list'
const ORDERED_LIST = 'ordered_list'
const LIST_ITEM = 'list_item'

/** A block form that the toolbar and the turn-into sheet set. */
export type BlockKind =
  'text' | 'h1' | 'h2' | 'h3' | 'quote' | 'code' | 'todo' | 'bullet' | 'number'

/** The form of the block at the caret. `other`: none of the kinds (a deeper heading, an image). */
export type BlockAt = BlockKind | 'other'

const LIST_KINDS: readonly BlockAt[] = ['todo', 'bullet', 'number']

const HEADING_KINDS: Record<number, BlockKind> = { 1: 'h1', 2: 'h2', 3: 'h3' }

/** Lifts out of nested lists and quotes; more than this is a broken document. */
const MAX_UNWRAP = 16

const inTable = ($pos: ResolvedPos): boolean => {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name.startsWith('table')) return true
  return false
}

/** The depth of the nearest list item or quote around the textblock at `$pos`, or -1. */
function containerDepth($pos: ResolvedPos): number {
  for (let d = $pos.depth - 1; d > 0; d--) {
    const name = $pos.node(d).type.name
    if (name === LIST_ITEM || name === QUOTE) return d
  }
  return -1
}

/** The depth of the innermost list item around `$pos`, or -1. */
function itemDepth($pos: ResolvedPos): number {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === LIST_ITEM) return d
  return -1
}

const isTodo = (item: Node): boolean => typeof item.attrs.checked === 'boolean'

/** The form of the block that holds the caret. */
export function blockAt(state: EditorState): BlockAt {
  const sel = state.selection
  if (!(sel instanceof TextSelection)) return 'other'
  const { $head } = sel
  const block = $head.parent
  if (!block.isTextblock || inTable($head)) return 'other'
  if (block.type.name === CODE) return 'code'
  if (block.type.name === HEADING) return HEADING_KINDS[Number(block.attrs.level)] ?? 'other'
  if (block.type.name !== PARAGRAPH) return 'other'
  const d = containerDepth($head)
  if (d < 0) return 'text'
  const container = $head.node(d)
  if (container.type.name === QUOTE) return 'quote'
  if (isTodo(container)) return 'todo'
  return $head.node(d - 1).type.name === ORDERED_LIST ? 'number' : 'bullet'
}

/**
 * Runs commands one after another on a plain copy of a state (no plugins, so no appended
 * transactions), and collects their steps into one transaction on the real state: one undo step,
 * one update to the other members.
 */
class Chain {
  private state: EditorState
  readonly tr: Transaction

  constructor(state: EditorState) {
    this.tr = state.tr
    this.state = EditorState.create({ doc: state.doc, selection: state.selection })
  }

  get $head(): ResolvedPos {
    return this.state.selection.$head
  }

  run(command: Command): boolean {
    return command(this.state, (t) => {
      for (const step of t.steps) this.tr.step(step)
      this.state = this.state.apply(t)
    })
  }

  /** The transaction with the selection of the last command. */
  done(): Transaction {
    return this.tr.setSelection(this.state.selection.map(this.tr.doc, StepMap.empty))
  }
}

const setItemChecked =
  (checked: boolean | null): Command =>
  (state, dispatch) => {
    const { $head } = state.selection
    const d = itemDepth($head)
    if (d < 0 || !('checked' in ($head.node(d).type.spec.attrs ?? {}))) return false
    dispatch?.(state.tr.setNodeAttribute($head.before(d), 'checked', checked))
    return true
  }

/**
 * Makes the list around the caret a bullet or a numbered list, in place (the whole list). Milkdown
 * keeps `listType` and `label` on each item: a bullet list whose first item says "ordered" turns
 * back into a numbered list (its sync plugin), so the items change with the list.
 */
const setListType =
  (name: typeof BULLET_LIST | typeof ORDERED_LIST): Command =>
  (state, dispatch) => {
    const { $head } = state.selection
    const d = itemDepth($head)
    const type = state.schema.nodes[name]
    if (d < 1 || !type) return false
    const list = $head.node(d - 1)
    if (list.type === type) return true
    const at = $head.before(d - 1)
    const tr = state.tr.setNodeMarkup(at, type, { spread: list.attrs.spread })
    const ordered = name === ORDERED_LIST
    list.forEach((item, offset, index) => {
      const attrs = item.type.spec.attrs ?? {}
      if (!('listType' in attrs)) return
      tr.setNodeMarkup(at + 1 + offset, null, {
        ...item.attrs,
        listType: ordered ? 'ordered' : 'bullet',
        label: ordered ? `${index + 1}.` : '•'
      })
    })
    dispatch?.(tr)
    return true
  }

/** Lifts the textblock at the caret out of every list and quote around it. */
function unwrap(chain: Chain): boolean {
  for (let i = 0; i < MAX_UNWRAP; i++) {
    const { $head } = chain
    const d = containerDepth($head)
    if (d < 0) return true
    const container = $head.node(d)
    const ok =
      container.type.name === LIST_ITEM ? chain.run(liftListItem(container.type)) : chain.run(lift)
    if (!ok) return false
  }
  return false
}

/** Makes the textblock at the caret a paragraph (headings and code keep their text). */
function toParagraph(chain: Chain, state: EditorState): boolean {
  const paragraph = state.schema.nodes[PARAGRAPH]
  if (!paragraph) return false
  if (chain.$head.parent.type === paragraph) return true
  return chain.run(setBlockType(paragraph))
}

/**
 * Turns the block at the caret into `kind` (the turn-into sheet, the slash menu). A list item
 * changes in place to another list kind. Any other change first lifts the block out of its lists
 * and quotes, so each kind is the plain form: "Text" in a quote or a list is a plain paragraph.
 */
export function turnInto(kind: BlockKind): Command {
  return (state, dispatch) => {
    const at = blockAt(state)
    if (at === kind) return true
    if (inTable(state.selection.$head) || !(state.selection instanceof TextSelection)) return false
    const chain = new Chain(state)
    const nodes = state.schema.nodes

    if (LIST_KINDS.includes(at) && LIST_KINDS.includes(kind)) {
      if (kind === 'todo') {
        if (!chain.run(setItemChecked(false))) return false
      } else {
        if (at === 'todo' && !chain.run(setItemChecked(null))) return false
        if (!chain.run(setListType(kind === 'bullet' ? BULLET_LIST : ORDERED_LIST))) return false
      }
      dispatch?.(chain.done().scrollIntoView())
      return true
    }

    if (!unwrap(chain)) return false
    let ok: boolean
    switch (kind) {
      case 'text':
        ok = toParagraph(chain, state)
        break
      case 'h1':
      case 'h2':
      case 'h3':
        ok = !!nodes[HEADING] && chain.run(setBlockType(nodes[HEADING], { level: Number(kind[1]) }))
        break
      case 'code':
        ok = !!nodes[CODE] && chain.run(setBlockType(nodes[CODE]))
        break
      case 'quote':
        ok = toParagraph(chain, state) && !!nodes[QUOTE] && chain.run(wrapIn(nodes[QUOTE]))
        break
      case 'bullet':
      case 'number': {
        const list = nodes[kind === 'bullet' ? BULLET_LIST : ORDERED_LIST]
        ok = toParagraph(chain, state) && !!list && chain.run(wrapInList(list))
        break
      }
      case 'todo': {
        const list = nodes[BULLET_LIST]
        ok =
          toParagraph(chain, state) &&
          !!list &&
          chain.run(wrapInList(list)) &&
          chain.run(setItemChecked(false))
        break
      }
    }
    if (!ok) return false
    dispatch?.(chain.done().scrollIntoView())
    return true
  }
}

/** A toolbar list tool: the kind, or plain text when the block is that kind already (M39). */
export function toggleKind(kind: 'todo' | 'bullet' | 'number'): Command {
  return (state, dispatch) => turnInto(blockAt(state) === kind ? 'text' : kind)(state, dispatch)
}

/** Indent: the list item at the caret goes under the item above it. */
export const indentItem: Command = (state, dispatch) => {
  const item = state.schema.nodes[LIST_ITEM]
  return !!item && sinkListItem(item)(state, dispatch)
}

/**
 * The "+" tool: a "/" on an empty line, so the slash menu opens (M40). An empty paragraph out of a
 * list takes it in place. Else a new paragraph goes after the top-level block at the caret: the
 * slash menu does not open in a list or a code block.
 */
export const insertSlash: Command = (state, dispatch) => {
  const paragraph = state.schema.nodes[PARAGRAPH]
  if (!paragraph) return false
  const sel = state.selection
  const { $head } = sel
  const block = $head.parent
  if (
    sel instanceof TextSelection &&
    sel.empty &&
    block.type === paragraph &&
    block.content.size === 0 &&
    itemDepth($head) < 0
  ) {
    dispatch?.(state.tr.insertText('/', $head.pos).scrollIntoView())
    return true
  }
  const at = $head.depth > 0 ? $head.after(1) : $head.pos
  const tr = state.tr.insert(at, paragraph.create(null, state.schema.text('/')))
  dispatch?.(tr.setSelection(TextSelection.create(tr.doc, at + 2)).scrollIntoView())
  return true
}

/** The "+" tool while the slash menu shows: takes the "/" and the filter text back out. */
export const clearSlash: Command = (state, dispatch) => {
  const { $head } = state.selection
  if (!$head.parent.isTextblock) return false
  const text = $head.parent.textBetween(0, $head.parentOffset, undefined, '￼')
  if (!text.startsWith('/')) return false
  dispatch?.(state.tr.delete($head.start(), $head.pos))
  return true
}

/**
 * The block that the touch editor marks as current (`hm-current-block`, M39): the list item of a
 * to-do or list line (box and text), else the textblock. Null in a table and for a node selection.
 */
export function currentBlockRange(state: EditorState): { from: number; to: number } | null {
  const sel = state.selection
  if (!(sel instanceof TextSelection)) return null
  const { $head } = sel
  const d = $head.depth
  if (d === 0 || !$head.parent.isTextblock || inTable($head)) return null
  const parent = $head.node(d - 1)
  if (parent.type.name === LIST_ITEM && parent.childCount === 1)
    return { from: $head.before(d - 1), to: $head.after(d - 1) }
  return { from: $head.before(d), to: $head.after(d) }
}

/** What the keyboard toolbar shows: the lit tools, the indent tool, the "+" tool. */
export interface EditorSignals {
  /** The focus is in the editor (`page-editor-state`). */
  focused: boolean
  kind: BlockAt
  canIndent: boolean
  /** The slash menu shows. */
  slash: boolean
}

export const NO_SIGNALS: EditorSignals = {
  focused: false,
  kind: 'other',
  canIndent: false,
  slash: false
}

/** The block signals of a state (the focus and the slash menu come from elsewhere). */
export function blockSignals(state: EditorState): Pick<EditorSignals, 'kind' | 'canIndent'> {
  return { kind: blockAt(state), canIndent: indentItem(state) }
}

/** A tiny external store for `useSyncExternalStore`: a new snapshot only when a field changes. */
export interface SignalStore<T extends object> {
  get: () => T
  set: (patch: Partial<T>) => void
  subscribe: (onChange: () => void) => () => void
}

export function signalStore<T extends object>(initial: T): SignalStore<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (patch) => {
      const keys = Object.keys(patch) as (keyof T)[]
      if (keys.every((k) => Object.is(value[k], patch[k]))) return
      value = { ...value, ...patch }
      for (const fn of listeners) fn()
    },
    subscribe: (onChange) => {
      listeners.add(onChange)
      return () => {
        listeners.delete(onChange)
      }
    }
  }
}

/** Space (px) between the caret line and the slash menu. */
export const SLASH_GAP = 10
/** Space (px) between the slash menu and the toolbar, or the top of the page. */
export const SLASH_MARGIN = 8
/** Room (px) under the caret that keeps the menu below it: a label and three 46 rows. */
export const SLASH_MIN_BELOW = 3 * 46 + 30

export interface SlashPlacement {
  /** `top`: the menu ends above the caret line (its bottom edge at `y`). */
  side: 'bottom' | 'top'
  y: number
  maxHeight: number
}

/**
 * Where the touch slash menu goes (M40): under the caret line when three rows fit there or when
 * there is more room below than above, else above it. It never goes under the toolbar (the
 * `bounds.bottom`) or over the nav bar (the `bounds.top`); the list scrolls inside.
 */
export function slashMenuPlacement(
  caret: { top: number; bottom: number },
  bounds: { top: number; bottom: number }
): SlashPlacement {
  const below = bounds.bottom - SLASH_MARGIN - (caret.bottom + SLASH_GAP)
  const above = caret.top - SLASH_GAP - (bounds.top + SLASH_MARGIN)
  if (below >= SLASH_MIN_BELOW || below >= above)
    return { side: 'bottom', y: caret.bottom + SLASH_GAP, maxHeight: Math.max(0, below) }
  return { side: 'top', y: caret.top - SLASH_GAP, maxHeight: Math.max(0, above) }
}
