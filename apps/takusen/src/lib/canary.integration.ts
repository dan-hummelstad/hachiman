/**
 * The E2EE canary (docs/e2ee-plan.md "Verification", docs/gateway-protocol.md §12).
 *
 * An opt-in script against a running deployment. It sends one message whose
 * text is a unique random string, with one attachment whose file name (only
 * inside the encrypted pointer) is a second unique random string. It goes
 * through the real route handlers over HTTP. Then it scans:
 *   - every text, varchar, json, jsonb and bytea column of every table in the
 *     public schema (uploads.filename included),
 *   - the S3 object of the attachment,
 *   - a Redis MONITOR capture taken while the message was sent.
 * It fails when either string is found anywhere.
 *
 * Run:
 *   tsx --env-file-if-exists=../../.env src/lib/canary.integration.ts
 * It needs DATABASE_URL, REDIS_URL and the S3_* variables of the deployment,
 * and a member device that holds a leaf in the channel's group:
 *   CANARY_BASE_URL    Takusen origin, for example http://localhost:3000
 *   CANARY_TOKEN       a Takusen access token of the user
 *   CANARY_DEVICE_ID   an active device of the user with a leaf in the group
 *   CANARY_CHANNEL_ID  a text or DM channel with an active group
 * Without them, it prints why and exits 0 (skipped).
 *
 * The envelope is a real @hachiman/crypto envelope. The canary does not hold
 * the epoch secret or the device key, so it seals with random keys. The server
 * checks only the header (§12.8.4), so the request takes the production path.
 * Members cannot decrypt the canary message: use a test channel.
 */
import { randomBytes } from 'node:crypto'

import { Redis } from 'ioredis'
import postgres from 'postgres'

import { getObjectStream } from '@/lib/storage'

import type { AttachmentPointer } from '../../../../pkgs/hachiman-crypto/src/api'
import { attachments } from '../../../../pkgs/hachiman-crypto/src/attachments/index'
import { envelope } from '../../../../pkgs/hachiman-crypto/src/envelope/index'

const REQUIRED = ['DATABASE_URL', 'REDIS_URL', 'S3_BUCKET', 'CANARY_BASE_URL', 'CANARY_TOKEN', 'CANARY_DEVICE_ID', 'CANARY_CHANNEL_ID'] as const
const DUMMY_DATABASE = 'localhost:1/'

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url')

function env(name: (typeof REQUIRED)[number]): string {
  return process.env[name]!.trim()
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${env('CANARY_TOKEN')}`)
  headers.set('X-Hachiman-Device', env('CANARY_DEVICE_ID'))
  const res = await fetch(new URL(path, env('CANARY_BASE_URL')), { ...init, headers })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${text}`)
  return JSON.parse(text) as T
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = []
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) parts.push(chunk)
  return Buffer.concat(parts)
}

