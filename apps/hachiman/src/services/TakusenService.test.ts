import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTakusenStore, type TakusenSession } from '@/stores/takusenStore'
import { parseCallbackUrl, SIGN_IN_CANCELLED, TakusenService } from './TakusenService'

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

type PendingFlow = NonNullable<ReturnType<typeof useTakusenStore.getState>['pendingFlow']>

const flow = (state: string): PendingFlow => ({
  state,
  codeVerifier: 'v',
  redirectUri: 'app://cb',
  inviteCode: null,
  createdAt: Date.now()
})

it('reads a code callback and an error callback', () => {
  expect(parseCallbackUrl('app://cb?code=c&state=s')).toEqual({
    kind: 'code',
    code: 'c',
    state: 's'
  })
  expect(parseCallbackUrl('app://cb?error=access_denied&error_description=no&state=s')).toEqual({
    kind: 'error',
    error: 'access_denied',
    description: 'no',
    state: 's'
  })
  expect(() => parseCallbackUrl('app://cb?code=c')).toThrow('missing code/state')
})

it('a deny on the consent page says the user cancelled, and the sign-in can start again', async () => {
  useTakusenStore.setState({ pendingFlow: flow('s') })
  await new TakusenService().completeSignIn(
    'app://cb?error=access_denied&error_description=The+end+user+denied&state=s'
  )
  expect(useTakusenStore.getState().authError).toBe(SIGN_IN_CANCELLED)
  expect(useTakusenStore.getState().pendingFlow).toBeNull()
  expect(useTakusenStore.getState().session).toBeNull()
})

it('a deny for a sign-in this app did not start is refused', async () => {
  useTakusenStore.setState({ pendingFlow: flow('mine') })
  await expect(
    new TakusenService().completeSignIn('app://cb?error=access_denied&state=other')
  ).rejects.toThrow('does not match')
  expect(useTakusenStore.getState().authError).toBeNull()
  expect(useTakusenStore.getState().pendingFlow).not.toBeNull()
})

it('another error response throws its description', async () => {
  useTakusenStore.setState({ pendingFlow: flow('s') })
  await expect(
    new TakusenService().completeSignIn(
      'app://cb?error=server_error&error_description=Takusen+broke&state=s'
    )
  ).rejects.toThrow('Takusen broke')
})
