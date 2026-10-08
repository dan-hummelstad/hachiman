/** Whether `el` takes text: an input, a textarea or a contenteditable element. */
export function isTextField(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(
      type
    )
  }
  return (el as HTMLElement).isContentEditable === true
}
