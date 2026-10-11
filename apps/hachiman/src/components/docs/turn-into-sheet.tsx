import { flushSync } from 'react-dom'
import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  SquareCheck,
  SquareCode,
  TextQuote,
  Type,
  type LucideIcon
} from 'lucide-react'
import {
  MenuSheet,
  MenuSheetContent,
  MenuSheetLabel,
  MenuSheetRadioGroup,
  MenuSheetRadioItem
} from '@/components/mobile/menu-sheet'
import type { BlockAt, BlockKind } from './touch-editor'
import { focusMoreIfLost } from './page-editor-state'

interface KindRow {
  kind: BlockKind
  label: string
  icon: LucideIcon
}

const TEXT_KINDS: readonly KindRow[] = [
  { kind: 'text', label: 'Text', icon: Type },
  { kind: 'h1', label: 'Heading 1', icon: Heading1 },
  { kind: 'h2', label: 'Heading 2', icon: Heading2 },
  { kind: 'h3', label: 'Heading 3', icon: Heading3 },
  { kind: 'quote', label: 'Quote', icon: TextQuote },
  { kind: 'code', label: 'Code', icon: SquareCode }
]

const LIST_KINDS: readonly KindRow[] = [
  { kind: 'todo', label: 'To-do list', icon: SquareCheck },
  { kind: 'bullet', label: 'Bulleted list', icon: List },
  { kind: 'number', label: 'Numbered list', icon: ListOrdered }
]

/**
 * "Turn into" from the page keyboard toolbar (docs/ios-mobile-ui-spec.md F3a): a menu sheet of the
 * block forms, the form of the current block checked. A pick first closes the sheet in a sync
 * render, so its focus trap lets go, then calls `onPick` in the same tap: the caller can give the
 * focus back to the editor there, and iOS raises the keyboard again. The sheet gives no focus back
 * itself; a sheet closed with no pick leaves the keyboard down.
 */
export function TurnIntoSheet({
  open,
  onOpenChange,
  current,
  onPick
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  current: BlockAt
  onPick: (kind: BlockKind) => void
}): React.JSX.Element {
  const pick = (value: string): void => {
    const row = [...TEXT_KINDS, ...LIST_KINDS].find((r) => r.kind === value)
    if (!row) return
    flushSync(() => onOpenChange(false))
    onPick(row.kind)
  }
  const rows = (list: readonly KindRow[], label: string): React.JSX.Element => (
    <MenuSheetRadioGroup value={current} onValueChange={pick} aria-label={label}>
      {list.map(({ kind, label: text, icon: Icon }) => (
        <MenuSheetRadioItem key={kind} value={kind}>
          <Icon aria-hidden />
          {text}
        </MenuSheetRadioItem>
      ))}
    </MenuSheetRadioGroup>
  )
  return (
    <MenuSheet open={open} onOpenChange={onOpenChange}>
      <MenuSheetContent
        title="Turn into"
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          focusMoreIfLost()
        }}
      >
        <MenuSheetLabel>Turn into</MenuSheetLabel>
        {rows(TEXT_KINDS, 'Text blocks')}
        <MenuSheetLabel>Lists</MenuSheetLabel>
        {rows(LIST_KINDS, 'Lists')}
      </MenuSheetContent>
    </MenuSheet>
  )
}
