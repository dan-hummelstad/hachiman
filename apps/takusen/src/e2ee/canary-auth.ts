/**
 * Canary sign-in (src/e2ee/canary.integration.ts): a user signs in the way the Hachiman app does,
 * over HTTP only. Auth.js credentials sign-in gives the dashboard session cookie, then an OIDC
 * authorization-code flow with PKCE (client hachiman-client) gives the access token. The consent
 * screen is a server action form: the script posts it like a browser without JavaScript.
 *
 * Only the user row is a shortcut: the script inserts it with the columns that signupAction
 * writes, because the sign-up form has no plain HTTP route.
 */
import { createHash, randomBytes } from 'node:crypto'

import bcrypt from 'bcryptjs'
import type postgres from 'postgres'

const b64url = (b: Buffer) => b.toString('base64url')

/** A minimal cookie jar: name → value, for one origin. */
class Jar {
  private readonly cookies = new Map<string, string>()

  take(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';')
      const eq = pair!.indexOf('=')
      if (eq < 0) continue
      const name = pair!.slice(0, eq).trim()
      const value = pair!.slice(eq + 1).trim()
      if (value === '' || /max-age=0\b/i.test(line) || /expires=thu, 01 jan 1970/i.test(line)) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

async function send(jar: Jar, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const cookie = jar.header()
  if (cookie) headers.set('cookie', cookie)
  const res = await fetch(url, { ...init, headers, redirect: 'manual' })
  jar.take(res)
  return res
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * The hidden fields of the server action form whose submit button says `label`. React renders a
 * server action form with them, so the form works without JavaScript.
 */
function actionForm(html: string, label: RegExp): FormData {
  for (const m of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)) {
    const body = m[1]!
    if (!label.test(body.replace(/<[^>]+>/g, ' '))) continue
    const form = new FormData()
    for (const input of body.matchAll(/<input\b[^>]*>/g)) {
      const name = /\bname="([^"]*)"/.exec(input[0])?.[1]
      if (name === undefined) continue
      const value = /\bvalue="([^"]*)"/.exec(input[0])?.[1] ?? ''
      form.append(decodeEntities(name), decodeEntities(value))
    }
    return form
  }
  throw new Error(`canary sign-in: no form with ${label} on the consent page`)
}

export interface CanaryUser {
  id: string
  email: string
  password: string
  accessToken: string
}

/** Inserts the user row as signupAction does (bcrypt hash, lowercased email). */
export async function createUser(sql: postgres.Sql, email: string, password: string, displayName: string): Promise<string> {
  const passwordHash = await bcrypt.hash(password, 4)
  const [row] = await sql<{ id: string }[]>`
    insert into users (email, display_name, name, password_hash)
    values (${email.toLowerCase()}, ${displayName}, ${displayName}, ${passwordHash})
    returning id`
  return row!.id
}

/** Auth.js credentials sign-in, then OIDC code + PKCE. Resolves the access token. */
export async function signIn(base: string, email: string, password: string, redirectUri: string): Promise<string> {
  const jar = new Jar()
  const csrfRes = await send(jar, `${base}/api/auth/csrf`)
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
  const login = await send(jar, `${base}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrfToken, email, password, callbackUrl: `${base}/dashboard` }),
  })
  if (login.status >= 400 || !(login.headers.get('location') ?? '').startsWith(`${base}/dashboard`))
    throw new Error(`canary sign-in: credentials sign-in failed (${login.status} ${login.headers.get('location')})`)

  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))
  const authorize = new URL(`${base}/api/oidc/auth`)
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: 'hachiman-client',
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()

  let url = authorize.toString()
  for (let hop = 0; hop < 20; hop++) {
    if (url.startsWith(redirectUri)) {
      const params = new URL(url).searchParams
      if (params.get('state') !== state) throw new Error('canary sign-in: state mismatch')
      const code = params.get('code')
      if (code === null) throw new Error(`canary sign-in: ${params.get('error')} ${params.get('error_description')}`)
      const token = await fetch(`${base}/api/oidc/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: 'hachiman-client', code_verifier: verifier }),
      })
      if (!token.ok) throw new Error(`canary sign-in: token ${token.status} ${await token.text()}`)
      return ((await token.json()) as { access_token: string }).access_token
    }
    const res = await send(jar, url)
    const location = res.headers.get('location')
    if (location !== null) {
      url = new URL(location, url).toString()
      continue
    }
    if (res.status !== 200 || !new URL(url).pathname.startsWith('/oidc/interaction/'))
      throw new Error(`canary sign-in: ${url} → ${res.status} ${(await res.text()).slice(0, 300)}`)
    // The consent page: post its Allow form as a browser without JavaScript does.
    const form = actionForm(await res.text(), /\b(Allow|Continue|Authorize)\b/i)
    const post = await send(jar, url, { method: 'POST', body: form })
    const next = post.headers.get('location') ?? post.headers.get('x-action-redirect')
    if (next === null) throw new Error(`canary sign-in: consent → ${post.status} ${(await post.text()).slice(0, 300)}`)
    url = new URL(next.split(';')[0]!, url).toString()
  }
  throw new Error('canary sign-in: too many redirects')
}
