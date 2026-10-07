// Capability smoke test for ts-mls 1.6.4. It pins the library behaviour that the
// @hachiman/crypto design depends on (docs/gateway-protocol.md §12, docs/e2ee-plan.md
// "Implementation notes"). If an upgrade breaks one of these cases, the design must change.
import { describe, expect, it } from 'vitest'
import {
  type AuthenticationService,
  type CiphersuiteImpl,
  type CiphersuiteName,
  type ClientConfig,
  type ClientState,
  type Credential,
  type Extension,
  type KeyPackage,
  type MLSMessage,
  type PrivateKeyPackage,
  acceptAll,
  createCommit,
  createGroup,
  createGroupInfoWithExternalPub,
  createGroupInfoWithExternalPubAndRatchetTree,
  decodeGroupState,
  decodeMlsMessage,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  encodeExternalSender,
  encodeGroupState,
  encodeMlsMessage,
  encodeRequiredCapabilities,
  generateKeyPackageWithKey,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  joinGroupExternal,
  mlsExporter,
  processMessage,
  proposeExternal,
} from 'ts-mls'
import { defaultClientConfig } from 'ts-mls/clientConfig.js'
import { createCustomCredential } from 'ts-mls/customCredential.js'
import { verifyFramedContentSignature } from 'ts-mls/framedContent.js'
import { verifyGroupInfoSignature } from 'ts-mls/groupInfo.js'
import { decodeRatchetTree, encodeRatchetTree } from 'ts-mls/ratchetTree.js'
import { treeHashRoot } from 'ts-mls/treeHash.js'

const SUITE: CiphersuiteName = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
const XWING: CiphersuiteName = 'MLS_256_XWING_AES256GCM_SHA512_Ed25519'
// Private-use extension types (RFC 9420 §17.3: 0xF000-0xFFFF). Same values as src/constants.ts.
const EXT_DEVICE_CHAIN = 0xf1a0
const EXT_GROUP_DESCRIPTOR = 0xf1a1

const te = new TextEncoder()
const td = new TextDecoder()

interface Device {
  userId: string
  deviceId: string
  sig: { publicKey: Uint8Array; signKey: Uint8Array }
}

/** Records every credential that ts-mls asks the AS about, and enforces "userId:deviceId". */
function recordingAuthService(seen: string[]): AuthenticationService {
  return {
    validateCredential(credential: Credential): Promise<boolean> {
      if (credential.credentialType !== 'basic') return Promise.resolve(false)
      const id = td.decode(credential.identity)
      seen.push(id)
      return Promise.resolve(/^[^:]+:[^:]+$/.test(id))
    },
  }
}

function config(auth: AuthenticationService): ClientConfig {
  return { ...defaultClientConfig, authService: auth }
}

async function device(cs: CiphersuiteImpl, userId: string, deviceId: string): Promise<Device> {
  return { userId, deviceId, sig: await cs.signature.keygen() }
}

async function keyPackage(
  cs: CiphersuiteImpl,
  d: Device,
): Promise<{ publicPackage: KeyPackage; privatePackage: PrivateKeyPackage }> {
  const credential: Credential = { credentialType: 'basic', identity: te.encode(`${d.userId}:${d.deviceId}`) }
  const caps = defaultCapabilities()
  caps.extensions.push(EXT_DEVICE_CHAIN, EXT_GROUP_DESCRIPTOR)
  // The device chain rides in a leaf node extension; the bytes stand in for a real chain.
  const leafExt: Extension[] = [{ extensionType: EXT_DEVICE_CHAIN, extensionData: te.encode(`chain(${d.deviceId})`) }]
  return generateKeyPackageWithKey(credential, caps, defaultLifetime, [], d.sig, cs, leafExt)
}

function leafChain(state: ClientState, leafIndex: number): string | undefined {
  const node = state.ratchetTree[leafIndex * 2]
  if (node?.nodeType !== 'leaf') return undefined
  const ext = node.leaf.extensions.find((e) => e.extensionType === EXT_DEVICE_CHAIN)
  return ext === undefined ? undefined : td.decode(ext.extensionData)
}

function wire(m: MLSMessage): MLSMessage {
  const decoded = decodeMlsMessage(encodeMlsMessage(m), 0)
  if (decoded === undefined) throw new Error('decode failed')
  return decoded[0]
}

function asHandshake(m: MLSMessage) {
  if (m.wireformat !== 'mls_public_message' && m.wireformat !== 'mls_private_message') {
    throw new Error(`unexpected wireformat ${m.wireformat}`)
  }
  return m
}

