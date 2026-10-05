import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTakusenStore, type TakusenSession } from '@/stores/takusenStore'
import { TakusenService } from './TakusenService'

const discovery = {
  issuer: 'http://t/api/oidc',
  authorization_endpoint: 'http://t/api/oidc/auth',
  token_endpoint: 'http://t/api/oidc/token'
}
const user = { id: 'u', handle: 'u', email: '' }
const expired = (refreshToken: string | null): TakusenSession => ({
  accessToken: 'a',
  refreshToken,
  expiresAt: Date.now() - 1000,
  user
})

/** Answers discovery, then `token` for the token endpoint. */
function stubFetch(token: Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(url.endsWith('openid-configuration') ? Response.json(discovery) : token)
    )
  )
}

beforeEach(() => {
  vi.useFakeTimers() // the constructor schedules a refresh; keep it from firing after a test
  useTakusenStore.setState({ session: null, pendingFlow: null, authError: null })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('asks for consent, so the provider keeps offline_access and issues a refresh token', async () => {
  stubFetch(new Response(null, { status: 500 }))
  const url = new URL(await new TakusenService().beginSignIn('app://cb'))
  expect(url.searchParams.get('prompt')).toBe('consent')
  expect(url.searchParams.get('scope')).toContain('offline_access')
})

it('an expired session without a refresh token signs out and says why', async () => {
  useTakusenStore.setState({ session: expired(null) })
  await expect(new TakusenService().getAccessToken()).rejects.toThrow('Not signed in')
  expect(useTakusenStore.getState().session).toBeNull()
  expect(useTakusenStore.getState().authError).toMatch(/expired/)
})

it('a refresh that the server rejects (4xx) signs out and says why', async () => {
  stubFetch(new Response('{"error":"invalid_grant"}', { status: 400 }))
  useTakusenStore.setState({ session: expired('r') })
  await expect(new TakusenService().getAccessToken()).rejects.toThrow('Not signed in')
  expect(useTakusenStore.getState().session).toBeNull()
  expect(useTakusenStore.getState().authError).toMatch(/expired/)
})

it('a server error (5xx) keeps the session for a later retry', async () => {
  stubFetch(new Response(null, { status: 503 }))
  useTakusenStore.setState({ session: expired('r') })
  await expect(new TakusenService().getAccessToken()).rejects.toThrow()
  expect(useTakusenStore.getState().session).not.toBeNull()
})
