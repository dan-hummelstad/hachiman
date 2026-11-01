import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'

import {
  botGrantId,
  botTokenOrigin,
  generateBotToken,
  hashBotToken,
  isBotGrant,
  isBotToken,
  parseAuthorization,
  resolveBotTokenWith,
  type BotTokenStore,
  type LiveBotToken,
} from './bots'

const BOT = '00000000-0000-4000-8000-0000000000b0'
const TOKEN_ID = '00000000-0000-4000-8000-0000000000a1'

function store(live: Map<string, LiveBotToken>) {
  const lookups: string[] = []
  const touches: { tokenId: string; now: Date; before: Date }[] = []
  const s: BotTokenStore = {
    async findLive(hash) {
      lookups.push(hash)
      return live.get(hash) ?? null
    },
    async touch(tokenId, now, before) {
      touches.push({ tokenId, now, before })
    },
  }
  return { s, lookups, touches }
}

describe('bot token format', () => {
  test('hbot_ + origin + .h1. + base64url of 32 bytes, different each time', () => {
    const a = generateBotToken()
    const b = generateBotToken()
    assert.match(a, /^hbot_[A-Za-z0-9_-]+\.h1\.[A-Za-z0-9_-]{43}$/)
    assert.equal(Buffer.from(a.split('.')[2]!, 'base64url').length, 32)
    assert.notEqual(a, b)
    assert.ok(isBotToken(a))
  })

  test('the hash is the hex SHA-256 of the whole token', () => {
    const t = generateBotToken()
    assert.equal(hashBotToken(t), createHash('sha256').update(t).digest('hex'))
    assert.match(hashBotToken(t), /^[0-9a-f]{64}$/)
  })

  test('isBotToken rejects other shapes', () => {
    assert.equal(isBotToken('hbot_short'), false)
    assert.equal(isBotToken('xbot_' + 'a'.repeat(43)), false)
    assert.equal(isBotToken('hbot_' + 'a'.repeat(42) + '='), false)
    assert.equal(isBotToken('hbot_' + 'a'.repeat(44)), false)
  })

  test('a token names its server, and the secret is the part after the second dot', () => {
    const t = generateBotToken('https://chat.example.com')
    assert.ok(isBotToken(t))
    assert.equal(botTokenOrigin(t), 'https://chat.example.com')
    assert.equal(t.split('.').length, 3)
    assert.equal(t.split('.')[2]!.length, 43)
    // A token of the first form stays valid and names no server.
    assert.ok(isBotToken('hbot_' + 'a'.repeat(43)))
    assert.equal(botTokenOrigin('hbot_' + 'a'.repeat(43)), null)
    assert.equal(isBotToken('hbot_aGk.h2.' + 'a'.repeat(43)), false)
  })

  test('grant ids', () => {
    assert.equal(botGrantId(TOKEN_ID), `bot:${TOKEN_ID}`)
    assert.ok(isBotGrant(botGrantId(TOKEN_ID)))
    assert.equal(isBotGrant('5Gk2-oidc-grant'), false)
  })
})

describe('parseAuthorization', () => {
  const bot = 'hbot_' + 'a'.repeat(43)

  test('Bearer carries an OIDC token or a bot token', () => {
    assert.deepEqual(parseAuthorization('Bearer abc.def'), { token: 'abc.def', bot: false })
    assert.deepEqual(parseAuthorization(`Bearer ${bot}`), { token: bot, bot: true })
    assert.deepEqual(parseAuthorization(`bearer   ${bot} `), { token: bot, bot: true })
  })

  test('Bot carries only a bot token', () => {
    assert.deepEqual(parseAuthorization(`Bot ${bot}`), { token: bot, bot: true })
    assert.deepEqual(parseAuthorization(`bot ${bot}`), { token: bot, bot: true })
    assert.equal(parseAuthorization('Bot abc.def'), null)
  })

  test('no header, another scheme or no token: null', () => {
    assert.equal(parseAuthorization(null), null)
    assert.equal(parseAuthorization(''), null)
    assert.equal(parseAuthorization('Basic dXNlcjpwdw=='), null)
    assert.equal(parseAuthorization('Bearer'), null)
    assert.equal(parseAuthorization('Bearer '), null)
    assert.equal(parseAuthorization(`Token ${bot}`), null)
  })
})

describe('resolveBotTokenWith', () => {
  const now = new Date('2026-11-01T12:00:00Z')

  test('a live token resolves to the bot user, grant bot:<tokenId>, exp one hour ahead', async () => {
    const token = generateBotToken()
    const w = store(new Map([[hashBotToken(token), { tokenId: TOKEN_ID, botUserId: BOT, lastUsedAt: null }]]))
    const r = await resolveBotTokenWith(w.s, token, now)
    assert.deepEqual(r, { accountId: BOT, grantId: `bot:${TOKEN_ID}`, exp: Math.floor(now.getTime() / 1000) + 3600 })
    assert.deepEqual(w.lookups, [hashBotToken(token)])
  })

  test('an unknown, revoked or deleted-bot token is null (the store returns no live row)', async () => {
    const w = store(new Map())
    assert.equal(await resolveBotTokenWith(w.s, generateBotToken(), now), null)
    assert.equal(w.touches.length, 0)
  })

  test('a malformed token is null with no lookup', async () => {
    const w = store(new Map())
    assert.equal(await resolveBotTokenWith(w.s, 'hbot_nope', now), null)
    assert.equal(w.lookups.length, 0)
  })

  test('last_used_at is written at most once per minute', async () => {
    const token = generateBotToken()
    const hash = hashBotToken(token)
    const live = new Map([[hash, { tokenId: TOKEN_ID, botUserId: BOT, lastUsedAt: null as Date | null }]])
    const w = store(live)

    await resolveBotTokenWith(w.s, token, now)
    assert.equal(w.touches.length, 1)
    assert.deepEqual(w.touches[0], { tokenId: TOKEN_ID, now, before: new Date(now.getTime() - 60_000) })

    live.get(hash)!.lastUsedAt = new Date(now.getTime() - 30_000)
    await resolveBotTokenWith(w.s, token, now)
    assert.equal(w.touches.length, 1)

    live.get(hash)!.lastUsedAt = new Date(now.getTime() - 61_000)
    await resolveBotTokenWith(w.s, token, now)
    assert.equal(w.touches.length, 2)
  })

  test('a failed touch does not fail the request', async () => {
    const token = generateBotToken()
    const s: BotTokenStore = {
      findLive: async () => ({ tokenId: TOKEN_ID, botUserId: BOT, lastUsedAt: null }),
      touch: async () => {
        throw new Error('db down')
      },
    }
    const origError = console.error
    console.error = () => {}
    try {
      assert.equal((await resolveBotTokenWith(s, token, now))?.accountId, BOT)
      await new Promise((r) => setImmediate(r))
    } finally {
      console.error = origError
    }
  })
})
