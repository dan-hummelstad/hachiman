/**
 * The typed RPC between the UI thread and the crypto Worker (docs/gateway-protocol.md §12.17).
 *
 * One peer on each side of a Worker or MessagePort. Both peers call and answer:
 *   UI → Worker:  CryptoApi methods (CRYPTO_API_METHODS).
 *   Worker → UI:  DsTransport methods (DS_TRANSPORT_METHODS), the reverse calls.
 *   Worker → UI:  CryptoEvents.
 *
 * Errors cross as CryptoErrorShape and come back as CryptoError. Each peer serves only the
 * method names of its allowlist. MessagePorts in the arguments or results are transferred.
 * Blobs are structured-cloned (a Blob clone shares the bytes and does not copy them).
 *
 * This file must not import @hachiman/client or any engine module: the bridge imports it.
 */
import { CryptoError, type CryptoApi, type CryptoErrorCode, type CryptoErrorShape, type CryptoEvents, type DsTransport } from '../api'

export const RPC_TAG = 'hachiman-crypto/1'

export type RpcMessage =
  | { tag: typeof RPC_TAG; kind: 'call'; id: number; method: string; args: unknown[] }
  | { tag: typeof RPC_TAG; kind: 'return'; id: number; ok: true; value: unknown }
  | { tag: typeof RPC_TAG; kind: 'return'; id: number; ok: false; error: CryptoErrorShape }
  | { tag: typeof RPC_TAG; kind: 'event'; event: string; payload: unknown }

/** What a Worker, a DedicatedWorkerGlobalScope and a MessagePort have in common. */
export interface RpcEndpoint {
  postMessage(message: unknown, transfer: Transferable[]): void
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => void): void
  /** MessagePort only: messages queue until start(). */
  start?: () => void
}

const CRYPTO_API_METHOD_SET = {
  init: true,
  status: true,
  signOutDevice: true,
  setupFirstDevice: true,
  restoreFromRecoveryKey: true,
  resetIdentity: true,
  rotateRecoveryKey: true,
  linkAsNewDevice: true,
  linkScan: true,
  linkAccept: true,
  listLinkSessions: true,
  linkConfirmSas: true,
  linkCancel: true,
  listDevices: true,
  revokeDevice: true,
  renameDevice: true,
  getTrust: true,
  listContactDevices: true,
  getSafetyNumber: true,
  verifyQr: true,
  setVerified: true,
  acknowledgeKeyChange: true,
  getEpochCode: true,
  sync: true,
  onGatewayEvent: true,
  ensureChannelGroup: true,
  membershipTimeline: true,
  encryptMessage: true,
  decryptMessages: true,
  buildReport: true,
  encryptDoc: true,
  decryptDoc: true,
  encryptAttachment: true,
  decryptAttachment: true,
  backupNow: true,
  ktSelfCheck: true,
  signAdminAction: true,
  adminGuildPermissions: true,
  prepareHistoryInvite: true,
  sendInviteBundles: true,
  redeemInvite: true,
  proveDevice: true,
  voiceStart: true,
  voiceHandle: true,
  voiceAttachTransform: true,
  voiceDetachTransform: true,
  voiceRoster: true,
  voiceEpochCode: true,
  voiceStop: true,
} as const satisfies Record<keyof CryptoApi, true>
export const CRYPTO_API_METHODS = Object.keys(CRYPTO_API_METHOD_SET) as (keyof CryptoApi)[]

