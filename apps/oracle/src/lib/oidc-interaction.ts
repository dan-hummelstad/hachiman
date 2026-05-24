/**
 * Server-only helpers for the OIDC interaction flow.
 *
 * `oidc-provider` exposes interaction state via Node-style
 * `interactionDetails(req, res)` / `interactionFinished(req, res, …)` calls
 * that need a real `IncomingMessage` + `ServerResponse` pair (it reads the
 * signed interaction cookie off the request, and writes cookies / location
 * headers to the response).
 *
 * In an App-Router page we don't have those Node objects — we have
 * `headers()` and `cookies()` from `next/headers`. This module bridges the
 * gap by manufacturing a minimal `IncomingMessage` from the Next request
 * headers, and using either a throwaway `ServerResponse` (for read-only
 * `interactionDetails`) or capturing the response for the caller (for
 * `interactionFinished` redirects).
 */
import 'server-only'

import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'

import { headers } from 'next/headers'

import type Provider from 'oidc-provider'
import type { Interaction, InteractionResults } from 'oidc-provider'

import { getOidcProvider } from './oidc-provider'

async function buildIncomingFromHeaders(method = 'GET', urlPath = '/'): Promise<IncomingMessage> {
  const hdrs = await headers()
  const socket = new Socket()
  const message = new IncomingMessage(socket)
  message.method = method
  message.url = urlPath
  const flat: Record<string, string> = {}
  hdrs.forEach((value, key) => {
    flat[key] = value
  })
  message.headers = flat
  // No body for these reads.
  ;(message as unknown as { _read: () => void })._read = () => {
    message.push(null)
  }
  return message
}

function makeThrowawayResponse(req: IncomingMessage): ServerResponse {
  const res = new ServerResponse(req)
  // Suppress writes — we only need this for `interactionDetails`, which
  // doesn't actually emit anything to the response stream.
  res.write = () => true
  res.end = (() => res) as unknown as ServerResponse['end']
  return res
}

export interface InteractionView {
  provider: Provider
  interaction: Interaction
}

/**
 * Read-only view of the current interaction. Throws if the interaction
 * cookie is missing / expired (callers should redirect to /login or
 * render an "interaction expired" message).
 */
export async function getInteraction(uid: string): Promise<InteractionView> {
  const provider = await getOidcProvider()
  const req = await buildIncomingFromHeaders('GET', `/api/oidc/interaction/${uid}`)
  const res = makeThrowawayResponse(req)
  const interaction = await provider.interactionDetails(req, res)
  return { provider, interaction }
}

export interface InteractionFinishResult {
  redirectTo: string
  cookies: Array<{ name: string; value: string; options: Record<string, unknown> }>
}

/**
 * Resolve an interaction with the given result. Returns the redirect URL
 * the caller should send the browser to, plus any `Set-Cookie` headers the
 * provider produced (typically the rotated `_interaction_resume` cookie).
 *
 * The caller is responsible for forwarding the redirect (e.g. via
 * `redirect()` in a server action, or a 303 response from a route handler)
 * and any cookies (via `cookies().set(...)`).
 */
export async function finishInteraction(
  uid: string,
  result: InteractionResults,
): Promise<InteractionFinishResult> {
  const provider = await getOidcProvider()
  const req = await buildIncomingFromHeaders('POST', `/api/oidc/interaction/${uid}/confirm`)
  const captured: InteractionFinishResult = {
    redirectTo: '/',
    cookies: [],
  }
  const res = new ServerResponse(req)
  // Intercept setHeader to capture Location + Set-Cookie.
  const originalSetHeader = res.setHeader.bind(res)
  res.setHeader = ((name: string, value: number | string | readonly string[]) => {
    const lower = name.toLowerCase()
    if (lower === 'location' && typeof value === 'string') {
      captured.redirectTo = value
    }
    if (lower === 'set-cookie') {
      const values = Array.isArray(value) ? [...value] : [String(value)]
      for (const v of values) {
        const parsed = parseSetCookie(v)
        if (parsed) captured.cookies.push(parsed)
      }
    }
    return originalSetHeader(name, value as never)
  }) as typeof res.setHeader
  res.write = () => true
  res.end = (() => res) as unknown as ServerResponse['end']

  await provider.interactionResult(req, res, result, { mergeWithLastSubmission: false })

  // `interactionResult` returns the redirect URL we should send the user to
  // (e.g. /api/oidc/auth/<uid>); use that as the canonical redirect.
  // Fall through to whatever was captured if Location wasn't written.
  return captured
}

/**
 * Variant that uses `interactionResult` (writes the rotated cookie but
 * returns the URL rather than emitting a 303). Returns the URL the caller
 * should redirect to.
 */
export async function resumeInteraction(
  uid: string,
  result: InteractionResults,
): Promise<{ redirectTo: string; cookies: InteractionFinishResult['cookies'] }> {
  const provider = await getOidcProvider()
  const req = await buildIncomingFromHeaders('POST', `/api/oidc/interaction/${uid}/confirm`)
  const cookies: InteractionFinishResult['cookies'] = []
  const res = new ServerResponse(req)
  const originalSetHeader = res.setHeader.bind(res)
  res.setHeader = ((name: string, value: number | string | readonly string[]) => {
    if (name.toLowerCase() === 'set-cookie') {
      const values = Array.isArray(value) ? [...value] : [String(value)]
      for (const v of values) {
        const parsed = parseSetCookie(v)
        if (parsed) cookies.push(parsed)
      }
    }
    return originalSetHeader(name, value as never)
  }) as typeof res.setHeader
  res.write = () => true
  res.end = (() => res) as unknown as ServerResponse['end']

  const redirectTo = await provider.interactionResult(req, res, result, {
    mergeWithLastSubmission: false,
  })
  return { redirectTo, cookies }
}

function parseSetCookie(raw: string): InteractionFinishResult['cookies'][number] | null {
  const segments = raw.split(';').map((s) => s.trim())
  const [head, ...rest] = segments
  if (!head) return null
  const eq = head.indexOf('=')
  if (eq === -1) return null
  const name = head.slice(0, eq)
  const value = decodeURIComponent(head.slice(eq + 1))
  const options: Record<string, unknown> = {}
  for (const seg of rest) {
    const [k, v] = seg.split('=')
    if (!k) continue
    const key = k.toLowerCase()
    switch (key) {
      case 'path':
        options.path = v
        break
      case 'domain':
        options.domain = v
        break
      case 'expires':
        if (v) options.expires = new Date(v)
        break
      case 'max-age':
        if (v) options.maxAge = Number(v)
        break
      case 'samesite':
        options.sameSite = (v ?? '').toLowerCase()
        break
      case 'secure':
        options.secure = true
        break
      case 'httponly':
        options.httpOnly = true
        break
      default:
        break
    }
  }
  return { name, value, options }
}
