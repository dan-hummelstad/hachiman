/**
 * The E2EE canary (docs/e2ee-plan.md "Verification", docs/gateway-protocol.md §12).
 *
 * Two real clients run headlessly in this process: @hachiman/client (REST + gateway WebSocket)
 * and the @hachiman/crypto engine (in-process instead of a Worker, store in fake-indexeddb).
 *   1. Two new users sign in through Takusen (Auth.js credentials + OIDC code flow with PKCE)
 *      and set up their first device (identity, certificate, key packages).
 *   2. Alice makes a guild, Bob joins it with an invite. Alice makes a private channel that only
 *      she and Bob can view, and opens a DM with Bob. The guild's #general is the public channel.
 *   3. In each of the four channels (the fourth is a public pages channel) Alice sends a
 *      message whose text holds a unique canary string, with an attachment whose name and bytes
 *      hold it too.
 *   4. Bob decrypts every message and every attachment, and checks the canary. In the pages
 *      channel Alice also creates a page whose title holds the canary, posts a page update whose
 *      bytes hold it, and claims a page image whose name and bytes hold it (§4 Pages, §12.20).
 *      Bob decrypts all three.
 *   5. The scan: every text, JSON, array and bytea column of every table, every object in the
 *      bucket, every key of the Redis database, a Redis MONITOR capture of that database (all
 *      commands, PUBLISH frames included), and every HTTP body and WebSocket frame of both
 *      clients. The canary must be in none of them, as UTF-8, hex, base64 or base64url.
 *   Positive controls make sure that an empty scan cannot pass by accident.
 *
 * It writes users, guilds and messages: run it only against a test deployment.
 *
 * Run (from apps/takusen, with Takusen, its gRPC process and the gateway up on that deployment):
 *   node --env-file=<env> --import tsx src/e2ee/canary.integration.ts
 * Env: DATABASE_URL, REDIS_URL, S3_* (the deployment's values), and
 *   CANARY_BASE_URL     Takusen origin, for example http://localhost:3100
 *   CANARY_GATEWAY_URL  for example ws://localhost:8180/gateway
 *   CANARY_REDIRECT_URI optional, a redirect URI of hachiman-client (default
 *                       http://localhost:5173/oauth/callback)
 * Without CANARY_BASE_URL and CANARY_GATEWAY_URL it prints why and exits 0 (skipped).
 * It creates the S3 bucket when it does not exist.
 */
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { Permissions, type Message } from '@hachiman/client'
import { blobKey } from '@hachiman/client/files'
import type { AttachmentPointer } from '@hachiman/crypto'
import { Redis } from 'ioredis'
import postgres from 'postgres'

import { pointerOf } from '../../../hachiman/src/lib/attachments'
import { createUser, signIn } from './canary-auth'
import { CanaryClient, waitFor } from './canary-client'
import { encodedForms, findForms, scanPostgres, scanRedis, scanS3 } from './canary-scan'

const DUMMY_DATABASE = 'localhost:1/'

const log = (line: string) => console.log(`[canary] ${line}`)

function env(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) throw new Error(`canary: ${name} is not set`)
  return v
}

/** Every HTTP body and WebSocket frame of this process, both directions. */
const traffic: { where: string; data: Buffer }[] = []

async function bytesOf(body: unknown): Promise<Buffer | null> {
  if (body === undefined || body === null) return null
  if (typeof body === 'string') return Buffer.from(body)
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer())
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (body instanceof URLSearchParams) return Buffer.from(body.toString())
  return Buffer.from(String(body))
}

function captureTraffic(): void {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const sent = await bytesOf(init?.body)
    if (sent) traffic.push({ where: `http request ${init?.method ?? 'GET'} ${url}`, data: sent })
    const res = await realFetch(input, init)
    const copy = res.clone()
    traffic.push({ where: `http response ${res.status} ${url}`, data: Buffer.from(await copy.arrayBuffer()) })
    return res
  }
  const RealWebSocket = globalThis.WebSocket
  class CapturingWebSocket extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      this.addEventListener('message', (e: MessageEvent) => {
        void bytesOf(e.data).then((b) => b && traffic.push({ where: `ws in ${String(url)}`, data: b }))
      })
    }
    override send(data: Parameters<WebSocket['send']>[0]): void {
      void bytesOf(data).then((b) => b && traffic.push({ where: `ws out`, data: b }))
      super.send(data)
    }
  }
  globalThis.WebSocket = CapturingWebSocket as typeof WebSocket
}

async function ensureBucket(s3: S3Client, bucket: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }))
    log(`created bucket ${bucket}`)
  }
}