/** Every public text-like and bytea column that holds `needle`, as "table.column (n rows)". */
async function scanPostgres(sql: postgres.Sql, needle: string): Promise<string[]> {
  const columns = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
    select c.table_name, c.column_name, c.data_type
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      and c.data_type in ('text', 'character varying', 'character', 'json', 'jsonb', 'bytea', 'ARRAY')`
  const bytes = Buffer.from(needle, 'utf8')
  const hits: string[] = []
  for (const c of columns) {
    const col = sql(c.column_name)
    const table = sql(c.table_name)
    const [row] =
      c.data_type === 'bytea'
        ? await sql<{ n: number }[]>`select count(*)::int as n from ${table} where position(${bytes}::bytea in ${col}) > 0`
        : await sql<{ n: number }[]>`select count(*)::int as n from ${table} where strpos(${col}::text, ${needle}) > 0`
    if (row && row.n > 0) hits.push(`${c.table_name}.${c.column_name} (${row.n} rows)`)
  }
  return hits
}

async function main(): Promise<number> {
  const missing = REQUIRED.filter((k) => !process.env[k]?.trim())
  if (missing.length > 0 || env('DATABASE_URL').includes(DUMMY_DATABASE)) {
    console.log(`[canary] skipped: set ${missing.length > 0 ? missing.join(', ') : 'a real DATABASE_URL'}`)
    return 0
  }
  const secret = `canary-text-${randomBytes(16).toString('hex')}`
  const fileName = `canary-file-${randomBytes(16).toString('hex')}.txt`
  const channelId = env('CANARY_CHANNEL_ID')
  const deviceId = env('CANARY_DEVICE_ID')

  const sql = postgres(env('DATABASE_URL'), { max: 2 })
  const redis = new Redis(env('REDIS_URL'))
  const monitor = await redis.monitor()
  const captured: string[] = []
  monitor.on('monitor', (_time: string, args: string[]) => captured.push(args.join(' ')))

  try {
    // 1. The group, epoch and the sender leaf of the device.
    const group = await api<{ groupId: string; epoch: number | null; status: string }>(`/api/v1/channels/${channelId}/mls-group`)
    if (group.status !== 'active' || group.epoch === null) throw new Error(`the channel group is ${group.status}`)
    const groupId = Buffer.from(group.groupId, 'base64url')
    const [member] = await sql<{ leaf_index: number }[]>`
      select leaf_index from mls_group_members where group_id = ${groupId} and device_id = ${deviceId}`
    if (!member) throw new Error('the canary device has no leaf in the channel group')

    // 2. The attachment: the file body holds the secret too.
    const fileBytes = new TextEncoder().encode(`${secret}\n${fileName}\n`)
    const fileKey = attachments.generateKey()
    const { blob, sha256 } = await attachments.encrypt(new Blob([fileBytes]), fileKey)
    const blobBytes = new Uint8Array(await blob.arrayBuffer())
    const upload = await api<{ id: string; key: string; size: number }>('/api/v1/uploads?kind=blob', { method: 'POST', body: blobBytes })
    const pointer: AttachmentPointer = {
      uploadId: upload.id,
      key: b64(fileKey),
      sha256: b64(sha256),
      size: fileBytes.length,
      blobSize: blobBytes.length,
      mime: 'text/plain',
      name: fileName,
      width: null,
      height: null,
      durationMs: null,
      blurhash: null,
      thumbnail: null,
    }

    // 3. The envelope, sealed with random keys (see the header comment).
    const sealed = await envelope.seal({
      header: { groupId, channelId, epoch: group.epoch, senderLeaf: member.leaf_index, senderDeviceId: deviceId, clientMsgId: randomBytes(16) },
      kind: 'message',
      editOf: null,
      content: { text: secret, mentions: [], attachments: [pointer], replyTo: null, sentAtMs: Date.now() },
      epochSecret: randomBytes(32),
      signatureKey: randomBytes(32),
      ktTreeHead: null,
    })
    const message = await api<{ id: string }>(`/api/v1/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ envelope: b64(sealed), attachments: [upload.id] }),
    })
    await new Promise((r) => setTimeout(r, 1000))

    // 4. Scan.
    const leaks: string[] = []
    for (const needle of [secret, fileName]) {
      for (const hit of await scanPostgres(sql, needle)) leaks.push(`postgres ${hit} holds ${needle}`)
      const object = await readAll(await getObjectStream(upload.key))
      if (object.includes(Buffer.from(needle))) leaks.push(`s3 ${upload.key} holds ${needle}`)
      for (const line of captured) if (line.includes(needle)) leaks.push(`redis: ${line.slice(0, 200)}`)
    }
    // A positive control, so an empty scan cannot pass by accident.
    if ((await scanPostgres(sql, `${upload.id}/blob`)).length === 0) leaks.push('control: uploads.key is not found, so the scan is broken')
    if (!captured.some((l) => l.includes('MESSAGE_CREATE'))) leaks.push('control: MONITOR captured no MESSAGE_CREATE publish')

    if (leaks.length > 0) {
      console.error('[canary] FAILED')
      for (const l of leaks) console.error(`  ${l}`)
      return 1
    }
    console.log(`[canary] ok: message ${message.id}, upload ${upload.id}; no plaintext in Postgres, S3 or Redis`)
    return 0
  } finally {
    monitor.disconnect()
    redis.disconnect()
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
