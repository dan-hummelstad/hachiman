/**
 * Pure helpers for uploads and file downloads (docs/gateway-protocol.md §4 Files).
 * No DB / S3 access here so they are unit-testable.
 */
import { DEFAULT_LIMITS, embedKind } from '@hachiman/client/files'
import type { Attachment, Limits } from '@hachiman/client/types'

import type { UploadRow } from '@/db/schema'
import { docsLimits } from '@/lib/docs/config'
import { dsConfig } from '@/lib/mls/config'

export const FILENAME_MAX_LENGTH = 255

/** Blobs carry no metadata on the server (§12.9): one type and one file name for all of them. */
export const BLOB_CONTENT_TYPE = 'application/octet-stream'
export const BLOB_DISPOSITION = 'attachment; filename="blob"'

export function parseMaxUploadBytes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_LIMITS.maxUploadBytes
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`TAKUSEN_MAX_UPLOAD_BYTES must be a positive integer, got "${raw}"`)
  }
  return n
}

/**
 * `maxEnvelopeBytes` is TAKUSEN_MAX_ENVELOPE_BYTES, the limit that acceptEnvelope applies (§12.8.4).
 * `maxGroupDmMembers` is TAKUSEN_PUBLIC_SET_MAX_MEMBERS: a group DM is as large as a guild channel.
 */
export function getLimits(env: Readonly<Record<string, string | undefined>> = process.env): Limits {
  const ds = dsConfig(env as NodeJS.ProcessEnv)
  return {
    ...DEFAULT_LIMITS,
    maxUploadBytes: parseMaxUploadBytes(env.TAKUSEN_MAX_UPLOAD_BYTES),
    maxEnvelopeBytes: ds.maxEnvelopeBytes,
    maxGroupDmMembers: ds.publicSetMaxMembers,
    maxPageSnapshotBytes: docsLimits(env).maxSnapshotBytes,
  }
}

/**
 * `POST /uploads?kind=blob`: an encrypted attachment or thumbnail.
 * `POST /uploads?kind=page_snapshot`: a blob with its own cap and purpose
 * page_snapshot from the upload on (§4 Pages).
 * `POST /uploads?filename=<name>`: a plaintext profile image. Exactly one of
 * the two parameters (§4 Files).
 */
export type UploadKind = { kind: 'blob' } | { kind: 'page_snapshot' } | { kind: 'image'; filename: string }

export function parseUploadKind(params: URLSearchParams): UploadKind | null {
  const kind = params.get('kind')
  const filename = params.get('filename')
  if (kind !== null) return (kind === 'blob' || kind === 'page_snapshot') && filename === null ? { kind } : null
  const name = filename?.trim() ?? ''
  if (name.length < 1 || name.length > FILENAME_MAX_LENGTH) return null
  return { kind: 'image', filename: name }
}

/** The stored columns of a new upload row. A blob has no file name and a fixed type. */
export function uploadColumns(id: string, kind: UploadKind, contentTypeHeader: string | null) {
  if (kind.kind === 'blob') {
    return { key: blobKey(id), filename: null, contentType: BLOB_CONTENT_TYPE, encrypted: true }
  }
  if (kind.kind === 'page_snapshot') {
    return { key: blobKey(id), filename: null, contentType: BLOB_CONTENT_TYPE, encrypted: true, purpose: 'page_snapshot' as const }
  }
  return { key: uploadKey(id, kind.filename), filename: kind.filename, contentType: normalizeContentType(contentTypeHeader), encrypted: false }
}

export function blobKey(uploadId: string): string {
  return `${uploadId}/blob`
}

/** The key's last segment: `[A-Za-z0-9._-]` only, at most 100 characters. */
export function safeName(filename: string): string {
  const name = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)
  return name === '' ? 'file' : name
}

export function uploadKey(uploadId: string, filename: string): string {
  return `${uploadId}/${safeName(filename)}`
}

/**
 * The stored MIME type: the lowercased `type/subtype` without parameters, or
 * `application/octet-stream` when the header is absent or malformed.
 */
export function normalizeContentType(header: string | null): string {
  const base = (header ?? '').split(';')[0].trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(base) && base.length <= 255
    ? base
    : 'application/octet-stream'
}

/**
 * `null` when the Content-Length header is missing, malformed or above `max`:
 * the route answers 413 before it reads the body.
 */
export function parseContentLength(header: string | null, max: number): number | null {
  if (header === null || !/^\d+$/.test(header)) return null
  const n = Number(header)
  return Number.isSafeInteger(n) && n <= max ? n : null
}

/**
 * `inline` only for the types the client embeds. Everything else (SVG and
 * HTML too) downloads, so a file can never run script on the Takusen origin.
 */
export function contentDisposition(contentType: string, filename: string): string {
  if (embedKind(contentType) !== 'file') return 'inline'
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRFC5987(filename)}`
}

function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

export type ByteRange = { start: number; end: number }

/**
 * One `bytes=` range against an object of `size` bytes (RFC 9110 §14.1.2).
 * Returns `null` to serve the whole file (no header, a multi-range, or a
 * malformed value) and `'unsatisfiable'` for a 416.
 */
export function parseRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, from, to] = m
  if (from === '' && to === '') return null
  if (from === '') {
    const suffix = Number(to)
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(from)
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1)
  if (to !== '' && Number(to) < start) return null
  if (start >= size) return 'unsatisfiable'
  return { start, end }
}

/** The Content-Type and Content-Disposition of a download (§4 Files "Download"). */
export function downloadHeaders(u: Pick<UploadRow, 'encrypted' | 'contentType' | 'filename'>): { contentType: string; disposition: string } {
  if (u.encrypted) return { contentType: BLOB_CONTENT_TYPE, disposition: BLOB_DISPOSITION }
  return { contentType: u.contentType, disposition: contentDisposition(u.contentType, u.filename ?? 'file') }
}

/** An upload as the wire Attachment: blob size only (§1). */
export function toAttachment(u: Pick<UploadRow, 'id' | 'key' | 'size'>): Attachment {
  return { id: u.id, key: u.key, size: u.size }
}
