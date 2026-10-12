/**
 * Pure helpers for the account overview: the Hachiman sign-ins of a user
 * (one OIDC grant per sign-in, oidc-provider.ts `loadExistingGrant`), the apps
 * with access, and a label for the current browser. No DB or Redis here, so
 * account-sessions.test.ts runs without either. account.ts does the reads.
 *
 * Takusen stores no IP address, location or user agent for a sign-in. The
 * dashboard cookie is a stateless JWT, so only the current one is known.
 */

export type DevicePlatform = 'electron' | 'browser' | 'ios'

export interface HachimanSessionDevice {
  id: string
  /** Set by the app: "Hachiman Desktop", "Hachiman Web" or "Hachiman iOS". */
  name: string
  platform: DevicePlatform
  clientVersion: string
  status: 'pending' | 'active' | 'revoked'
}

/** One Hachiman sign-in: a live OIDC grant of the user. */
export interface HachimanSession {
  grantId: string
  clientId: string
  /** The E2EE device the grant is bound to (§12.12 "Device binding"), or null before the app registered one. */
  device: HachimanSessionDevice | null
  signedInAt: string
  /** The newest of: the grant, its newest access token, the device's last_seen_at. */
  lastActiveAt: string
  /** When the grant ends (14 days after the sign-in). */
  expiresAt: string | null
}

/** The apps that can use the account: the live grants, per OIDC client. */
export interface AppAccess {
  clientId: string
  /** The union of the OIDC scopes of the client's grants, in grant order. */
  scopes: string[]
  /** The live grants (= Hachiman sessions) of the client. */
  sessionCount: number
  /** The oldest live grant. */
  since: string
}

/** The fields of a `Grant` row that the overview reads. */
export interface GrantRow {
  id: string
  payload: Record<string, unknown>
  expiresAt: Date | null
}

export interface DeviceRow extends HachimanSessionDevice {
  lastSeenAt: Date | null
}

function unixSeconds(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

export function grantScopes(payload: Record<string, unknown>): string[] {
  const openid = payload.openid as { scope?: unknown } | undefined
  return typeof openid?.scope === 'string' ? openid.scope.split(' ').filter(Boolean) : []
}

/**
 * Newest activity first. `tokenIat` maps a grant id to the newest `iat` (Unix
 * seconds) of its tokens. `deviceOf` maps a grant id to its bound device.
 */
export function toHachimanSessions(
  grants: readonly GrantRow[],
  tokenIat: ReadonlyMap<string, number>,
  deviceOf: ReadonlyMap<string, DeviceRow>,
): HachimanSession[] {
  const out = grants.map((g) => {
    const iat = unixSeconds(g.payload.iat) ?? 0
    const device = deviceOf.get(g.id) ?? null
    const seen = device?.lastSeenAt ? Math.floor(device.lastSeenAt.getTime() / 1000) : 0
    const last = Math.max(iat, tokenIat.get(g.id) ?? 0, seen)
    return {
      grantId: g.id,
      clientId: typeof g.payload.clientId === 'string' ? g.payload.clientId : '',
      device: device && {
        id: device.id,
        name: device.name,
        platform: device.platform,
        clientVersion: device.clientVersion,
        status: device.status,
      },
      signedInAt: iso(iat),
      lastActiveAt: iso(last),
      expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
    }
  })
  return out.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt) || a.grantId.localeCompare(b.grantId))
}

/** One entry per client, the client with the oldest grant first. */
export function groupAppAccess(grants: readonly GrantRow[]): AppAccess[] {
  const byClient = new Map<string, { scopes: Set<string>; sessionCount: number; since: number }>()
  for (const g of grants) {
    const clientId = typeof g.payload.clientId === 'string' ? g.payload.clientId : ''
    if (!clientId) continue
    const iat = unixSeconds(g.payload.iat) ?? 0
    const entry = byClient.get(clientId) ?? { scopes: new Set<string>(), sessionCount: 0, since: iat }
    for (const s of grantScopes(g.payload)) entry.scopes.add(s)
    entry.sessionCount++
    entry.since = Math.min(entry.since, iat)
    byClient.set(clientId, entry)
  }
  return [...byClient]
    .map(([clientId, e]) => ({ clientId, scopes: [...e.scopes], sessionCount: e.sessionCount, since: iso(e.since) }))
    .sort((a, b) => a.since.localeCompare(b.since) || a.clientId.localeCompare(b.clientId))
}

export interface BrowserLabel {
  /** "Firefox on macOS", or "This browser" when the user agent says nothing known. */
  label: string
  browser: string | null
  os: string | null
  mobile: boolean
}

// Order matters: Edge and Opera also say Chrome, Chrome also says Safari.
const BROWSERS: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
]

/** A label for the user agent of the current request. */
export function describeUserAgent(ua: string | null | undefined): BrowserLabel {
  const s = ua ?? ''
  const browser = BROWSERS.find(([re]) => re.test(s))?.[1] ?? null
  const os = SYSTEMS.find(([re]) => re.test(s))?.[1] ?? null
  const mobile = /Mobi|iPhone|iPod|Android.*Mobile/.test(s)
  const label = browser && os ? `${browser} on ${os}` : (browser ?? os ?? 'This browser')
  return { label, browser, os, mobile }
}
