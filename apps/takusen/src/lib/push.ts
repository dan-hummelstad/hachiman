/**
 * Push (contract §4 Push, §12.22). Takusen holds only ciphertext. The sender seals a preview
 * (sender name, text) to the push key of each recipient device, and Takusen relays the sealed
 * preview as it is: the device decrypts it (iOS: the Notification Service Extension, browser:
 * the service worker). A device without a sealed preview gets "New message".
 *
 * A push goes only to the devices without a live gateway session (`device_online:{id}`): an
 * open app shows its own notification. A user in Do Not Disturb gets no push.
 */
import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect } from 'node:http2'
import { and, eq, inArray, or } from 'drizzle-orm'

import { db } from '@/db/client'
import { devices, pushTargets } from '@/db/schema'
import { MissingPermissionsError, NotFoundError } from '@/lib/errors'
import { redis } from '@/lib/events'
import { loadChannelAccess, type ChannelAccess } from '@/lib/guild-access'
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

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest()

/**
 * RFC 8291 (aes128gcm, one record) for the subscription keys `p256dh` and `auth`. The push
 * service sees only this outer layer; the sealed preview inside it is for the device alone.
 */
export function encryptWebPush(plaintext: Buffer, p256dh: Buffer, auth: Buffer, salt: Buffer = randomBytes(16)): Buffer {
  const ecdh = createECDH('prime256v1')
  const asPublic = ecdh.generateKeys()
  const secret = ecdh.computeSecret(p256dh)
  const prkKey = hmac(auth, secret)
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), p256dh, asPublic, Buffer.from([1])]))
  const prk = hmac(salt, ikm)
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16)
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12)
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02: the padding delimiter of the last record.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(4096)
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body])
}

interface WebPushTarget {
  token: string
  p256dh: string | null
  auth: string | null
}

