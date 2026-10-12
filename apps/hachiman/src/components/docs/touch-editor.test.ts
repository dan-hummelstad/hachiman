import { Schema, type Node } from '@milkdown/kit/prose/model'
import { EditorState, NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import { describe, expect, it, vi } from 'vitest'
import {
  NO_SIGNALS,
  SLASH_GAP,
  SLASH_MARGIN,
  blockAt,
  blockSignals,
  clearSlash,
  currentBlockRange,
  indentItem,
  insertSlash,
  signalStore,
  slashMenuPlacement,
  toggleKind,
  turnInto
} from './touch-editor'

/** The node names and list attributes of the Milkdown commonmark and GFM schema. */
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
    blockquote: { group: 'block', content: 'block+' },
    code_block: {
      group: 'block',
      content: 'text*',
      marks: '',
      code: true,
      attrs: { language: { default: '' } }
    },
    hr: { group: 'block' },
    bullet_list: { group: 'block', content: 'list_item+', attrs: { spread: { default: false } } },
    ordered_list: {
      group: 'block',
      content: 'list_item+',
      attrs: { order: { default: 1 }, spread: { default: false } }
    },
    list_item: {
      content: 'paragraph block*',
      defining: true,
      attrs: {
        label: { default: '•' },
        listType: { default: 'bullet' },
        spread: { default: true },
        checked: { default: null }
      }
    },
    table: { group: 'block', content: 'table_row+' },
    table_row: { content: 'table_cell+' },
    table_cell: { content: 'paragraph' },
    text: { group: 'inline' }
  }
})

const n = schema.nodes
const p = (text = ''): Node => n.paragraph!.create(null, text ? schema.text(text) : null)
const h = (level: number, text: string): Node => n.heading!.create({ level }, schema.text(text))
const item = (text: string, checked: boolean | null = null, ...rest: Node[]): Node =>
  n.list_item!.create({ checked }, [p(text), ...rest])
const bullets = (...items: Node[]): Node => n.bullet_list!.create(null, items)
const numbers = (...items: Node[]): Node =>
  n.ordered_list!.create(
    null,
    items.map((it, i) =>
      it.type.create({ ...it.attrs, listType: 'ordered', label: `${i + 1}.` }, it.content)
    )
  )

/** A state with the caret at the end of the first text that is `text`. */
function at(doc: Node, text: string, offset = text.length): EditorState {
  let pos = -1
  doc.descendants((node, nodePos) => {
    if (pos >= 0) return false
    if (node.isTextblock && node.textContent === text) pos = nodePos + 1 + offset
    return true
  })
  if (pos < 0) throw new Error(`no block "${text}"`)
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) })
}

function run(
  state: EditorState,
  command: (
    s: EditorState,
    d?: (tr: import('@milkdown/kit/prose/state').Transaction) => void
  ) => boolean
): EditorState {
  let next = state
  const ok = command(state, (tr) => {
    next = state.apply(tr)
  })
  expect(ok).toBe(true)
  return next
}

/** The doc as a short outline: "type(child, child)" and "'text'". */
function outline(node: Node): string {
  if (node.isText) return `'${node.text ?? ''}'`
  let name = node.type.name
  if (name === 'heading') name += node.attrs.level
  if (name === 'list_item' && typeof node.attrs.checked === 'boolean')
    name = node.attrs.checked ? 'done' : 'todo'
  const kids: string[] = []
  node.forEach((child) => kids.push(outline(child)))
  return kids.length ? `${name}(${kids.join(', ')})` : name
}

const doc = (...blocks: Node[]): Node => n.doc!.create(null, blocks)

describe('blockAt', () => {
  it('names each block form', () => {
    const d = doc(
      p('para'),
      h(2, 'head'),
      h(5, 'deep'),
      n.blockquote!.create(null, [p('quoted')]),
      n.code_block!.create(null, schema.text('code')),
      bullets(item('bullet')),
      numbers(item('number')),
      bullets(item('task', false))
    )
    expect(blockAt(at(d, 'para'))).toBe('text')
    expect(blockAt(at(d, 'head'))).toBe('h2')
    expect(blockAt(at(d, 'deep'))).toBe('other')
    expect(blockAt(at(d, 'quoted'))).toBe('quote')
    expect(blockAt(at(d, 'code'))).toBe('code')
    expect(blockAt(at(d, 'bullet'))).toBe('bullet')
    expect(blockAt(at(d, 'number'))).toBe('number')
    expect(blockAt(at(d, 'task'))).toBe('todo')
  })

  it('is other for a node selection and in a table', () => {
    const d = doc(
      p('a'),
      n.hr!.create(),
      n.table!.create(null, [n.table_row!.create(null, [n.table_cell!.create(null, [p('cell')])])])
    )
    expect(blockAt(EditorState.create({ doc: d, selection: NodeSelection.create(d, 3) }))).toBe(
      'other'
    )
    expect(blockAt(at(d, 'cell'))).toBe('other')
  })
})

