/**
 * Only same-origin relative paths, so `next` cannot become an open redirect.
 * Browsers read `/\evil.com` as `//evil.com` and drop tabs and newlines from
 * URLs, so backslashes and control characters are refused too.
 */
export function safeNext(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return undefined
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return undefined
  return value
}