const DS_TRANSPORT_METHOD_SET = {
  registerDevice: true,
  putDeviceCertificate: true,
  listOwnDevices: true,
  revokeDevice: true,
  renameDevice: true,
  getUserKeys: true,
  putMasterKey: true,
  putDeviceSigningKey: true,
  getDsInfo: true,
  uploadKeyPackages: true,
  countKeyPackages: true,
  listGroups: true,
  getGroup: true,
  getGroupForChannel: true,
  getGroupState: true,
  createGroup: true,
  postCommit: true,
  fetchHandshakes: true,
  postJoinRequest: true,
  getJoinRequest: true,
  declineBatch: true,
  fetchInbox: true,
  ackInbox: true,
  postInbox: true,
  getBackups: true,
  putIdentityBackup: true,
  postHistoryBackup: true,
  getBackup: true,
  deleteBackups: true,
  postHistoryBundle: true,
  getHistoryBundles: true,
  createLinkSession: true,
  listLinkSessions: true,
  postLinkMessage: true,
  fetchLinkMessages: true,
  deleteLinkSession: true,
  ktTreeHead: true,
  ktInclusion: true,
  ktConsistency: true,
  ktEntries: true,
  adminActions: true,
  inviteRecords: true,
  postInviteBundle: true,
  inviteBundles: true,
  channelReaders: true,
  guildMembers: true,
} as const satisfies Record<keyof DsTransport, true>
export const DS_TRANSPORT_METHODS = Object.keys(DS_TRANSPORT_METHOD_SET) as (keyof DsTransport)[]

const CRYPTO_EVENT_SET = {
  status: true,
  keyChange: true,
  forkAlert: true,
  membership: true,
  linkSas: true,
  linkDone: true,
  epochKeysAvailable: true,
  ktAlert: true,
  voiceRoster: true,
  usersAdded: true,
  error: true,
} as const satisfies Record<keyof CryptoEvents, true>
export const CRYPTO_EVENTS = Object.keys(CRYPTO_EVENT_SET) as (keyof CryptoEvents)[]

const ERROR_CODE_SET = {
  NotInitialized: true,
  NoIdentity: true,
  DeviceRevoked: true,
  SecureStorageUnavailable: true,
  StoreCorrupt: true,
  InvalidRecoveryKey: true,
  WrongRecoveryKey: true,
  InvalidChain: true,
  UnknownGroup: true,
  GroupPending: true,
  NotMember: true,
  EpochConflict: true,
  PendingRemoves: true,
  Transport: true,
  LinkAborted: true,
  LinkExpired: true,
  SasMismatch: true,
  Malformed: true,
  TooLarge: true,
  Unsupported: true,
  LockHeld: true,
  Internal: true,
} as const satisfies Record<CryptoErrorCode, true>

export function isCryptoErrorCode(v: unknown): v is CryptoErrorCode {
  return typeof v === 'string' && Object.hasOwn(ERROR_CODE_SET, v)
}

/**
 * Any thrown value → CryptoErrorShape. A value with a known `code` keeps it (CryptoError, and the
 * transport's { code: 'Transport', dsCode } rejections). Anything else gets `fallback`.
 */
export function toErrorShape(e: unknown, fallback: CryptoErrorCode): CryptoErrorShape {
  if (typeof e === 'object' && e !== null) {
    const o = e as { code?: unknown; message?: unknown; dsCode?: unknown }
    const message = typeof o.message === 'string' ? o.message : 'error without a message'
    const dsCode = typeof o.dsCode === 'string' ? o.dsCode : undefined
    if (isCryptoErrorCode(o.code)) return { code: o.code, message, dsCode }
    // A transport rejection without a CryptoErrorCode still carries its REST error code.
    return { code: dsCode !== undefined ? 'Transport' : fallback, message, dsCode }
  }
  return { code: fallback, message: String(e) }
}

export function fromErrorShape(s: unknown): CryptoError {
  if (typeof s !== 'object' || s === null) return new CryptoError('Malformed', 'rpc: malformed error')
  const o = s as { code?: unknown; message?: unknown; dsCode?: unknown }
  const code = isCryptoErrorCode(o.code) ? o.code : 'Malformed'
  const message = typeof o.message === 'string' ? o.message : 'rpc error'
  return typeof o.dsCode === 'string' ? new CryptoError(code, message, o.dsCode) : new CryptoError(code, message)
}

