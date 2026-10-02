/**
 * Test doubles for the MLS specs: users with real key chains, devices with key packages, and a
 * ProposalPolicy over them. Not part of the package exports.
 */
import { x25519 } from '@noble/curves/ed25519.js'

import type { ChainContext, DeviceChain, Ed25519KeyPair, ProposalPolicy, UserId } from '../api'
import type { GroupKindName } from '../constants'
import { randomBytes } from '../identity/bytes'
import { identity } from '../identity/index'
import { generateEd25519 } from '../sign'
import { ds } from './ds'
import { mls } from './index'

export function uuid(): string {
  const b = randomBytes(16)
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export interface TestUser {
  userId: UserId
  master: ReturnType<typeof identity.createMasterKey>
  dsk: ReturnType<typeof identity.createDeviceSigningKey>
}

export interface TestDevice {
  user: TestUser
  deviceId: string
  sig: Ed25519KeyPair
  chain: DeviceChain
}

export function makeUser(): TestUser {
  const userId = uuid()
  const master = identity.createMasterKey(userId, 1, null)
  return { userId, master, dsk: identity.createDeviceSigningKey(master, 1) }
}

/** A new DSK generation for the user (revocation step 1). Existing devices keep their old chain. */
export function rotateDsk(user: TestUser): void {
  user.dsk = identity.createDeviceSigningKey(user.master, user.dsk.cert.generation + 1)
}

export function makeDevice(user: TestUser, deviceId = uuid(), sig = generateEd25519()): TestDevice {
  const hpke = x25519.utils.randomSecretKey()
  const device = identity.certifyDevice(user.dsk, { deviceId, mlsSignatureKey: sig.publicKey, hpkeKey: x25519.getPublicKey(hpke), issuedAtMs: Date.now(), displayName: 'test' })
  return { user, deviceId, sig, chain: { master: user.master.record, dsk: user.dsk.cert, device } }
}

/** The device certified again under the user's current DSK (same keys). */
export function recertify(d: TestDevice): TestDevice {
  return makeDevice(d.user, d.deviceId, d.sig)
}

export async function keyPackage(d: TestDevice, cipherSuite: 1 | 83 = 1): Promise<{ publicPackage: Uint8Array; privatePackage: Uint8Array; ref: Uint8Array }> {
  return (await mls.generateKeyPackages({ chain: d.chain, signatureKey: d.sig, cipherSuite, count: 1, lastResort: false }))[0]!
}

export async function dsSigner() {
  return ds.loadSigner(randomBytes(32))
}

export interface PolicyOptions {
  kind: GroupKindName
  users: readonly TestUser[]
  dsKey: Uint8Array | null
  readers?: readonly UserId[] | null
  adminReaders?: readonly UserId[] | null
  revoked?: readonly string[]
  canChangeDescriptor?: (userId: UserId) => boolean
  voice?: ProposalPolicy['voice']
}

export function chainContext(user: TestUser | undefined, revoked: ReadonlySet<string>): ChainContext {
  const nowMs = Date.now()
  if (user === undefined) return { pinnedMaster: null, currentDsk: null, highestSeenDskGeneration: null, revokedDeviceIds: revoked, leaf: null, entering: false, nowMs }
  return {
    pinnedMaster: { publicKey: user.master.record.publicKey, generation: user.master.record.generation },
    currentDsk: { generation: user.dsk.cert.generation, issuedAtMs: user.dsk.cert.issuedAtMs },
    highestSeenDskGeneration: user.dsk.cert.generation,
    revokedDeviceIds: revoked,
    leaf: null,
    entering: false,
    nowMs,
  }
}

export function policy(o: PolicyOptions): ProposalPolicy {
  const revoked = new Set(o.revoked ?? [])
  const byId = new Map(o.users.map((u) => [u.userId, u]))
  const readers = o.readers === undefined ? o.users.map((u) => u.userId) : o.readers
  return {
    kind: o.kind,
    dsExternalSenderKey: o.dsKey,
    readers: readers === null ? null : new Set(readers),
    adminReaders: o.adminReaders == null ? null : new Set(o.adminReaders),
    chainContextFor: (u) => chainContext(byId.get(u), revoked),
    canChangeDescriptor: o.canChangeDescriptor ?? (() => false),
    voice: o.voice ?? null,
  }
}
