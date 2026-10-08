/**
 * The account overview helpers (account-sessions.ts): Hachiman sessions from
 * OIDC grants, apps with access, and the browser label.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  describeUserAgent,
  groupAppAccess,
  toHachimanSessions,
  type DeviceRow,
  type GrantRow,
} from './account-sessions'

const grant = (id: string, iat: number, clientId = 'hachiman-client', scope = 'openid profile'): GrantRow => ({
  id,
  payload: { accountId: 'u1', clientId, iat, openid: { scope } },
  expiresAt: new Date((iat + 14 * 86400) * 1000),
})

const device = (id: string, lastSeen: number | null): DeviceRow => ({
  id,
  name: 'Hachiman Desktop',
  platform: 'electron',
  clientVersion: '0.4.2',
  status: 'active',
  lastSeenAt: lastSeen === null ? null : new Date(lastSeen * 1000),
})

describe('toHachimanSessions', () => {
  test('last activity is the newest of the grant, its tokens and its device', () => {
    const sessions = toHachimanSessions(
      [grant('g1', 1000), grant('g2', 2000), grant('g3', 1500)],
      new Map([['g1', 5000]]),
      new Map([['g3', device('d3', 4000)]]),
    )
    assert.deepEqual(
      sessions.map((s) => [s.grantId, s.lastActiveAt]),
      [
        ['g1', new Date(5000_000).toISOString()],
        ['g3', new Date(4000_000).toISOString()],
        ['g2', new Date(2000_000).toISOString()],
      ],
    )
    assert.equal(sessions[1]?.device?.name, 'Hachiman Desktop')
    assert.equal(sessions[0]?.device, null)
    assert.equal(sessions[0]?.signedInAt, new Date(1000_000).toISOString())
  })

  test('the device row has no lastSeenAt in the wire shape', () => {
    const [s] = toHachimanSessions([grant('g1', 1)], new Map(), new Map([['g1', device('d1', null)]]))
    assert.deepEqual(Object.keys(s?.device ?? {}).sort(), ['clientVersion', 'id', 'name', 'platform', 'status'])
  })
})

describe('groupAppAccess', () => {
  test('one entry per client: scope union, session count, oldest grant', () => {
    const apps = groupAppAccess([
      grant('g1', 3000, 'hachiman-client', 'openid profile'),
      grant('g2', 1000, 'hachiman-client', 'openid email offline_access'),
      grant('g3', 2000, 'other', 'openid'),
    ])
    assert.deepEqual(apps, [
      {
        clientId: 'hachiman-client',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        sessionCount: 2,
        since: new Date(1000_000).toISOString(),
      },
      { clientId: 'other', scopes: ['openid'], sessionCount: 1, since: new Date(2000_000).toISOString() },
    ])
  })

  test('a grant without a client id is skipped', () => {
    assert.deepEqual(groupAppAccess([{ id: 'g', payload: { iat: 1 }, expiresAt: null }]), [])
  })
})

describe('describeUserAgent', () => {
  const cases: [string, string, boolean][] = [
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:128.0) Gecko/20100101 Firefox/128.0', 'Firefox on macOS', false],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
      true,
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      'Edge on Windows',
      false,
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
      'Chrome on Android',
      true,
    ],
  ]
  for (const [ua, label, mobile] of cases) {
    test(label, () => {
      const d = describeUserAgent(ua)
      assert.equal(d.label, label)
      assert.equal(d.mobile, mobile)
    })
  }

  test('an unknown or missing user agent', () => {
    assert.equal(describeUserAgent(null).label, 'This browser')
    assert.equal(describeUserAgent('curl/8.0').label, 'This browser')
  })
})
