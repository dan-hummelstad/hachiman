/**
 * Canary scanners (src/e2ee/canary.integration.ts): every place the server side can keep or relay
 * bytes, searched for a needle in raw and encoded forms.
 */
import { ListObjectsV2Command, GetObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import type { Redis } from 'ioredis'
import type postgres from 'postgres'

/**
 * The forms a leak can take: UTF-8, hex, and base64 / base64url at each of the three byte
 * alignments (the needle can start anywhere inside an encoded value, so each form is the part
 * of the encoding that only needle bytes make).
 */
export function encodedForms(needle: string): string[] {
  const bytes = Buffer.from(needle, 'utf8')
  const forms = new Set<string>([needle, bytes.toString('hex')])
  for (let k = 0; k < 3; k++) {
    const enc = Buffer.concat([Buffer.alloc(k), bytes]).toString('base64')
    const full = Math.floor((k + bytes.length) / 3)
    const core = enc.slice(k === 0 ? 0 : 4, full * 4)
    if (core.length >= 16) {
      forms.add(core)
      forms.add(core.replace(/\+/g, '-').replace(/\//g, '_'))
    }
  }
  return [...forms]
}

/** The forms of `needle` that `haystack` holds. */
export function findForms(haystack: Buffer | string, forms: string[]): string[] {
  const buf = typeof haystack === 'string' ? Buffer.from(haystack, 'utf8') : haystack
  return forms.filter((f) => buf.includes(Buffer.from(f, 'utf8')))
}

/** Every text-like, JSON, array and bytea column of every table in the public schema. */
export async function scanPostgres(sql: postgres.Sql, forms: string[]): Promise<{ hits: string[]; columns: number }> {
  const columns = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
    select c.table_name, c.column_name, c.data_type
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      and c.data_type in ('text', 'character varying', 'character', 'json', 'jsonb', 'bytea', 'ARRAY', 'USER-DEFINED')`
  const hits: string[] = []
  for (const c of columns) {
    const col = sql(c.column_name)
    const table = sql(c.table_name)
    for (const form of forms) {
      const [row] =
        c.data_type === 'bytea'
          ? await sql<{ n: number }[]>`
              select count(*)::int as n from ${table}
              where position(${Buffer.from(form, 'utf8')}::bytea in ${col}) > 0
                 or strpos(encode(${col}, 'base64'), ${form}) > 0
                 or strpos(translate(encode(${col}, 'base64'), E'+/\n', '-_'), ${form}) > 0`
          : await sql<{ n: number }[]>`select count(*)::int as n from ${table} where strpos(${col}::text, ${form}) > 0`
      if (row && row.n > 0) hits.push(`postgres ${c.table_name}.${c.column_name}: ${row.n} rows hold "${form}"`)
    }
  }
  return { hits, columns: columns.length }
}

async function bodyBytes(body: unknown): Promise<Buffer> {
  const stream = body as AsyncIterable<Uint8Array>
  const parts: Uint8Array[] = []
  for await (const chunk of stream) parts.push(chunk)
  return Buffer.concat(parts)
}

/** Every object in the bucket. */
export async function scanS3(s3: S3Client, bucket: string, forms: string[]): Promise<{ hits: string[]; objects: number }> {
  const hits: string[] = []
  let objects = 0
  let token: string | undefined
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }))
    for (const o of page.Contents ?? []) {
      objects++
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: o.Key! }))
      const data = await bodyBytes(res.Body)
      for (const f of findForms(data, forms)) hits.push(`s3 ${bucket}/${o.Key}: holds "${f}"`)
      for (const f of findForms(o.Key!, forms)) hits.push(`s3 key ${o.Key}: holds "${f}"`)
      for (const [k, v] of Object.entries(res.Metadata ?? {})) for (const f of findForms(`${k}=${v}`, forms)) hits.push(`s3 ${o.Key} metadata: holds "${f}"`)
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  return { hits, objects }
}

/** Every key of the selected Redis database, with its value whatever the type. */
export async function scanRedis(redis: Redis, forms: string[]): Promise<{ hits: string[]; keys: number }> {
  const hits: string[] = []
  let keys = 0
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'COUNT', 500)
    cursor = next
    for (const key of batch) {
      keys++
      const type = await redis.type(key)
      const parts: (string | Buffer)[] = [key]
      if (type === 'string') parts.push((await redis.getBuffer(key)) ?? '')
      else if (type === 'hash') parts.push(...Object.entries(await redis.hgetallBuffer(key)).flat())
      else if (type === 'list') parts.push(...(await redis.lrangeBuffer(key, 0, -1)))
      else if (type === 'set') parts.push(...(await redis.smembersBuffer(key)))
      else if (type === 'zset') parts.push(...(await redis.zrangeBuffer(key, 0, -1)))
      else if (type === 'stream') parts.push(JSON.stringify(await redis.xrange(key, '-', '+')))
      for (const p of parts) for (const f of findForms(Buffer.isBuffer(p) ? p : Buffer.from(String(p)), forms)) hits.push(`redis ${type} ${key}: holds "${f}"`)
    }
  } while (cursor !== '0')
  return { hits, keys }
}
