/**
 * Content-free push (contract §4 Push). Takusen holds only ciphertext, so a push says "a new
 * message" and names no sender, channel or text. APNs gets an alert with the channel id (for the
 * tap and the collapse id). Web Push gets no payload at all: an empty push needs no RFC 8291
 * encryption, only the VAPID JWT.
 *
 * A push goes only to the devices without a live gateway session (`device_online:{id}`): an
 * open app shows its own notification. A user in Do Not Disturb gets no push.
 */
import { createECDH, createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect } from 'node:http2'
import { and, eq, inArray } from 'drizzle-orm'

import { db } from '@/db/client'
import { devices, pushTargets } from '@/db/schema'
import { redis } from '@/lib/events'
import { loadOrCreateSeed } from '@/lib/mls/keys'

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url')

/** A compact ES256 JWT. JWS wants the raw r‖s signature, not DER. */
export function es256Jwt(header: object, claims: object, key: KeyObject): string {
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`
  return `${input}.${b64u(sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }))}`
}

/** A P-256 key from its 32-byte scalar, and the 65-byte uncompressed public point. */
export function p256FromScalar(d: Uint8Array): { key: KeyObject; publicKey: Buffer } {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(d)
  const pub = ecdh.getPublicKey()
  const key = createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: b64u(Buffer.from(d)), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) },
  })
  return { key, publicKey: pub }
}

let vapid: { key: KeyObject; publicKey: string } | undefined

/**
 * The VAPID key: a P-256 scalar in `TAKUSEN_VAPID_KEY` (relative to apps/takusen), created on
 * first use like the DS key. All Takusen instances must share the file: a new key orphans every
 * browser subscription.
 */
function vapidKey(): { key: KeyObject; publicKey: string } {
  if (!vapid) {
    const { key, publicKey } = p256FromScalar(
      loadOrCreateSeed(process.env.TAKUSEN_VAPID_KEY?.trim() || '.dev/keys/takusen-vapid.p256'),
    )
    vapid = { key, publicKey: b64u(publicKey) }
  }
  return vapid
}

/** The `applicationServerKey` for `PushManager.subscribe` (base64url). */
export const vapidPublicKey = (): string => vapidKey().publicKey

/**
 * The push services a browser subscription may name. Takusen POSTs to the endpoint, so any other
 * host would be a server-side request forgery.
 */
const WEB_PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/]

export function isWebPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint)
    return u.protocol === 'https:' && u.port === '' && WEB_PUSH_HOSTS.some((h) => h.test(u.hostname))
  } catch {
    return false
  }
}

/** true: the target is gone and its row goes. */
async function sendWebPush(endpoint: string, channelId: string): Promise<boolean> {
  const { key, publicKey } = vapidKey()
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: process.env.TAKUSEN_VAPID_SUBJECT?.trim() || 'mailto:push@localhost',
  }
  const jwt = es256Jwt({ typ: 'JWT', alg: 'ES256' }, claims, key)
  const res = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: `vapid t=${jwt}, k=${publicKey}`,
      TTL: '86400',
      Urgency: 'high',
      // A newer push of the channel replaces an undelivered one (32 base64url chars at most).
      Topic: channelId.replaceAll('-', ''),
    },
  })
  if (res.status === 404 || res.status === 410) return true
  if (!res.ok) console.error('[push] web push', res.status, await res.text().catch(() => ''))
  return false
}

interface ApnsConfig {
  key: KeyObject
  keyId: string
  teamId: string
  topic: string
}

let apns: ApnsConfig | null | undefined
let apnsJwt: { token: string; at: number } | undefined

/** APNs is on when `TAKUSEN_APNS_KEY` names the .p8 key of the Apple developer account. */
function apnsConfig(): ApnsConfig | null {
  if (apns === undefined) {
    const path = process.env.TAKUSEN_APNS_KEY?.trim()
    const keyId = process.env.TAKUSEN_APNS_KEY_ID?.trim()
    const teamId = process.env.TAKUSEN_APNS_TEAM_ID?.trim()
    apns =
      path && keyId && teamId
        ? { key: createPrivateKey(readFileSync(path)), keyId, teamId, topic: process.env.TAKUSEN_APNS_TOPIC?.trim() || 'app.hachiman.ios' }
        : null
  }
  return apns
}

/** APNs refuses a token refresh more often than every 20 minutes and a token older than an hour. */
function apnsToken(c: ApnsConfig): string {
  if (!apnsJwt || Date.now() - apnsJwt.at > 50 * 60_000) {
    const at = Date.now()
    apnsJwt = { token: es256Jwt({ alg: 'ES256', kid: c.keyId }, { iss: c.teamId, iat: Math.floor(at / 1000) }, c.key), at }
  }
  return apnsJwt.token
}

const APNS_GONE = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'])

/** true: the token is gone and its row goes. */
async function sendApns(c: ApnsConfig, token: string, sandbox: boolean, channelId: string): Promise<boolean> {
  const payload = JSON.stringify({
    aps: { alert: { title: 'Hachiman', body: 'New message' }, sound: 'default', 'thread-id': channelId },
    channelId,
  })
  // ponytail: one HTTP/2 connection per push; keep a session per host when the push rate grows.
  const session = connect(sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com')
  try {
    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      session.on('error', reject)
      const req = session.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: `bearer ${apnsToken(c)}`,
        'apns-topic': c.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-collapse-id': channelId,
        'content-type': 'application/json',
      })
      let status = 0
      let body = ''
      req.setEncoding('utf8')
      req.on('response', (h) => (status = Number(h[':status'])))
      req.on('data', (chunk: string) => (body += chunk))
      req.on('end', () => resolve({ status, body }))
      req.on('error', reject)
      req.end(payload)
    })
    if (status === 200) return false
    const reason = (JSON.parse(body || '{}') as { reason?: string }).reason ?? ''
    if (status === 410 || APNS_GONE.has(reason)) return true
    console.error('[push] apns', status, reason)
    return false
  } finally {
    session.close()
  }
}

/**
 * Pushes "a new message in `channelId`" to the offline devices of `userIds`. Call it after the
 * commit and do not await it: a failed push loses only the notification.
 */
export async function pushNewMessage(userIds: string[], channelId: string): Promise<void> {
  if (userIds.length === 0) return
  const rows = await db
    .select({ deviceId: pushTargets.deviceId, userId: pushTargets.userId, kind: pushTargets.kind, token: pushTargets.token, sandbox: pushTargets.sandbox })
    .from(pushTargets)
    .innerJoin(devices, eq(devices.id, pushTargets.deviceId))
    .where(and(inArray(pushTargets.userId, userIds), eq(devices.status, 'active')))
  if (rows.length === 0) return
  const r = redis()
  const online = await r.mget(...rows.map((t) => `device_online:${t.deviceId}`))
  const users = [...new Set(rows.map((t) => t.userId))]
  const presence = await r.mget(...users.map((u) => `presence:${u}`))
  const dnd = new Set(users.filter((_, i) => presence[i] === 'dnd'))

  await Promise.all(
    rows
      .filter((t, i) => online[i] === null && !dnd.has(t.userId))
      .map(async (t) => {
        try {
          const c = apnsConfig()
          const gone = t.kind === 'apns' ? c !== null && (await sendApns(c, t.token, t.sandbox, channelId)) : await sendWebPush(t.token, channelId)
          // Only this token: the device may have registered a new one meanwhile.
          if (gone) await db.delete(pushTargets).where(and(eq(pushTargets.deviceId, t.deviceId), eq(pushTargets.token, t.token)))
        } catch (err) {
          console.error('[push] send failed', t.kind, err)
        }
      }),
  )
}
