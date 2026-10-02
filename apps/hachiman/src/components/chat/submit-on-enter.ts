/**
 * Enter submits, Shift+Enter inserts a newline. Ignores the Enter that commits an IME
 * composition (e.g. picking a kana candidate), which must not send.
 */
export function submitOnEnter(e: React.KeyboardEvent, submit: () => void): void {
  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
  e.preventDefault()
  submit()
}