/** MessagePorts anywhere in the top two levels of a value (arguments and result objects). */
export function transferablesOf(value: unknown, depth = 2): Transferable[] {
  const out: Transferable[] = []
  const walk = (v: unknown, d: number): void => {
    if (typeof MessagePort !== 'undefined' && v instanceof MessagePort) {
      out.push(v)
      return
    }
    if (d === 0 || typeof v !== 'object' || v === null || ArrayBuffer.isView(v) || (typeof Blob !== 'undefined' && v instanceof Blob)) return
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, d - 1)
  }
  walk(value, depth + 1)
  return out
}

function isRpcMessage(v: unknown): v is RpcMessage {
  if (typeof v !== 'object' || v === null) return false
  const m = v as { tag?: unknown; kind?: unknown }
  return m.tag === RPC_TAG && (m.kind === 'call' || m.kind === 'return' || m.kind === 'event')
}

export type RpcHandler = (...args: never[]) => unknown

export interface RpcPeerOptions {
  /** Method name → implementation. Only names in `allow` are served. */
  serve: () => Partial<Record<string, RpcHandler>> | null
  allow: readonly string[]
  /** The code for an exception that has no CryptoErrorCode. */
  fallbackCode: CryptoErrorCode
  onEvent?: (event: string, payload: unknown) => void
}

export interface RpcPeer {
  call(method: string, args: unknown[]): Promise<unknown>
  emit(event: string, payload: unknown): void
  /** Rejects every open call and stops listening. */
  close(reason: CryptoError): void
}

export function createRpcPeer(endpoint: RpcEndpoint, opts: RpcPeerOptions): RpcPeer {
  const allowed = new Set(opts.allow)
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: CryptoError) => void }>()
  let nextId = 1
  let closed: CryptoError | null = null

  const post = (m: RpcMessage, transfer: Transferable[] = []): void => {
    endpoint.postMessage(m, transfer)
  }

  async function answer(id: number, method: string, args: unknown[]): Promise<void> {
    try {
      const handlers = opts.serve()
      const fn = allowed.has(method) ? handlers?.[method] : undefined
      if (fn === undefined) throw new CryptoError('Unsupported', `rpc: no method ${method}`)
      const value: unknown = await (fn as (...a: unknown[]) => unknown)(...args)
      if (closed !== null) return
      post({ tag: RPC_TAG, kind: 'return', id, ok: true, value }, transferablesOf(value))
    } catch (e) {
      if (closed !== null) return
      post({ tag: RPC_TAG, kind: 'return', id, ok: false, error: toErrorShape(e, opts.fallbackCode) })
    }
  }

  const listener = (ev: MessageEvent): void => {
    const m: unknown = ev.data
    if (!isRpcMessage(m) || closed !== null) return
    if (m.kind === 'call') {
      if (typeof m.id !== 'number' || typeof m.method !== 'string' || !Array.isArray(m.args)) return
      void answer(m.id, m.method, m.args)
    } else if (m.kind === 'return') {
      const p = pending.get(m.id)
      if (p === undefined) return
      pending.delete(m.id)
      if (m.ok) p.resolve(m.value)
      else p.reject(fromErrorShape(m.error))
    } else if (typeof m.event === 'string') {
      opts.onEvent?.(m.event, m.payload)
    }
  }
  endpoint.addEventListener('message', listener)
  endpoint.start?.()

  return {
    call(method, args) {
      if (closed !== null) return Promise.reject(closed)
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try {
          post({ tag: RPC_TAG, kind: 'call', id, method, args }, transferablesOf(args))
        } catch (e) {
          pending.delete(id)
          reject(new CryptoError('Malformed', `rpc: ${method} arguments do not clone: ${e instanceof Error ? e.message : String(e)}`))
        }
      })
    },
    emit(event, payload) {
      if (closed !== null) return
      post({ tag: RPC_TAG, kind: 'event', event, payload }, transferablesOf(payload))
    },
    close(reason) {
      if (closed !== null) return
      closed = reason
      endpoint.removeEventListener('message', listener)
      for (const p of pending.values()) p.reject(reason)
      pending.clear()
    },
  }
}