describe('turnInto', () => {
  it('sets a paragraph to each kind', () => {
    const s = at(doc(p('x')), 'x')
    expect(outline(run(s, turnInto('h1')).doc)).toBe("doc(heading1('x'))")
    expect(outline(run(s, turnInto('h3')).doc)).toBe("doc(heading3('x'))")
    expect(outline(run(s, turnInto('code')).doc)).toBe("doc(code_block('x'))")
    expect(outline(run(s, turnInto('quote')).doc)).toBe("doc(blockquote(paragraph('x')))")
    expect(outline(run(s, turnInto('bullet')).doc)).toBe(
      "doc(bullet_list(list_item(paragraph('x'))))"
    )
    expect(outline(run(s, turnInto('number')).doc)).toBe(
      "doc(ordered_list(list_item(paragraph('x'))))"
    )
    expect(outline(run(s, turnInto('todo')).doc)).toBe("doc(bullet_list(todo(paragraph('x'))))")
  })

  it('keeps the caret in the block', () => {
    const next = run(at(doc(p('hello')), 'hello', 2), turnInto('todo'))
    expect(next.selection.$head.parent.textContent).toBe('hello')
    expect(next.selection.$head.parentOffset).toBe(2)
  })

  it('makes one transaction of the whole change', () => {
    const s = at(doc(n.blockquote!.create(null, [h(2, 'x')])), 'x')
    const dispatch = vi.fn()
    expect(turnInto('todo')(s, dispatch)).toBe(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(outline(s.apply(dispatch.mock.calls[0]![0]).doc)).toBe(
      "doc(bullet_list(todo(paragraph('x'))))"
    )
  })

  it('lifts a block out of its lists and quotes for a non-list kind', () => {
    const nested = doc(bullets(item('outer', null, bullets(item('inner')))))
    expect(outline(run(at(nested, 'inner'), turnInto('text')).doc)).toBe(
      "doc(bullet_list(list_item(paragraph('outer'))), paragraph('inner'))"
    )
    const quoted = doc(n.blockquote!.create(null, [p('q')]))
    expect(outline(run(at(quoted, 'q'), turnInto('h2')).doc)).toBe("doc(heading2('q'))")
    expect(outline(run(at(doc(h(1, 't')), 't'), turnInto('text')).doc)).toBe("doc(paragraph('t'))")
  })

  it('changes a list item to another list kind in place', () => {
    const list = doc(numbers(item('a'), item('b')))
    expect(outline(run(at(list, 'b'), turnInto('todo')).doc)).toBe(
      "doc(ordered_list(list_item(paragraph('a')), todo(paragraph('b'))))"
    )
    const asBullets = run(at(list, 'b'), turnInto('bullet')).doc
    expect(outline(asBullets)).toBe(
      "doc(bullet_list(list_item(paragraph('a')), list_item(paragraph('b'))))"
    )
    // Milkdown's list sync turns a bullet list whose items say "ordered" back: the items change too.
    asBullets.firstChild!.forEach((it) =>
      expect(it.attrs).toMatchObject({ listType: 'bullet', label: '•' })
    )

    const tasks = doc(bullets(item('a', true), item('b', false)))
    const numbered = run(at(tasks, 'b'), turnInto('number')).doc
    expect(outline(numbered)).toBe(
      "doc(ordered_list(done(paragraph('a')), list_item(paragraph('b'))))"
    )
    expect(numbered.firstChild!.child(1).attrs).toMatchObject({ listType: 'ordered', label: '2.' })
  })

  it('does nothing for the same kind, and fails in a table', () => {
    const s = at(doc(h(2, 'x')), 'x')
    const dispatch = vi.fn()
    expect(turnInto('h2')(s, dispatch)).toBe(true)
    expect(dispatch).not.toHaveBeenCalled()
    const table = doc(
      n.table!.create(null, [n.table_row!.create(null, [n.table_cell!.create(null, [p('cell')])])])
    )
    expect(turnInto('bullet')(at(table, 'cell'), dispatch)).toBe(false)
  })
})

describe('toggleKind', () => {
  it('turns the kind on, and off again to text', () => {
    const on = run(at(doc(p('x')), 'x'), toggleKind('todo'))
    expect(blockAt(on)).toBe('todo')
    const off = run(on, toggleKind('todo'))
    expect(outline(off.doc)).toBe("doc(paragraph('x'))")
  })

  it('switches between list kinds', () => {
    const s = at(doc(bullets(item('x'))), 'x')
    expect(blockAt(run(s, toggleKind('number')))).toBe('number')
    expect(blockAt(run(s, toggleKind('todo')))).toBe('todo')
    expect(outline(run(s, toggleKind('bullet')).doc)).toBe("doc(paragraph('x'))")
  })
})

describe('indentItem', () => {
  it('sinks a list item under the one above, not the first one', () => {
    const d = doc(bullets(item('a'), item('b')))
    expect(indentItem(at(d, 'a'))).toBe(false)
    expect(outline(run(at(d, 'b'), indentItem).doc)).toBe(
      "doc(bullet_list(list_item(paragraph('a'), bullet_list(list_item(paragraph('b'))))))"
    )
    expect(indentItem(at(doc(p('x')), 'x'))).toBe(false)
  })
})

describe('insertSlash and clearSlash', () => {
  it('types "/" on an empty line', () => {
    const next = run(at(doc(p('a'), p()), ''), insertSlash)
    expect(outline(next.doc)).toBe("doc(paragraph('a'), paragraph('/'))")
    expect(next.selection.$head.parentOffset).toBe(1)
  })

  it('adds a "/" line after the top-level block of a full line or a list', () => {
    const full = run(at(doc(p('abc'), p('z')), 'abc', 1), insertSlash)
    expect(outline(full.doc)).toBe("doc(paragraph('abc'), paragraph('/'), paragraph('z'))")
    expect(full.selection.$head.parent.textContent).toBe('/')
    expect(full.selection.$head.parentOffset).toBe(1)

    const list = run(at(doc(bullets(item('a'), item(''))), ''), insertSlash)
    expect(outline(list.doc)).toBe(
      "doc(bullet_list(list_item(paragraph('a')), list_item(paragraph)), paragraph('/'))"
    )
    expect(list.selection.$head.parent.textContent).toBe('/')
  })

  it('takes the slash and its filter back', () => {
    const s = at(doc(p('/head')), '/head')
    expect(outline(run(s, clearSlash).doc)).toBe('doc(paragraph)')
    expect(clearSlash(at(doc(p('text')), 'text'))).toBe(false)
  })
})

describe('currentBlockRange', () => {
  it('marks the list item of a one-line item, else the textblock', () => {
    const d = doc(p('para'), bullets(item('one'), item('two', null, p('more'))))
    const para = currentBlockRange(at(d, 'para'))!
    expect(d.nodeAt(para.from)?.textContent).toBe('para')
    const one = currentBlockRange(at(d, 'one'))!
    expect(d.nodeAt(one.from)?.type.name).toBe('list_item')
    expect(one.to - one.from).toBe(d.nodeAt(one.from)!.nodeSize)
    const two = currentBlockRange(at(d, 'two'))!
    expect(d.nodeAt(two.from)?.type.name).toBe('paragraph')
  })

  it('is null in a table and for a node selection', () => {
    const d = doc(
      p('a'),
      n.hr!.create(),
      n.table!.create(null, [n.table_row!.create(null, [n.table_cell!.create(null, [p('cell')])])])
    )
    expect(currentBlockRange(at(d, 'cell'))).toBeNull()
    expect(
      currentBlockRange(EditorState.create({ doc: d, selection: NodeSelection.create(d, 3) }))
    ).toBeNull()
  })
})

describe('blockSignals', () => {
  it('names the block and whether indent applies', () => {
    const d = doc(bullets(item('a'), item('b')))
    expect(blockSignals(at(d, 'b'))).toEqual({ kind: 'bullet', canIndent: true })
    expect(blockSignals(at(d, 'a'))).toEqual({ kind: 'bullet', canIndent: false })
  })
})

describe('signalStore', () => {
  it('notifies and makes a new snapshot only on a change', () => {
    const store = signalStore(NO_SIGNALS)
    const fn = vi.fn()
    const stop = store.subscribe(fn)
    const first = store.get()
    store.set({ kind: 'other', slash: false })
    expect(fn).not.toHaveBeenCalled()
    expect(store.get()).toBe(first)
    store.set({ kind: 'todo' })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(store.get()).toEqual({ ...NO_SIGNALS, kind: 'todo' })
    stop()
    store.set({ slash: true })
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('slashMenuPlacement', () => {
  const bounds = { top: 106, bottom: 472 }

  it('goes under the caret line while three rows fit there (M40)', () => {
    const place = slashMenuPlacement({ top: 140, bottom: 160 }, bounds)
    expect(place).toEqual({
      side: 'bottom',
      y: 160 + SLASH_GAP,
      maxHeight: 472 - SLASH_MARGIN - 160 - SLASH_GAP
    })
  })

  it('goes above a caret low on the screen, and never over the top', () => {
    const place = slashMenuPlacement({ top: 420, bottom: 440 }, bounds)
    expect(place).toEqual({
      side: 'top',
      y: 420 - SLASH_GAP,
      maxHeight: 420 - SLASH_GAP - 106 - SLASH_MARGIN
    })
  })

  it('stays under the caret when there is more room there, and clamps to 0', () => {
    expect(slashMenuPlacement({ top: 150, bottom: 170 }, { top: 120, bottom: 300 }).side).toBe(
      'bottom'
    )
    expect(slashMenuPlacement({ top: 500, bottom: 520 }, { top: 500, bottom: 510 }).maxHeight).toBe(
      0
    )
  })
})
