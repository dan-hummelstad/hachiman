/**
 * The routes that middleware skips (body above its 10 MB buffer) apply the
 * same CORS policy themselves.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { NextRequest } from 'next/server'

import { config } from '@/middleware'

import * as commits from '@/app/api/v1/mls/groups/[groupId]/commits/route'
import * as uploads from '@/app/api/v1/uploads/route'

import { MIDDLEWARE_SKIPPED_ROUTES } from './cors'

const ALLOWED = 'http://localhost:5173'
const matchers = config.matcher.map((m) => new RegExp(`^${m}$`))
const matched = (path: string) => matchers.some((re) => re.test(path))
const GROUP = 'AAECAwQFBgcICQoLDA0ODw'

describe('middleware matcher', () => {
  test('skips exactly the listed routes and keeps the rest of /api', () => {
    for (const route of MIDDLEWARE_SKIPPED_ROUTES) assert.equal(matched(route.replace(':groupId', GROUP)), false, route)
    for (const path of ['/api/v1/backups', `/api/v1/mls/groups/${GROUP}`, `/api/v1/mls/groups/${GROUP}/handshakes`, '/api/v1/uploadsx', '/api/oidc/token', '/api/admin/regions']) {
      assert.equal(matched(path), true, path)
    }
  })
})

describe('CORS on the routes that middleware skips', () => {
  const routes = [
    { name: 'commits', mod: commits, url: `http://takusen.test/api/v1/mls/groups/${GROUP}/commits`, ctx: { params: Promise.resolve({ groupId: GROUP }) } },
    { name: 'uploads', mod: uploads, url: 'http://takusen.test/api/v1/uploads?kind=blob', ctx: undefined },
  ] as const

  for (const r of routes) {
    test(`${r.name}: OPTIONS answers the preflight for an allowed origin only`, () => {
      const ok = r.mod.OPTIONS(new NextRequest(r.url, { method: 'OPTIONS', headers: { origin: ALLOWED } }))
      assert.equal(ok.status, 204)
      assert.equal(ok.headers.get('access-control-allow-origin'), ALLOWED)
      assert.match(ok.headers.get('access-control-allow-headers') ?? '', /X-Hachiman-Device/)
      const evil = r.mod.OPTIONS(new NextRequest(r.url, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }))
      assert.equal(evil.headers.get('access-control-allow-origin'), null)
      assert.equal(evil.headers.get('vary'), 'Origin')
    })
  }

  test('commits: an error response of POST still carries CORS', async () => {
    const error = console.error
    console.error = () => {}
    try {
      const req = new NextRequest(routes[0].url, { method: 'POST', headers: { origin: ALLOWED, 'content-type': 'application/json' }, body: '{}' })
      const res = await commits.POST(req, routes[0].ctx)
      assert.ok(res.status >= 400)
      assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED)
      assert.equal(res.headers.get('vary'), 'Origin')
    } finally {
      console.error = error
    }
  })
})
