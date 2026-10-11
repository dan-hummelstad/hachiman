/** A hold that starts on these does not open the action sheet: they keep their own touch. */
const HOLD_IGNORE = 'a[href], audio, video, [data-hold-ignore]'

/**
 * Whether a press on `target` must not start the long press of the message `row`: the target is
 * not inside the row in the DOM (the event bubbled through a React portal, such as a sheet that
 * the row opened), or it is a link, a media control or a `[data-hold-ignore]` part.
 */
export function holdIgnored(target: EventTarget | null, row: Node): boolean {
  if (target === null || !row.contains(target as Node)) return true
  const el = target as Partial<Element>
  return typeof el.closest !== 'function' || el.closest(HOLD_IGNORE) !== null
}