/** Encrypt, upload and point to one file, as UploadService.uploadAttachment does (without XHR). */
async function uploadAttachment(c: CanaryClient, base: string, token: string, name: string, bytes: Uint8Array<ArrayBuffer>, mime = 'text/plain'): Promise<AttachmentPointer> {
  const encrypted = await c.engine.api.encryptAttachment({
    file: new Blob([bytes]),
    name,
    mime,
    width: null,
    height: null,
    durationMs: null,
    blurhash: null,
    thumbnail: null,
  })
  const res = await fetch(`${base}/api/v1/uploads?kind=blob`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-hachiman-device': c.deviceId!, 'content-type': 'application/octet-stream', accept: 'application/json' },
    body: encrypted.blob,
  })
  if (!res.ok) throw new Error(`canary: upload ${res.status} ${await res.text()}`)
  return pointerOf(encrypted.draft, (await res.json()) as { id: string; key: string; size: number }, null)
}

async function main(): Promise<number> {
  const missing = ['DATABASE_URL', 'REDIS_URL', 'S3_BUCKET', 'S3_ENDPOINT', 'CANARY_BASE_URL', 'CANARY_GATEWAY_URL'].filter((k) => !process.env[k]?.trim())
  if (missing.length > 0 || env('DATABASE_URL').includes(DUMMY_DATABASE)) {
    log(`skipped: set ${missing.length > 0 ? missing.join(', ') : 'a real DATABASE_URL'}`)
    return 0
  }
  const base = env('CANARY_BASE_URL').replace(/\/$/, '')
  const gatewayUrl = env('CANARY_GATEWAY_URL')
  const redirectUri = process.env.CANARY_REDIRECT_URI?.trim() || 'http://localhost:5173/oauth/callback'
  const bucket = env('S3_BUCKET')
  const redisUrl = env('REDIS_URL')
  const redisDb = new URL(redisUrl).pathname.replace(/^\//, '') || '0'

  // The engine's store: IndexedDB in Node (a devDependency of @hachiman/crypto).
  const cryptoRequire = createRequire(new URL('../../../../pkgs/hachiman-crypto/package.json', import.meta.url))
  await import(pathToFileURL(cryptoRequire.resolve('fake-indexeddb/auto')).href)

  const tag = randomBytes(12).toString('hex')
  const canary = `canary-${randomBytes(20).toString('hex')}`
  const control = `canary-control-guild-${tag}`
  const forms = encodedForms(canary)

  const sql = postgres(env('DATABASE_URL'), { max: 2, onnotice: () => {} })
  const redis = new Redis(redisUrl)
  const s3 = new S3Client({
    endpoint: env('S3_ENDPOINT'),
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    credentials: { accessKeyId: env('S3_ACCESS_KEY_ID'), secretAccessKey: env('S3_SECRET_ACCESS_KEY') },
  })
  await ensureBucket(s3, bucket)

  const monitorLines: string[] = []
  const monitor = await redis.monitor()
  monitor.on('monitor', (_time: string, args: string[], _source: string, database: string) => {
    if (database === redisDb) monitorLines.push(args.join(' '))
  })
  captureTraffic()

  const clients: CanaryClient[] = []
  try {
    // 1. Two users, each with a first device.
    const users = []
    for (const name of ['alice', 'bob']) {
      const email = `${name}-${tag}@canary.test`
      const password = randomBytes(18).toString('base64url')
      const id = await createUser(sql, email, password, `${name}-${tag.slice(0, 6)}`)
      const accessToken = await signIn(base, email, password, redirectUri)
      const client = new CanaryClient({ name, userId: id, accessToken, base, gatewayUrl, log })
      clients.push(client)
      const status = await client.start()
      log(`${name}: user ${id}, device ${status.deviceId}`)
      users.push({ id, accessToken, client })
    }
    const [alice, bob] = users as [(typeof users)[number], (typeof users)[number]]
    const A = alice.client
    const B = bob.client

    // 2. The guild (its name is the positive control), Bob joins, the private channel, the DM.
    const guild = await A.hachiman.rest.createGuild({ name: control })
    const general = guild.channels.find((c) => c.type === 'text')
    if (!general) throw new Error('canary: the new guild has no text channel')
    const invite = await A.hachiman.rest.createInvite(guild.id, {})
    await B.hachiman.rest.acceptInvite(invite.code)
    await waitFor('Bob sees the guild', () => (B.hachiman.cache.channels.has(general.id) ? true : undefined))
    await waitFor('Alice sees Bob as a member', () => (A.hachiman.cache.members.get(guild.id)?.has(bob.id) ? true : undefined))

    const priv = await A.hachiman.rest.createChannel(guild.id, { name: 'canary-private', type: 'text' })
    await A.hachiman.rest.putOverwrite(priv.id, guild.id, { type: 'role', allow: 0, deny: Permissions.VIEW_CHANNEL })
    await A.hachiman.rest.putOverwrite(priv.id, bob.id, { type: 'member', allow: Permissions.VIEW_CHANNEL, deny: 0 })
    await waitFor('both see the private channel', () =>
      A.hachiman.cache.channels.get(priv.id)?.permissionOverwrites?.length === 2 && B.hachiman.cache.channels.has(priv.id) ? true : undefined,
    )

    const pagesChannel = await A.hachiman.rest.createChannel(guild.id, { name: 'canary-pages', type: 'pages' })
    await waitFor('Bob sees the pages channel', () => (B.hachiman.cache.channels.has(pagesChannel.id) ? true : undefined))

    const dm = await A.hachiman.rest.openDm([bob.id])
    await waitFor('Bob sees the DM', () => (B.hachiman.cache.channels.has(dm.id) ? true : undefined), 15_000).catch(() => undefined)

    // 3 + 4. Send in each channel; Bob decrypts the text and the attachment.
    const channels = [
      { label: 'dm', id: dm.id },
      { label: 'private', id: priv.id },
      { label: 'public', id: general.id },
      { label: 'pages', id: pagesChannel.id },
    ]
    // Bob opens each channel (§12.7.8: the first open of a public channel joins the public_set
    // group). Alice sends only when both devices hold a leaf in the channel's current group:
    // with history visibility 'joined', a message from before Bob's Add is not for him.
    for (const ch of channels) {
      await B.engine.api.ensureChannelGroup(ch.id).catch((e: unknown) => log(`bob ensureChannelGroup ${ch.label}: ${String(e)}`))
      await waitFor(
        `both devices in the ${ch.label} group`,
        async () => {
          const [row] = await sql<{ n: number }[]>`
            select count(*)::int as n from mls_group_members m
            join channels c on c.mls_group_id = m.group_id
            join mls_groups g on g.group_id = m.group_id and g.status = 'active'
            where c.id = ${ch.id} and m.device_id in ${sql([A.deviceId!, B.deviceId!])}`
          return row!.n === 2 ? true : undefined
        },
        60_000,
      )
    }
    const sent: Message[] = []
    for (const ch of channels) {
      const text = `${canary}:${ch.label}`
      const name = `${canary}-${ch.label}.txt`
      const fileBytes = new TextEncoder().encode(`attachment of ${text}\n`.repeat(8))
      const pointer = await uploadAttachment(A, base, alice.accessToken, name, fileBytes)
      const message = await A.send(ch.id, text, [pointer])
      sent.push(message)
      log(`${ch.label}: Alice sent ${message.id} (group ${message.groupId} epoch ${message.epoch})`)

      const echo = await waitFor(`Bob's MESSAGE_CREATE in ${ch.label}`, () => B.received.get(message.id))
      const result = await B.decrypt(echo)
      if (result.content.text !== text) throw new Error(`canary: Bob decrypted "${result.content.text}" in ${ch.label}`)
      if (result.sender.userId !== alice.id) throw new Error(`canary: wrong sender ${result.sender.userId}`)
      const got = result.content.attachments[0]
      if (!got || got.name !== name || echo.attachments.length !== 1) throw new Error(`canary: attachment pointer lost in ${ch.label}`)
      const blob = await B.hachiman.rest.fetchBlob(echo.attachments[0]!.key)
      const plain = new Uint8Array(await (await B.engine.api.decryptAttachment(got, blob)).arrayBuffer())
      if (Buffer.compare(Buffer.from(plain), Buffer.from(fileBytes)) !== 0) throw new Error(`canary: attachment bytes differ in ${ch.label}`)
      log(`${ch.label}: Bob decrypted the text and the attachment (trust ${result.sender.trust})`)
    }

    // History through REST decrypts too.
    for (const [i, ch] of channels.entries()) {
      const page = await B.hachiman.rest.getMessages(ch.id, { limit: 10 })
      const m = page.find((x) => x.id === sent[i]!.id)
      if (!m) throw new Error(`canary: ${ch.label} history lacks the message`)
      if ((await B.decrypt(m)).content.text !== `${canary}:${ch.label}`) throw new Error(`canary: ${ch.label} history decrypts wrong`)
    }
    log('history pages decrypt')

    // A page in the pages channel: title, update and image (§4 Pages, §12.20).
    const utf8 = new TextEncoder()
    const pageTitle = `${canary}:page-title`
    const pageText = `${canary}:page-text`
    const pageId = crypto.randomUUID()
    const title = await A.engine.api.encryptDoc({ channelId: pagesChannel.id, pageId, kind: 'doc_title', bytes: utf8.encode(pageTitle) })
    await A.hachiman.rest.createPage(pagesChannel.id, { id: pageId, parentId: null, position: 0, titleEnvelope: title.envelope })
    const update = await A.engine.api.encryptDoc({ channelId: pagesChannel.id, pageId, kind: 'doc_update', bytes: utf8.encode(pageText) })
    const { seq } = await A.hachiman.rest.postPageUpdate(pageId, { envelope: update.envelope })
    const imageName = `${canary}-page.png`
    const imageBytes = utf8.encode(`page image of ${canary}\n`.repeat(8))
    const image = await uploadAttachment(A, base, alice.accessToken, imageName, imageBytes, 'image/png')
    await A.hachiman.rest.claimPageMedia(pageId, [image.uploadId])
    log(`pages: Alice made page ${pageId} (update seq ${seq}, image ${image.uploadId})`)

    const page = (await B.hachiman.rest.getPages(pagesChannel.id)).find((p) => p.id === pageId)
    if (!page) throw new Error('canary: Bob does not list the page')
    const posted = (await B.hachiman.rest.getPageUpdates(pageId, { after: 0 })).updates.find((u) => u.seq === seq)
    if (!posted) throw new Error('canary: Bob does not read the page update')
    const docResults = await B.engine.api.decryptDoc([
      { id: 'title', channelId: pagesChannel.id, pageId, kind: 'doc_title', senderDevice: null, envelope: page.titleEnvelope },
      { id: 'update', channelId: pagesChannel.id, pageId, kind: 'doc_update', senderDevice: posted.senderDevice, envelope: posted.envelope },
    ])
    const decoded = docResults.map((r) => (r.status === 'ok' ? new TextDecoder().decode(r.bytes) : `${r.status}:${r.reason}`))
    if (decoded[0] !== pageTitle) throw new Error(`canary: Bob decrypted the page title as "${decoded[0]}"`)
    if (decoded[1] !== pageText) throw new Error(`canary: Bob decrypted the page update as "${decoded[1]}"`)
    const imageBlob = await B.hachiman.rest.fetchBlob(blobKey(image.uploadId))
    const imagePlain = new Uint8Array(await (await B.engine.api.decryptAttachment(image, imageBlob)).arrayBuffer())
    if (Buffer.compare(Buffer.from(imagePlain), Buffer.from(imageBytes)) !== 0) throw new Error('canary: the page image bytes differ')
    log('pages: Bob decrypted the page title, the page update and the page image')

    for (const c of clients) await c.stop()
    await new Promise((r) => setTimeout(r, 1500))

    // 5. The scan.
    const leaks: string[] = []
    const pg = await scanPostgres(sql, forms)
    leaks.push(...pg.hits)
    const objects = await scanS3(s3, bucket, forms)
    leaks.push(...objects.hits)
    const keys = await scanRedis(redis, forms)
    leaks.push(...keys.hits)
    for (const line of monitorLines) for (const f of findForms(line, forms)) leaks.push(`redis command: holds "${f}": ${line.slice(0, 160)}`)
    for (const t of traffic) for (const f of findForms(t.data, forms)) leaks.push(`${t.where}: holds "${f}"`)
    log(`scanned ${pg.columns} columns, ${objects.objects} objects, ${keys.keys} keys, ${monitorLines.length} Redis commands, ${traffic.length} HTTP bodies and WS frames`)

    // Positive controls: the same scanners find a string that is meant to be there.
    const controlForms = [control]
    if ((await scanPostgres(sql, controlForms)).hits.length === 0) leaks.push('control: the guild name is not found in Postgres, so the scan is broken')
    if (!monitorLines.some((l) => l.includes(control))) leaks.push('control: MONITOR captured no frame with the guild name')
    if (!monitorLines.some((l) => /^publish /i.test(l) && l.includes('MESSAGE_CREATE'))) leaks.push('control: MONITOR captured no MESSAGE_CREATE publish')
    if (!monitorLines.some((l) => /^publish /i.test(l) && l.includes('DOC_UPDATE'))) leaks.push('control: MONITOR captured no DOC_UPDATE publish')
    if (!traffic.some((t) => t.where.startsWith('ws in') && t.data.includes('MESSAGE_CREATE'))) leaks.push('control: no MESSAGE_CREATE frame was captured')
    if (objects.objects < channels.length + 1) leaks.push(`control: the bucket has ${objects.objects} objects, fewer than the uploads`)
    if (findForms(Buffer.from(`xx${canary}yy`).toString('base64'), forms).length === 0) leaks.push('control: the base64 form does not match')

    if (leaks.length > 0) {
      console.error('[canary] FAILED')
      for (const l of leaks) console.error(`  ${l}`)
      return 1
    }
    log(`ok: ${canary} decrypted in ${channels.length} channels and one page, and is in no Postgres column, S3 object, Redis key, Redis command or client frame`)
    return 0
  } finally {
    for (const c of clients) await c.stop().catch(() => undefined)
    monitor.disconnect()
    redis.disconnect()
    s3.destroy()
    await sql.end()
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error('[canary] error', err)
    process.exit(1)
  },
)