/** true: the target is gone and its row goes. */
async function sendWebPush(t: WebPushTarget, channelId: string, sealed: string | undefined): Promise<boolean> {
  const { key, publicKey } = vapidKey()
  const claims = {
    aud: new URL(t.token).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: process.env.TAKUSEN_VAPID_SUBJECT?.trim() || 'mailto:push@localhost',
  }
  const jwt = es256Jwt({ typ: 'JWT', alg: 'ES256' }, claims, key)
  const headers: Record<string, string> = { Authorization: `vapid t=${jwt}, k=${publicKey}`, TTL: '86400', Urgency: 'high' }
  let body: Uint8Array<ArrayBuffer> | undefined
  if (t.p256dh && t.auth) {
    body = new Uint8Array(encryptWebPush(Buffer.from(JSON.stringify({ c: channelId, ...(sealed ? { e: sealed } : {}) })), Buffer.from(t.p256dh, 'base64url'), Buffer.from(t.auth, 'base64url')))
    headers['Content-Encoding'] = 'aes128gcm'
    headers['Content-Type'] = 'application/octet-stream'
  }
  // Without a preview, a newer push of the channel replaces an undelivered one.
  if (!sealed) headers.Topic = channelId.replaceAll('-', '')
  const res = await fetch(t.token, { method: 'POST', redirect: 'error', headers, body })
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

/**
 * The APNs payload. With a sealed preview, `mutable-content` wakes the Notification Service
 * Extension, which replaces the fallback alert with the decrypted sender and text.
 */
export function apnsPayload(channelId: string, sealed: string | undefined): object {
  return {
    aps: {
      alert: { title: 'Hachiman', body: 'New message' },
      sound: 'default',
      'thread-id': channelId,
      ...(sealed ? { 'mutable-content': 1 } : {}),
    },
    c: channelId,
    ...(sealed ? { e: sealed } : {}),
  }
}

/** true: the token is gone and its row goes. */
async function sendApns(c: ApnsConfig, token: string, sandbox: boolean, channelId: string, sealed: string | undefined): Promise<boolean> {
  const headers: Record<string, string> = {
    ':method': 'POST',
    ':path': `/3/device/${token}`,
    authorization: `bearer ${apnsToken(c)}`,
    'apns-topic': c.topic,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'content-type': 'application/json',
  }
  // Without a preview, one "New message" per channel is enough.
  if (!sealed) headers['apns-collapse-id'] = channelId
  // ponytail: one HTTP/2 connection per push; keep a session per host when the push rate grows.
  const session = connect(sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com')
  try {
    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      session.on('error', reject)
      const req = session.request(headers)
      let status = 0
      let body = ''
      req.setEncoding('utf8')
      req.on('response', (h) => (status = Number(h[':status'])))
      req.on('data', (chunk: string) => (body += chunk))
      req.on('end', () => resolve({ status, body }))
      req.on('error', reject)
      req.end(JSON.stringify(apnsPayload(channelId, sealed)))
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
 * Pushes a new message to the offline devices of its recipients. A DM pushes to every other
 * participant, sealed or not. A guild message pushes only to the devices of `sealed` (the
 * sender seals for its mentions, as the mentions are inside the envelope), and only when their
 * user can view the channel. Call it after the commit and do not await it: a failed push loses
 * only the notification.
 */
export async function pushMessage(access: ChannelAccess, authorId: string, sealed: Record<string, string>): Promise<void> {
  const channelId = access.channel.id
  const guildId = access.channel.guildId
  const recipientIds = guildId === null ? access.participantIds.filter((u) => u !== authorId) : []
  const sealedIds = Object.keys(sealed)
  if (recipientIds.length === 0 && sealedIds.length === 0) return
  const rows = await db
    .select({
      deviceId: pushTargets.deviceId,
      userId: pushTargets.userId,
      kind: pushTargets.kind,
      token: pushTargets.token,
      sandbox: pushTargets.sandbox,
      p256dh: pushTargets.p256dh,
      auth: pushTargets.auth,
      kinds: pushTargets.kinds,
      quiet: pushTargets.quiet,
    })
    .from(pushTargets)
    .innerJoin(devices, eq(devices.id, pushTargets.deviceId))
    .where(
      and(
        eq(devices.status, 'active'),
        or(
          recipientIds.length > 0 ? inArray(pushTargets.userId, recipientIds) : undefined,
          sealedIds.length > 0 ? inArray(pushTargets.deviceId, sealedIds) : undefined,
        ),
      ),
    )
  const kind = guildId === null ? 'dm' : 'mention'
  // A sealed preview for a device of a user who may not read the channel is dropped, with its push.
  const users = [...new Set(rows.map((t) => t.userId))].filter((u) => u !== authorId)
  const allowed = new Set(
    guildId === null
      ? users.filter((u) => recipientIds.includes(u))
      : await viewersOf(channelId, users),
  )
  const candidates = rows.filter(
    (t) => allowed.has(t.userId) && t.kinds.includes(kind) && !t.quiet.includes(channelId) && !(guildId && t.quiet.includes(guildId)),
  )
  if (candidates.length === 0) return
  const r = redis()
  const online = await r.mget(...candidates.map((t) => `device_online:${t.deviceId}`))
  const pending = [...new Set(candidates.map((t) => t.userId))]
  const presence = await r.mget(...pending.map((u) => `presence:${u}`))
  const dnd = new Set(pending.filter((_, i) => presence[i] === 'dnd'))

  await Promise.all(
    candidates
      .filter((t, i) => online[i] === null && !dnd.has(t.userId))
      .map(async (t) => {
        const preview = sealed[t.deviceId]
        try {
          const c = apnsConfig()
          const gone =
            t.kind === 'apns' ? c !== null && (await sendApns(c, t.token, t.sandbox, channelId, preview)) : await sendWebPush(t, channelId, preview)
          // Only this token: the device may have registered a new one meanwhile.
          if (gone) await db.delete(pushTargets).where(and(eq(pushTargets.deviceId, t.deviceId), eq(pushTargets.token, t.token)))
        } catch (err) {
          console.error('[push] send failed', t.kind, err)
        }
      }),
  )
}

/** The push keys of the devices of `userIds` (§12.22), for a sender to seal previews to. */
export async function pushKeysOf(userIds: string[]): Promise<{ deviceId: string; userId: string; pushKey: string; signature: string }[]> {
  if (userIds.length === 0) return []
  const rows = await db
    .select({ deviceId: pushTargets.deviceId, userId: pushTargets.userId, pushKey: pushTargets.pushKey, signature: pushTargets.pushKeySig })
    .from(pushTargets)
    .innerJoin(devices, eq(devices.id, pushTargets.deviceId))
    .where(and(eq(devices.status, 'active'), inArray(pushTargets.userId, userIds)))
  return rows.flatMap((r) => (r.pushKey && r.signature ? [{ deviceId: r.deviceId, userId: r.userId, pushKey: r.pushKey, signature: r.signature }] : []))
}

/** The users of `userIds` who can view `channelId`: they may get its pushes and push keys. */
export async function viewersOf(channelId: string, userIds: string[]): Promise<string[]> {
  const can = await Promise.all(
    userIds.map(async (u) => {
      try {
        await loadChannelAccess(channelId, u)
        return true
      } catch (err) {
        // 403 and 404 are the answer. Anything else is logged: it would hide a push silently.
        if (!(err instanceof NotFoundError || err instanceof MissingPermissionsError)) console.error('[push] view check failed', err)
        return false
      }
    }),
  )
  return userIds.filter((_, i) => can[i])
}
