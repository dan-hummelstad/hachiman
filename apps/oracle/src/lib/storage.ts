/**
 * S3-compatible blob storage for uploads (docs/gateway-protocol.md §4 Files).
 * Server-only. Clients never talk to the bucket: Oracle streams both ways.
 */
import { Readable } from 'node:stream'

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

declare global {
  var __oracleS3: S3Client | undefined
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set — Oracle needs S3 storage for uploads`)
  return value
}

function bucket(): string {
  return requireEnv('S3_BUCKET')
}

function s3(): S3Client {
  if (globalThis.__oracleS3) return globalThis.__oracleS3
  const client = new S3Client({
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: requireEnv('S3_REGION'),
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: {
      accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
    },
    // The SDK's default flexible checksums send aws-chunked bodies with
    // trailers, which several S3-compatible stores (SeaweedFS, older MinIO)
    // reject. Plain signed PUTs work everywhere.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  globalThis.__oracleS3 = client
  return client
}

/** `length` must equal the bytes `body` yields, or S3 rejects the PUT. */
export async function putObject(
  key: string,
  body: Readable,
  length: number,
  contentType: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentLength: length,
      ContentType: contentType,
    }),
    { abortSignal },
  )
}

/** `range` is an HTTP Range value (`bytes=a-b`) or undefined for the whole object. */
export async function getObjectStream(
  key: string,
  range?: string,
): Promise<ReadableStream<Uint8Array>> {
  const res = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key, Range: range }))
  if (!res.Body) throw new Error(`S3 returned no body for ${key}`)
  return res.Body.transformToWebStream() as ReadableStream<Uint8Array>
}

/**
 * Best effort: logs and swallows failures (the DB rows are already gone).
 * One DeleteObject per key: a message has at most 10, and DeleteObjects needs
 * a body checksum that not every S3-compatible store accepts.
 */
export async function deleteObjects(keys: string[]): Promise<void> {
  const results = await Promise.allSettled(
    keys.map(async (Key) => s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key }))),
  )
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[storage] delete ${keys[i]} failed`, r.reason)
  })
}
