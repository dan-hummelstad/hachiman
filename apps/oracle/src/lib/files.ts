/**
 * Pure helpers for uploads and file downloads (docs/gateway-protocol.md §4 Files).
 * No DB / S3 access here so they are unit-testable.
 */
import { DEFAULT_LIMITS, embedKind } from '@hachiman/client/files'
import type { Attachment, Limits } from '@hachiman/client/types'

import type { UploadRow } from '@/db/schema'

export const FILENAME_MAX_LENGTH = 255

export function parseMaxUploadBytes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_LIMITS.maxUploadBytes
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`ORACLE_MAX_UPLOAD_BYTES must be a positive integer, got "${raw}"`)
  }
  return n
}

export function getLimits(env: string | undefined = process.env.ORACLE_MAX_UPLOAD_BYTES): Limits {
  return { ...DEFAULT_LIMITS, maxUploadBytes: parseMaxUploadBytes(env) }
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
 * HTML too) downloads, so a file can never run script on the Oracle origin.
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

export function toAttachment(u: UploadRow): Attachment {
  return {
    id: u.id,
    key: u.key,
    filename: u.filename,
    size: u.size,
    contentType: u.contentType,
    width: u.width,
    height: u.height,
  }
}
