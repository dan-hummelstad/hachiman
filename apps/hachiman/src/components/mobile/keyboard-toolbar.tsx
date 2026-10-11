import { useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  AtSign,
  ChevronDown,
  List,
  ListIndentIncrease,
  ListOrdered,
  Plus,
  SquareCheck,
  Type,
  Undo2
} from 'lucide-react'
import type { PageEditorApi } from '@/components/docs/page-editor'
import { TurnIntoSheet } from '@/components/docs/turn-into-sheet'
import { clearSlash, indentItem, toggleKind, turnInto } from '@/components/docs/touch-editor'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/shared/PlatformContext'

/** The height of the bar (kit M39 "Block Toolbar"). */
export const KEYBOARD_TOOLBAR_HEIGHT = 46

/**
 * A 46 bar (45 and its top line) that rides on the software keyboard (docs/ios-mobile-ui-spec.md
 * F3a, M39): fixed at the visual viewport bottom (`--kb`), over the home indicator when no keyboard
 * shows. It renders in a portal on `<body>`, over the pushed page screen and under sheets. P4 hides
 * the WKWebView accessory bar, so nothing sits between the bar and the keyboard.
 */
export function KeyboardToolbar({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.ReactPortal {
  return createPortal(
    <div
      role="toolbar"
      aria-label={label}
      data-slot="keyboard-toolbar"
      data-swipe-ignore=""
      className={cn(
        'fixed inset-x-0 bottom-(--kb,0px) z-40 box-content flex h-[45px] items-center gap-0.5 px-1.5',
        'bg-surface-raised border-t border-(--line-sheet)',
        'pb-(--safe-bottom,0px) in-data-[keyboard=open]:pb-0'
      )}
    >
      {children}
    </div>,
    document.body
  )
}

/**
 * One tool: 36 high, the width shared with the others (38 at the least on an iPhone SE), icon 19.
 * A press keeps the focus where it is (`pointerdown` and `mousedown` do nothing), so the keyboard
 * stays up; the tool acts on `click`, which a tap, VoiceOver and a hardware key all send. A tool
 * that does not apply is `aria-disabled`, not `disabled`: a disabled button would let the press
 * take the focus out of the editor.
 */
export function ToolbarButton({
  label,
  lit = false,
  pressed,
  expanded,
  popup,
  disabled = false,
  onPress,
  className,
  children
}: {
  label: string
  /** The tool's state shows (the accent tint). */
  lit?: boolean
  /** A toggle: `aria-pressed`. */
  pressed?: boolean
  /** A tool that opens a menu: `aria-expanded`. */
  expanded?: boolean
  /** The kind of menu the tool opens: `aria-haspopup`. */
  popup?: 'listbox' | 'dialog'
  disabled?: boolean
  onPress: () => void
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-haspopup={popup}
      aria-disabled={disabled || undefined}
      data-lit={lit || undefined}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (!disabled) onPress()
      }}
      className={cn(
        'rounded-control text-text-secondary flex h-9 min-w-9 flex-1 items-center justify-center outline-none select-none',
        'focus-visible:outline-line-focus focus-visible:outline-2 focus-visible:-outline-offset-2',
        'active:bg-surface-hover data-lit:bg-accent-tint data-lit:text-accent-text',
        'aria-disabled:text-text-disabled aria-disabled:active:bg-transparent',
        '[&_svg]:pointer-events-none [&_svg]:size-[19px] [&_svg]:shrink-0',
        className
      )}
    >
      {children}
    </button>
  )
}

const LIST_TOOLS: readonly {
  kind: 'todo' | 'bullet' | 'number'
  label: string
  icon: React.ReactNode
}[] = [
  { kind: 'todo', label: 'To-do list', icon: <SquareCheck aria-hidden /> },
  { kind: 'bullet', label: 'Bulleted list', icon: <List aria-hidden /> },
  { kind: 'number', label: 'Numbered list', icon: <ListOrdered aria-hidden /> }
]

/**
 * The keyboard toolbar of the touch page editor (M39): "+" (a "/" line, so the slash menu opens),
 * turn into (a sheet), to-do, bullets, numbers, link a page (the page picker sheet), indent and
 * undo, then hide the keyboard. The list tools and "+" light up for the block at the caret. The
 * bar shows while the editor has the focus; the turn-into sheet stays mounted, so it outlives the
 * bar when it takes the focus. Comments are not built, so their tool is not here.
 */
export function PageKeyboardToolbar({
  api,
  onLinkPage
}: {
  api: PageEditorApi
  /** The "@" tool: the page picker sheet. Called in the tap, so it can focus its search field. */
  onLinkPage: () => void
}): React.JSX.Element {
  const platform = usePlatform()
  const signals = useSyncExternalStore(api.subscribe, api.getSignals)
  const [turnOpen, setTurnOpen] = useState(false)

  return (
    <>
      {signals.focused && !turnOpen && (
        <KeyboardToolbar label="Block tools">
          <ToolbarButton
            label="Insert a block"
            lit={signals.slash}
            expanded={signals.slash}
            popup="listbox"
            onPress={() => {
              if (signals.slash) api.run(clearSlash)
              else if (api.insertSlash()) platform.haptic('light')
            }}
          >
            <Plus aria-hidden />
          </ToolbarButton>
          <ToolbarButton label="Turn into" onPress={() => setTurnOpen(true)}>
            <Type aria-hidden />
          </ToolbarButton>
          {LIST_TOOLS.map((tool) => (
            <ToolbarButton
              key={tool.kind}
              label={tool.label}
              lit={signals.kind === tool.kind}
              pressed={signals.kind === tool.kind}
              onPress={() => api.run(toggleKind(tool.kind))}
            >
              {tool.icon}
            </ToolbarButton>
          ))}
          <ToolbarButton label="Link to a page" onPress={onLinkPage}>
            <AtSign aria-hidden />
          </ToolbarButton>
          <ToolbarButton
            label="Indent"
            disabled={!signals.canIndent}
            onPress={() => api.run(indentItem)}
          >
            <ListIndentIncrease aria-hidden />
          </ToolbarButton>
          <ToolbarButton label="Undo" onPress={() => api.undo()}>
            <Undo2 aria-hidden />
          </ToolbarButton>
          <span aria-hidden className="mx-px h-[22px] w-px shrink-0 bg-(--fill-control-strong)" />
          <ToolbarButton
            label="Hide the keyboard"
            className="w-[38px] flex-none"
            onPress={api.blur}
          >
            <ChevronDown aria-hidden className="size-5!" />
          </ToolbarButton>
        </KeyboardToolbar>
      )}
      <TurnIntoSheet
        open={turnOpen}
        onOpenChange={setTurnOpen}
        current={signals.kind}
        onPick={(kind) => {
          api.run(turnInto(kind))
          api.focus()
        }}
      />
    </>
  )
}
