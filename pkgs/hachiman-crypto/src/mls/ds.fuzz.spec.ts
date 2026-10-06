/**
 * Fuzz tests of the DsModule (§12.7, §12.18): the Node entry that Takusen runs on untrusted
 * uploads. Invariants: checkCommit never throws and never accepts a changed signed byte; the
 * inspect functions never report a changed object as validly signed; the sync verifiers return
 * null and never throw.
 */
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'

import { CryptoError, type GroupDescriptor, type UserId } from '../api'
import { CodecError, fromB64url } from '../codec'
import { encodeEnvelope, encodeHeader } from '../envelope/codec'
import { edits, flip, flipped, mutate, only, runs } from '../fuzz-helpers'
import { identity } from '../identity/index'
import { ds } from './ds'
import { mls } from './index'
import { dsSigner, keyPackage, makeDevice, makeUser, policy, uuid } from './test-helpers'
import { decodeGroupInfoMessage, decodePublicMessage, decodeTree, encodeGroupInfoMessage, encodePublic, encodeTree } from './wire'

interface Fixture {
  input: Parameters<typeof ds.checkCommit>[0]
  /**
   * The start of confirmation_tag ‖ membership_tag at the end of the commit. The signature does not
   * cover them, and the DS has no epoch secrets to check them.
   */
  tagStart: number
  keyPackage: Uint8Array
  groupInfo0: { groupInfo: Uint8Array; ratchetTree: Uint8Array }
  chain: { master: Uint8Array; dsk: Uint8Array; device: Uint8Array }
}

let f: Fixture

beforeAll(async () => {
  const signer = await dsSigner()
  const a = makeDevice(makeUser())
  const b = makeDevice(makeUser())
  const c = makeDevice(makeUser())
  const users = [a.user, b.user, c.user]
  const p = policy({ kind: 'channel', users, dsKey: signer.publicKey })
  const channelId = uuid()
  const descriptor: GroupDescriptor = { kind: 'channel', guildId: uuid(), channelId, historyVisibility: 'joined', createdByUserId: a.user.userId }
  const created = await mls.createGroup({ groupId: mls.groupId({ kind: 'channel', scope: channelId, generation: 0 }), descriptor, dsExternalSender: signer.externalSender, cipherSuite: 1, keyPackage: await keyPackage(a) })
  const groupInfo0 = await mls.groupInfo(created.handle)
  const pc = await mls.commit(created.handle, { adds: [(await keyPackage(b)).publicPackage], removes: [], descriptor: null, policy: p })
  const masters = new Map<UserId, Uint8Array>(users.map((u) => [u.userId, u.master.record.publicKey]))
  const commit = fromB64url(pc.request.commit)
  f = {
    input: {
      groupId: created.handle.groupId,
      epoch: created.handle.epoch,
      commit,
      groupInfo: fromB64url(pc.request.groupInfo),
      ratchetTree: fromB64url(pc.request.ratchetTree),
      previous: groupInfo0,
      sender: { userId: a.user.userId, deviceId: a.deviceId },
      publishedProposals: [],
      masterKeys: (u) => masters.get(u) ?? null,
    },
    // Each tag is opaque<V> of a 32-byte MAC: a 1-byte length prefix and 32 bytes.
    tagStart: commit.length - 2 * 33,
    keyPackage: (await keyPackage(c)).publicPackage,
    groupInfo0,
    chain: { master: identity.encodeMasterKeyRecord(a.chain.master), dsk: identity.encodeDskCert(a.chain.dsk), device: identity.encodeDeviceCertificate(a.chain.device) },
  }
  expect((await ds.checkCommit(f.input)).ok).toBe(true)
}, 60_000)

const field = fc.constantFrom('commit' as const, 'groupInfo' as const, 'ratchetTree' as const)
/** Decode, then encode again: the canonical form of an upload. */
const canonical = {
  commit: (b: Uint8Array) => encodePublic(decodePublicMessage(b)),
  groupInfo: (b: Uint8Array) => encodeGroupInfoMessage(decodeGroupInfoMessage(b)),
  ratchetTree: (b: Uint8Array) => encodeTree(decodeTree(b)),
}

