/**
 * A short form of the name that a screen reader gives an element: `aria-label`, else the text of
 * the `aria-labelledby` elements, else the element's own text. On the mobile layout a menu or a
 * popover turns into a sheet, and the sheet takes the name of the control that opened it ("More",
 * "Pinned messages", the guild name).
 */

/** A name longer than this is cut: it is a dialog title, not the content. */
export const NAME_MAX = 60

/** The part of an element that the name comes from. */
export interface NamedElement {
  getAttribute(name: string): string | null
  readonly textContent: string | null
}

function clean(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

function cut(text: string): string {
  return text.length > NAME_MAX ? `${text.slice(0, NAME_MAX - 1).trimEnd()}…` : text
}

/** Null when the element has no name. `byId` resolves `aria-labelledby` (default: the document). */
export function accessibleName(
  el: NamedElement | null,
  byId: (id: string) => NamedElement | null = (id) => document.getElementById(id)
): string | null {
  if (!el) return null
  const label = clean(el.getAttribute('aria-label'))
  if (label) return cut(label)
  const ids = clean(el.getAttribute('aria-labelledby'))
  if (ids) {
    const text = clean(
      ids
        .split(' ')
        .map((id) => byId(id)?.textContent ?? '')
        .join(' ')
    )
    if (text) return cut(text)
  }
  const own = clean(el.textContent)
  return own ? cut(own) : null
}
