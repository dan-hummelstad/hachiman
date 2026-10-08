/**
 * fetch for Takusen's own APIs from a dashboard page, with the session cookie. A body without a
 * content type goes as JSON, a 204 resolves to undefined, and a failure throws the message of
 * the error envelope.
 */
export async function apiFetch<T = void>(base: string, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const res = await fetch(`${base}${path}`, { ...init, headers })
  if (res.status === 204) return undefined as T
  const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null
  if (!res.ok) throw new Error(body?.message ?? body?.error ?? `Request failed (${res.status})`)
  return body as T
}