describe('DsModule.checkCommit (fuzz)', () => {
  it('never throws, and accepts a changed upload only when the change is in the MAC tags', async () => {
    await fc.assert(
      fc.asyncProperty(field, flip, async (which, fl) => {
        const changed = { ...f.input, [which]: flipped(f.input[which], fl) }
        const r = await ds.checkCommit(changed)
        if (!r.ok) return
        // The tags are the part of a PublicMessage commit that the DS cannot verify. Members reject
        // a bad tag, so such a commit stalls the epoch (docs/e2ee-audit-scope.md, L-4).
        expect(which === 'commit' && fl[0] % f.input.commit.length >= f.tagStart).toBe(true)
      }),
      runs(150),
    )
  }, 120_000)

  it('decodes only canonical bytes (FZ-2): what decodes encodes to the same bytes', () => {
    fc.assert(
      fc.property(field, flip, (which, fl) => {
        const changed = flipped(f.input[which], fl)
        let again: Uint8Array
        try {
          again = canonical[which](changed)
        } catch {
          return
        }
        expect(again).toEqual(changed)
      }),
      runs(150),
    )
  }, 120_000)

  it('never throws on truncated, extended or random uploads', async () => {
    await fc.assert(
      fc.asyncProperty(field, edits(3), fc.option(fc.nat()), fc.uint8Array({ maxLength: 3 }), async (which, e, cut, tail) => {
        const r = await ds.checkCommit({ ...f.input, [which]: mutate(f.input[which], e, cut, tail) })
        expect(typeof r.ok).toBe('boolean')
      }),
      runs(100),
    )
  }, 120_000)
})

describe('DsModule inspectors (fuzz)', () => {
  it('inspectKeyPackage: a flipped key package is never reported as validly signed', async () => {
    await fc.assert(
      fc.asyncProperty(flip, async (fl) => {
        const r = await ds.inspectKeyPackage(flipped(f.keyPackage, fl)).catch((e: unknown) => {
          expect(e).toBeInstanceOf(Error)
          return null
        })
        if (r !== null) expect(r.signatureValid).toBe(false)
      }),
      runs(150),
    )
  }, 120_000)

  it('inspectGroupInfo: a flipped GroupInfo or tree is never fully valid', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('groupInfo' as const, 'ratchetTree' as const), flip, async (which, fl) => {
        const gi = which === 'groupInfo' ? flipped(f.groupInfo0.groupInfo, fl) : f.groupInfo0.groupInfo
        const tree = which === 'ratchetTree' ? flipped(f.groupInfo0.ratchetTree, fl) : f.groupInfo0.ratchetTree
        const r = await ds.inspectGroupInfo(gi, tree).catch((e: unknown) => {
          expect(e).toBeInstanceOf(Error)
          return null
        })
        if (r !== null) expect(r.signatureValid && r.treeHashValid).toBe(false)
      }),
      runs(150),
    )
  }, 120_000)

  it('rosterOf and proposalRef reject random bytes instead of throwing synchronously', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 120 }), fc.uint8Array({ maxLength: 120 }), async (a, b) => {
        // A synchronous throw escapes the .catch and fails the property.
        await Promise.all([ds.rosterOf(a, b).catch(() => null), ds.proposalRef(a, 1).catch(() => null)])
      }),
      runs(300),
    )
  })
})

describe('DsModule sync verifiers (fuzz)', () => {
  it('verify* return null on changed chains and never throw', () => {
    const { master, dsk, device } = f.chain
    expect(ds.verifyDeviceCertificate(device, dsk, master)).not.toBeNull()
    fc.assert(
      fc.property(fc.constantFrom('master' as const, 'dsk' as const, 'device' as const), flip, (which, fl) => {
        const m = which === 'master' ? flipped(master, fl) : master
        const d = which === 'dsk' ? flipped(dsk, fl) : dsk
        const c = which === 'device' ? flipped(device, fl) : device
        expect(ds.verifyDeviceCertificate(c, d, m)).toBeNull()
        if (which !== 'device') expect(ds.verifyDskCert(d, m)).toBeNull()
        if (which === 'master') expect(ds.verifyMasterKeyRecord(m, null)).toBeNull()
      }),
      runs(500),
    )
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), fc.uint8Array({ maxLength: 200 }), (x, y) => {
        expect(ds.verifyDeviceCertificate(x, y, x)).toBeNull()
        expect(ds.verifyMasterKeyRecord(x, y)).toBeNull()
        expect(ds.verifyDskCert(x, y)).toBeNull()
        expect(ds.verifyRevocation(x, { master: y, deviceCertificate: x })).toBeNull()
        expect(ds.verifyAdminAction(x, y)).toBeNull()
        expect(ds.verifyInviteRecord(x, y)).toBeNull()
      }),
      runs(2000),
    )
  }, 300_000)

  it('parseEnvelopeHeader throws only CryptoError or CodecError', () => {
    const header = encodeHeader({
      groupId: f.input.groupId,
      channelId: uuid(),
      epoch: 1,
      senderLeaf: 0,
      senderDeviceId: uuid(),
      clientMsgId: new Uint8Array(16).fill(1),
      salt: new Uint8Array(32).fill(2),
      frankingTag: new Uint8Array(32).fill(3),
    })
    const env = encodeEnvelope(header, new Uint8Array(48).fill(4))
    fc.assert(
      fc.property(fc.oneof(fc.constant(env), fc.uint8Array({ maxLength: 200 })), edits(), fc.option(fc.nat()), (base, e, cut) => {
        only(() => ds.parseEnvelopeHeader(mutate(base, e, cut)), CryptoError, CodecError)
      }),
      runs(3000),
    )
  })
})
