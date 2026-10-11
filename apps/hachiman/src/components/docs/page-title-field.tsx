import { useRef, useState } from 'react'
import { cn, errMsg } from '@/lib/utils'
import { docsService } from '@/services/docs/DocsService'
import { MAX_PAGE_TITLE_BYTES, pageTitle } from '@/services/docs/page-tree'
import type { PageNode } from '@/stores/docsStore'

const PLACEHOLDER = 'Untitled'

/**
 * The text of the field when it takes the focus: the title, or empty for an "Untitled" page and
 * for a title that does not decrypt, so the user types a new one at once.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function titleDraft(page: Pick<PageNode, 'title' | 'titleState'>): string {
  if (page.titleState !== 'ok') return ''
  const title = page.title.trim()
  return title === '' || title === PLACEHOLDER ? '' : page.title
}

/** `value` cut to MAX_PAGE_TITLE_BYTES of UTF-8, at a character edge, so typing stops there. */
// eslint-disable-next-line react-refresh/only-export-components
export function fitTitle(value: string): string {
  const enc = new TextEncoder()
  if (enc.encode(value).length <= MAX_PAGE_TITLE_BYTES) return value
  let out = ''
  for (const ch of value) {
    if (enc.encode(out + ch).length > MAX_PAGE_TITLE_BYTES) break
    out += ch
  }
  return out
}

/**
 * What a key does in the field: Enter saves, Escape cancels. A key of an open IME composition
 * (the Enter that picks a kana candidate, keyCode 229 on WebKit) does nothing.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function titleKey(
  e: Pick<KeyboardEvent, 'key' | 'isComposing' | 'keyCode'>
): 'save' | 'cancel' | null {
  if (e.isComposing || e.keyCode === 229) return null
  if (e.key === 'Enter') return 'save'
  if (e.key === 'Escape') return 'cancel'
  return null
}

/**
 * The title of the open page as an inline field (§12.20: the title is a page envelope, so a save
 * is `docsService.renamePage`). Enter or a blur saves, Escape cancels. A title that is still
 * decrypting shows as text. Only for users who may edit the page: others get the plain title.
 * The field sizes to its text, so it sits in a line of text (the desktop path).
 */
export function PageTitleField({
  page,
  className,
  current = false,
  onError
}: {
  page: PageNode
  className?: string
  /** The field is the last step of a page path: it carries aria-current="page". */
  current?: boolean
  /** A save failed: a user-facing line. */
  onError: (message: string) => void
}): React.JSX.Element {
  // The text while the field has the focus, and while its save is on the way.
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const cancelled = useRef(false)
  // The text at the focus: a blur that changed nothing saves nothing (an unreadable title stays).
  const initial = useRef('')
  const shown = draft ?? saving ?? pageTitle(page)

  if (page.titleState === 'pending')
    return (
      <span
        aria-current={current ? 'page' : undefined}
        className={cn('min-w-0 truncate italic', className)}
      >
        {pageTitle(page)}
      </span>
    )

  const save = (value: string): void => {
    const text = fitTitle(value)
    setSaving(text)
    docsService
      .renamePage(page.id, text)
      .catch((e: unknown) => onError(`Could not rename the page: ${errMsg(e)}`))
      .finally(() => setSaving(null))
  }

  return (
    <span className={cn('grid min-w-0 grid-cols-[minmax(0,max-content)]', className)}>
      {/* Sizes the grid cell, and so the field, to the text. */}
      <span aria-hidden className="invisible col-start-1 row-start-1 truncate px-1 whitespace-pre">
        {shown || PLACEHOLDER}
      </span>
      <input
        aria-label="Page title"
        aria-current={current ? 'page' : undefined}
        // The hidden text sizes the field: no intrinsic width of its own.
        size={1}
        value={shown}
        placeholder={PLACEHOLDER}
        enterKeyHint="done"
        spellCheck={false}
        className={cn(
          'col-start-1 row-start-1 w-full min-w-0 rounded-[4px] bg-transparent px-1 leading-[inherit] text-ellipsis outline-none',
          'placeholder:text-text-tertiary hover:bg-surface-hover focus-visible:bg-surface-hover',
          'focus-visible:outline-line-focus focus-visible:outline-2',
          page.titleState === 'failed' && draft === null && 'italic'
        )}
        onFocus={() => {
          cancelled.current = false
          initial.current = titleDraft(page)
          setDraft(initial.current)
        }}
        // No cut while an IME composition is open: a cut value breaks it. Its end cuts.
        onChange={(e) => {
          const composing = (e.nativeEvent as InputEvent).isComposing
          setDraft(composing ? e.target.value : fitTitle(e.target.value))
        }}
        onCompositionEnd={(e) => setDraft(fitTitle(e.currentTarget.value))}
        onKeyDown={(e) => {
          const action = titleKey(e.nativeEvent)
          if (action === 'save') e.currentTarget.blur()
          else if (action === 'cancel') {
            e.stopPropagation()
            cancelled.current = true
            e.currentTarget.blur()
          }
        }}
        onBlur={() => {
          const text = draft
          setDraft(null)
          if (!cancelled.current && text !== null && text !== initial.current) save(text)
        }}
      />
    </span>
  )
}