async function apply(state: ClientState, m: MLSMessage, cs: CiphersuiteImpl): Promise<ClientState> {
  const r = await processMessage(asHandshake(wire(m)), state, emptyPskIndex, acceptAll, cs)
  return r.newState
}

async function exporter(state: ClientState, cs: CiphersuiteImpl): Promise<Uint8Array> {
  return mlsExporter(state.keySchedule.exporterSecret, 'hachiman message v1', state.groupContext.groupId, 32, cs)
}

describe('ts-mls capability smoke test', () => {
  it('runs the full group lifecycle on cipher suite 1', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE))
    const seen: string[] = []
    const cfg = config(recordingAuthService(seen))

    // The delivery service (Takusen) is the one external sender.
    const ds = await cs.signature.keygen()
    const dsCredential: Credential = { credentialType: 'basic', identity: te.encode('takusen:ds') }
    const required = encodeRequiredCapabilities({
      extensionTypes: [EXT_DEVICE_CHAIN, EXT_GROUP_DESCRIPTOR],
      proposalTypes: [],
      credentialTypes: ['basic'],
    })
    // external_senders goes first so that its ts-mls index and its RFC vector index are both 0.
    const groupExtensions: Extension[] = [
      { extensionType: 'external_senders', extensionData: encodeExternalSender({ signaturePublicKey: ds.publicKey, credential: dsCredential }) },
      { extensionType: 'required_capabilities', extensionData: required },
      { extensionType: EXT_GROUP_DESCRIPTOR, extensionData: te.encode('dm:channel-1') },
    ]

    const alice = await device(cs, 'alice', 'a1')
    const bob = await device(cs, 'bob', 'b1')
    const carol = await device(cs, 'carol', 'c1')
    const dave = await device(cs, 'dave', 'd1')
    const aliceKp = await keyPackage(cs, alice)
    const bobKp = await keyPackage(cs, bob)
    const carolKp = await keyPackage(cs, carol)
    const daveKp = await keyPackage(cs, dave)

    const groupId = te.encode('dm:channel-1')
    let a = await createGroup(groupId, aliceKp.publicPackage, aliceKp.privatePackage, groupExtensions, cs, cfg)
    expect(seen).toContain('takusen:ds')

    // 1. Add + Welcome. The commit is a PublicMessage so the DS can read it.
    const add = await createCommit(
      { state: a, cipherSuite: cs },
      {
        wireAsPublicMessage: true,
        extraProposals: [
          { proposalType: 'add', add: { keyPackage: bobKp.publicPackage } },
          { proposalType: 'add', add: { keyPackage: carolKp.publicPackage } },
        ],
      },
    )
    a = add.newState
    expect(add.commit.wireformat).toBe('mls_public_message')
    expect(add.welcome).toBeDefined()
    const welcomeMsg = wire({ version: 'mls10', wireformat: 'mls_welcome', welcome: add.welcome! })
    if (welcomeMsg.wireformat !== 'mls_welcome') throw new Error('welcome')
    // The ratchet tree travels apart from the Welcome (§12: "ratchet tree in a separate frame").
    const treeBytes = encodeRatchetTree(a.ratchetTree)
    const tree = decodeRatchetTree(treeBytes, 0)![0]
    let b = await joinGroup(welcomeMsg.welcome, bobKp.publicPackage, bobKp.privatePackage, emptyPskIndex, cs, tree, undefined, cfg)
    let c = await joinGroup(welcomeMsg.welcome, carolKp.publicPackage, carolKp.privatePackage, emptyPskIndex, cs, tree, undefined, cfg)
    expect(b.groupContext.epoch).toBe(1n)
    expect(seen).toEqual(expect.arrayContaining(['alice:a1', 'bob:b1', 'carol:c1']))
    // The leaf extension survives into the tree.
    expect(leafChain(b, 0)).toBe('chain(a1)')
    expect(leafChain(a, 1)).toBe('chain(b1)')

    // 2. Exporter and epoch authenticator agree in one epoch.
    expect(await exporter(b, cs)).toEqual(await exporter(a, cs))
    expect(await exporter(c, cs)).toEqual(await exporter(a, cs))
    expect(b.keySchedule.epochAuthenticator).toEqual(a.keySchedule.epochAuthenticator)
    const sframe = await mlsExporter(a.keySchedule.exporterSecret, 'SFrame 1.0 Base Key', new Uint8Array(), 32, cs)
    expect(sframe).toHaveLength(32)

    // 3. The DS can inspect a PublicMessage commit without group state.
    const dsView = wire(add.commit)
    if (dsView.wireformat !== 'mls_public_message') throw new Error('public')
    const content = dsView.publicMessage.content
    expect(content.sender.senderType).toBe('member')
    expect(content.epoch).toBe(0n)
    if (content.contentType !== 'commit') throw new Error('commit')
    const addedIdentities = content.commit.proposals.flatMap((p) =>
      p.proposalOrRefType === 'proposal' && p.proposal.proposalType === 'add'
        ? [td.decode((p.proposal.add.keyPackage.leafNode.credential as { identity: Uint8Array }).identity)]
        : [],
    )
    expect(addedIdentities).toEqual(['bob:b1', 'carol:c1'])

    // 4. External Remove from the DS, committed by a member (by reference).
    const gi = await createGroupInfoWithExternalPub(a, [], cs)
    const removeCarol = await proposeExternal(gi, { proposalType: 'remove', remove: { removed: 2 } }, ds.publicKey, ds.signKey, cs)
    a = await apply(a, removeCarol, cs)
    b = await apply(b, removeCarol, cs)
    c = await apply(c, removeCarol, cs)
    expect(Object.keys(a.unappliedProposals)).toHaveLength(1)
    const rm = await createCommit({ state: a, cipherSuite: cs }, { wireAsPublicMessage: true })
    a = rm.newState
    b = await apply(b, rm.commit, cs)
    c = await apply(c, rm.commit, cs)
    expect(a.groupContext.epoch).toBe(2n)
    expect(c.groupActiveState.kind).toBe('removedFromGroup')
    expect(await exporter(b, cs)).toEqual(await exporter(a, cs))

    // 5. External commit join from GroupInfo with the ratchet tree.
    const giTree = await createGroupInfoWithExternalPubAndRatchetTree(a, [], cs)
    const giWire = wire({ version: 'mls10', wireformat: 'mls_group_info', groupInfo: giTree })
    if (giWire.wireformat !== 'mls_group_info') throw new Error('gi')
    // DS-side checks without group state: the signer's key comes from the tree, the tree hash matches.
    const giTreeExt = giWire.groupInfo.extensions.find((e) => e.extensionType === 'ratchet_tree')!
    const dsTree = decodeRatchetTree(giTreeExt.extensionData, 0)![0]
    expect(await treeHashRoot(dsTree, cs.hash)).toEqual(giWire.groupInfo.groupContext.treeHash)
    const signerLeaf = dsTree[giWire.groupInfo.signer * 2]
    if (signerLeaf?.nodeType !== 'leaf') throw new Error('signer')
    expect(await verifyGroupInfoSignature(giWire.groupInfo, signerLeaf.leaf.signaturePublicKey, cs.signature)).toBe(true)

    const ext = await joinGroupExternal(giWire.groupInfo, daveKp.publicPackage, daveKp.privatePackage, false, cs, undefined, cfg)
    let d = ext.newState
    const extCommit: MLSMessage = { version: 'mls10', wireformat: 'mls_public_message', publicMessage: ext.publicMessage }
    expect(wire(extCommit).wireformat).toBe('mls_public_message')
    a = await apply(a, extCommit, cs)
    b = await apply(b, extCommit, cs)
    expect(d.groupContext.epoch).toBe(3n)
    expect(await exporter(d, cs)).toEqual(await exporter(a, cs))
    expect(await exporter(b, cs)).toEqual(await exporter(a, cs))
    // Dave took the blank leaf that Carol left (leftmost blank).
    expect(d.privatePath.leafIndex).toBe(2)

    // 6. Group state round trip (the encrypted store persists these bytes).
    const bytes = encodeGroupState(d)
    const restored = decodeGroupState(bytes, 0)
    expect(restored).toBeDefined()
    d = { ...restored![0], clientConfig: cfg }
    expect(await exporter(d, cs)).toEqual(await exporter(a, cs))
    // The restored state can still commit.
    const upd = await createCommit({ state: d, cipherSuite: cs }, { wireAsPublicMessage: true })
    a = await apply(a, upd.commit, cs)
    expect(await exporter(upd.newState, cs)).toEqual(await exporter(a, cs))
    // Leaf extensions survive external commits and update paths.
    expect(leafChain(a, 2)).toBe('chain(d1)')
    expect(leafChain(upd.newState, 0)).toBe('chain(a1)')
  }, 60_000)

  // Finding: createUpdatePath copies the old leaf extensions, and CreateCommitOptions cannot
  // set new ones. After a DSK rotation, a device therefore puts its new chain into the tree by
  // a resync external commit with a new key package (§12.4 revocation step 4).
  it('changes a leaf chain only by a resync external commit', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE))
    const cfg = config(recordingAuthService([]))
    const alice = await device(cs, 'alice', 'a1')
    const bob = await device(cs, 'bob', 'b1')
    const aKp = await keyPackage(cs, alice)
    const bKp = await keyPackage(cs, bob)
    let a = await createGroup(te.encode('resync'), aKp.publicPackage, aKp.privatePackage, [], cs, cfg)
    const add = await createCommit(
      { state: a, cipherSuite: cs },
      { wireAsPublicMessage: true, extraProposals: [{ proposalType: 'add', add: { keyPackage: bKp.publicPackage } }] },
    )
    a = add.newState
    let b = await joinGroup(add.welcome!, bKp.publicPackage, bKp.privatePackage, emptyPskIndex, cs, a.ratchetTree, undefined, cfg)

    // A normal commit with an update path keeps the old chain.
    const upd = await createCommit({ state: b, cipherSuite: cs }, { wireAsPublicMessage: true })
    b = upd.newState
    a = await apply(a, upd.commit, cs)
    expect(leafChain(a, 1)).toBe('chain(b1)')

    // A resync with a new key package (same signature key, new chain) replaces the chain.
    const caps = defaultCapabilities()
    caps.extensions.push(EXT_DEVICE_CHAIN, EXT_GROUP_DESCRIPTOR)
    const credential: Credential = { credentialType: 'basic', identity: te.encode('bob:b1') }
    const rotated = await generateKeyPackageWithKey(credential, caps, defaultLifetime, [], bob.sig, cs, [
      { extensionType: EXT_DEVICE_CHAIN, extensionData: te.encode('chain(b1, dsk 2)') },
    ])
    const gi = await createGroupInfoWithExternalPubAndRatchetTree(a, [], cs)
    const resync = await joinGroupExternal(gi, rotated.publicPackage, rotated.privatePackage, true, cs, undefined, cfg)
    b = resync.newState
    a = await apply(a, { version: 'mls10', wireformat: 'mls_public_message', publicMessage: resync.publicMessage }, cs)
    expect(b.privatePath.leafIndex).toBe(1)
    expect(leafChain(a, 1)).toBe('chain(b1, dsk 2)')
    expect(await exporter(b, cs)).toEqual(await exporter(a, cs))
  }, 60_000)

  // Finding: joinGroupExternal takes authenticated_data, and the FramedContent signature of the new
  // leaf covers it. The InviteAuth of an invite join rides there (§12.11.4): a member reads it from
  // the decoded commit before processMessage, the DS checks it with verifyFramedContentSignature,
  // and a changed value fails both. Nothing of it enters the tree.
  it('keeps the authenticated_data of an external commit under the signature of the new leaf', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE))
    const cfg = config(recordingAuthService([]))
    const alice = await device(cs, 'alice', 'a1')
    const bob = await device(cs, 'bob', 'b1')
    const aKp = await keyPackage(cs, alice)
    const bKp = await keyPackage(cs, bob)
    let a = await createGroup(te.encode('auth'), aKp.publicPackage, aKp.privatePackage, [], cs, cfg)
    const gi = await createGroupInfoWithExternalPubAndRatchetTree(a, [], cs)
    const auth = te.encode('invite auth')
    const ext = await joinGroupExternal(gi, bKp.publicPackage, bKp.privatePackage, false, cs, undefined, cfg, auth)
    const msg = wire({ version: 'mls10', wireformat: 'mls_public_message', publicMessage: ext.publicMessage })
    if (msg.wireformat !== 'mls_public_message') throw new Error('public')
    const pm = msg.publicMessage
    if (pm.content.contentType !== 'commit' || pm.content.sender.senderType !== 'new_member_commit') throw new Error('external commit')
    expect(pm.content.authenticatedData).toEqual(auth)
    const leafKey = pm.content.commit.path!.leafNode.signaturePublicKey
    expect(leafKey).toEqual(bob.sig.publicKey)

    // The DS check, without group state.
    expect(await verifyFramedContentSignature(leafKey, 'mls_public_message', pm.content, pm.auth, a.groupContext, cs.signature)).toBe(true)
    const changed = { ...pm, content: { ...pm.content, authenticatedData: te.encode('invite auth!') } }
    expect(await verifyFramedContentSignature(leafKey, 'mls_public_message', changed.content, changed.auth, a.groupContext, cs.signature)).toBe(false)

    // A member rejects the changed value and applies the original.
    await expect(processMessage({ wireformat: 'mls_public_message', publicMessage: changed }, a, emptyPskIndex, acceptAll, cs)).rejects.toThrow(/Signature invalid/)
    a = await apply(a, msg, cs)
    expect(await exporter(a, cs)).toEqual(await exporter(ext.newState, cs))
    const leaf = a.ratchetTree[2]
    if (leaf?.nodeType !== 'leaf') throw new Error('leaf')
    expect(leaf.leaf.extensions.map((e) => e.extensionType)).toEqual([EXT_DEVICE_CHAIN])
  }, 60_000)

  it('rejects a leaf when the authentication service says no', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE))
    const reject: AuthenticationService = {
      validateCredential: (c) => Promise.resolve(c.credentialType === 'basic' && td.decode(c.identity) !== 'mallory:m1'),
    }
    const alice = await device(cs, 'alice', 'a1')
    const mallory = await device(cs, 'mallory', 'm1')
    const aKp = await keyPackage(cs, alice)
    const mKp = await keyPackage(cs, mallory)
    const a = await createGroup(te.encode('g'), aKp.publicPackage, aKp.privatePackage, [], cs, config(reject))
    // ts-mls checks the credential when the committer applies an Add.
    await expect(
      createCommit({ state: a, cipherSuite: cs }, { extraProposals: [{ proposalType: 'add', add: { keyPackage: mKp.publicPackage } }] }),
    ).rejects.toThrow()
  }, 30_000)

  // Finding: ts-mls 1.6.4 can create a group with a custom credential type, but its
  // decoders cannot read one back. Hachiman therefore uses BasicCredential plus the
  // EXT_DEVICE_CHAIN leaf extension. If this test starts to fail, custom credentials work.
  it('cannot decode a custom credential type (use BasicCredential + leaf extension)', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE))
    const custom = createCustomCredential(0xf1a2, te.encode('custom-bytes'))
    const caps = defaultCapabilities()
    caps.credentials.push(custom.credentialType)
    const sig = await cs.signature.keygen()
    const kp = await generateKeyPackageWithKey(custom, caps, defaultLifetime, [], sig, cs)
    const g = await createGroup(te.encode('custom'), kp.publicPackage, kp.privatePackage, [], cs)
    const leaf = g.ratchetTree[0]
    if (leaf?.nodeType !== 'leaf') throw new Error('leaf')
    expect(leaf.leaf.credential.credentialType).toBe(String(0xf1a2))
    const bytes = encodeGroupState(g)
    expect(() => decodeGroupState(bytes, 0)).toThrow()
  }, 30_000)

  it('runs Add + Welcome + exporter on the X-Wing suite', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(XWING))
    const alice = await device(cs, 'alice', 'a1')
    const bob = await device(cs, 'bob', 'b1')
    const aKp = await keyPackage(cs, alice)
    const bKp = await keyPackage(cs, bob)
    let a = await createGroup(te.encode('pq'), aKp.publicPackage, aKp.privatePackage, [], cs)
    const r = await createCommit(
      { state: a, cipherSuite: cs },
      { wireAsPublicMessage: true, extraProposals: [{ proposalType: 'add', add: { keyPackage: bKp.publicPackage } }] },
    )
    a = r.newState
    const b = await joinGroup(r.welcome!, bKp.publicPackage, bKp.privatePackage, emptyPskIndex, cs, a.ratchetTree)
    expect(await exporter(b, cs)).toEqual(await exporter(a, cs))
    expect(b.groupContext.cipherSuite).toBe(XWING)
  }, 60_000)

  it('needs the full ratchet tree to join (no light-client mode)', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE))
    const alice = await device(cs, 'alice', 'a1')
    const bob = await device(cs, 'bob', 'b1')
    const aKp = await keyPackage(cs, alice)
    const bKp = await keyPackage(cs, bob)
    const a = await createGroup(te.encode('lc'), aKp.publicPackage, aKp.privatePackage, [], cs)
    const r = await createCommit({ state: a, cipherSuite: cs }, { extraProposals: [{ proposalType: 'add', add: { keyPackage: bKp.publicPackage } }] })
    await expect(joinGroup(r.welcome!, bKp.publicPackage, bKp.privatePackage, emptyPskIndex, cs)).rejects.toThrow()
  }, 30_000)
})
