/**
 * DS configuration from the environment (docs/gateway-protocol.md §12.18 "Env").
 */
import {
  BATCH_INTERVAL_MS,
  BATCH_TIMEOUT_MS,
  CipherSuite,
  MAX_ENVELOPE_BYTES,
  PUBLIC_SET_MAX_MEMBERS,
  type CipherSuiteId,
} from './crypto'

export interface DsConfig {
  /** TAKUSEN_MLS_SUITES. The first entry is the default suite. */
  suites: CipherSuiteId[]
  maxEnvelopeBytes: number
  publicSetMaxMembers: number
  batchIntervalMs: number
  batchTimeoutMs: number
  dsKeyPath: string
  ktKeyPath: string
}

/** Device inbox limits (§12.7.6). */
export const INBOX_ITEM_MAX_BYTES = 1024 * 1024
export const INBOX_DEVICE_MAX_BYTES = 8 * 1024 * 1024
export const INBOX_RETENTION_MS = 30 * 24 * 60 * 60_000
/** Backup limits (§12.11.3). */
export const BACKUP_IDENTITY_MAX_BYTES = 64 * 1024
export const BACKUP_BLOB_MAX_BYTES = 1024 * 1024
export const BACKUP_USER_MAX_BYTES = 256 * 1024 * 1024
/** Devices (§12.12). */
export const MAX_DEVICES = 20
/** One-time key packages kept per device and suite (§12.7.2). */
export const KEY_PACKAGE_MAX = 200
export const KEY_PACKAGE_UPLOAD_MAX = 100
/** Link message body cap. The largest LinkMessage (a transfer with history keys) stays far below it. */
export const LINK_MESSAGE_MAX_BYTES = 256 * 1024
/** Join requests older than this are swept (daily sweep). */
export const JOIN_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60_000
/** A device that timed out on a group is skipped for this long (§12.7.5 step 3). */
export const BATCH_TIMEOUT_COOLDOWN_MS = 60_000

const KNOWN_SUITES = new Set<number>(Object.values(CipherSuite))

function int(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid integer env value: ${v}`)
  return n
}

export function parseSuites(v: string | undefined): CipherSuiteId[] {
  if (v === undefined || v.trim() === '') return [CipherSuite.X25519_AES128GCM_SHA256_ED25519]
  const out: CipherSuiteId[] = []
  for (const part of v.split(',')) {
    const n = Number(part.trim())
    if (!KNOWN_SUITES.has(n)) throw new Error(`TAKUSEN_MLS_SUITES: unknown suite ${part}`)
    if (!out.includes(n as CipherSuiteId)) out.push(n as CipherSuiteId)
  }
  return out
}

export function dsConfig(env: NodeJS.ProcessEnv = process.env): DsConfig {
  return {
    suites: parseSuites(env.TAKUSEN_MLS_SUITES),
    maxEnvelopeBytes: int(env.TAKUSEN_MAX_ENVELOPE_BYTES, MAX_ENVELOPE_BYTES),
    publicSetMaxMembers: int(env.TAKUSEN_PUBLIC_SET_MAX_MEMBERS, PUBLIC_SET_MAX_MEMBERS),
    batchIntervalMs: int(env.TAKUSEN_MLS_BATCH_INTERVAL_MS, BATCH_INTERVAL_MS),
    batchTimeoutMs: int(env.TAKUSEN_MLS_BATCH_TIMEOUT_MS, BATCH_TIMEOUT_MS),
    dsKeyPath: env.TAKUSEN_DS_SIGNING_KEY?.trim() || '.dev/keys/takusen-ds.ed25519',
    ktKeyPath: env.TAKUSEN_KT_SIGNING_KEY?.trim() || '.dev/keys/takusen-kt.ed25519',
  }
}
