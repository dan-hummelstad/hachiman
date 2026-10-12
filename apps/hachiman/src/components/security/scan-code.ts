/** What a scan or a paste gave, checked against the prefix of the kind of code that the step needs. */
export type CheckedCode = { kind: 'cancel' } | { kind: 'wrong' } | { kind: 'code'; code: string }

/**
 * Check the text of a code: the native scanner's result (`IPlatformService.scanQr`) or a paste.
 * Null is a cancel (the user closed the scanner). Text that does not start with `prefix` after a
 * trim is a code of the wrong kind (for example a link code in the verify step).
 */
export function checkCode(prefix: string, raw: string | null): CheckedCode {
  if (raw === null) return { kind: 'cancel' }
  const code = raw.trim()
  return code.startsWith(prefix) ? { kind: 'code', code } : { kind: 'wrong' }
}
