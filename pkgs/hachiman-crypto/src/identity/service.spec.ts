import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAdminService } from '../admin/service'
import { DEFAULT_EVERYONE_PERMISSIONS, admin } from '../admin/index'
import type { CryptoErrorShape } from '../api'
import { fromB64url, toB64url } from '../codec'
import { DSK_ROTATION_GRACE_MS, LINK_SESSION_TTL_MS } from '../constants'
import { kt } from '../kt/index'
import { decodeHistoryKeysPayload, encodeDskTransfer } from './codec'
import { openDeviceMessage } from './device-message'
import { identity } from './index'
import { DsError, FakeDs, makeDevice, testPermissions, type TestDevice } from './test-helpers'

const ALICE = '0f8fad5b-d9cb-469f-a165-70867728950e'
const BOB = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const GUILD = '11111111-1111-4111-8111-111111111111'
const secretKey = (g: Uint8Array, e: number) => `${toB64url(g)}:${e}`

let ds: FakeDs
beforeEach(() => {
  ds = new FakeDs()
})

async function primary(userId = ALICE, name = 'Desktop'): Promise<{ dev: TestDevice; recoveryKey: string }> {
  const dev = await makeDevice(ds, userId, name)
  const { recoveryKey } = await dev.svc.setupFirstDevice()
  await ds.flush()
  return { dev, recoveryKey }
}

async function linkSas(existing: TestDevice, name: string): Promise<TestDevice> {
  const dev = await makeDevice(ds, existing.init.userId, name)
  const { sessionId, qrPayload } = await dev.svc.linkAsNewDevice('sas')
  expect(qrPayload).toBeNull()
  expect(dev.svc.status().state).toBe('linking')
  await ds.flush()
  const listed = await existing.svc.listLinkSessions()
  expect(listed.map((s) => s.newDeviceName)).toContain(name)
  await existing.svc.linkAccept(sessionId)
  await ds.flush()
  const a = existing.of('linkSas').find((x) => x.sessionId === sessionId)
  const b = dev.of('linkSas').find((x) => x.sessionId === sessionId)
  expect(a?.emoji).toHaveLength(7)
  expect(a?.emoji).toEqual(b?.emoji)
  await existing.svc.linkConfirmSas(sessionId, true)
  await ds.flush()
  expect(dev.of('linkDone')).toEqual([{ sessionId, role: 'new_device', ok: true, error: null }])
  expect(existing.of('linkDone').filter((x) => x.sessionId === sessionId)).toEqual([{ sessionId, role: 'existing_device', ok: true, error: null }])
  return dev
}

async function linkQr(existing: TestDevice, name: string): Promise<TestDevice> {
  const dev = await makeDevice(ds, existing.init.userId, name)
  const { sessionId, qrPayload } = await dev.svc.linkAsNewDevice('qr')
  await ds.flush()
  const r = await existing.svc.linkScan(qrPayload!)
  expect(r).toEqual({ sessionId, newDeviceName: name })
  await ds.flush()
  expect(dev.of('linkDone')).toEqual([{ sessionId, role: 'new_device', ok: true, error: null }])
  return dev
}

async function deliverInbox(dev: TestDevice): Promise<number> {
  const items = await dev.transport.fetchInbox(0)
  for (const item of items) {
    await dev.svc.handleInboxItem(item)
    await dev.transport.ackInbox(item.id)
  }
  return items.length
}

describe('first device', () => {
  it('creates the identity, certifies itself, backs up and uploads key packages', async () => {
    const { dev, recoveryKey } = await primary()
    const st = dev.svc.status()
    expect(st).toMatchObject({ state: 'ready', userId: ALICE, primary: true, recoveryConfigured: true, hostTrust: 'strong' })
    expect(identity.parseRecoveryKey(recoveryKey)).toHaveLength(32)
    const self = dev.svc.self()
    expect(ds.devices.get(self.deviceId)?.status).toBe('active')
    const keys = await dev.transport.getUserKeys(ALICE)
    expect(keys.masterKey?.generation).toBe(1)
    expect(keys.deviceSigningKey?.generation).toBe(1)
    expect(ds.keyPackages.get(`${self.deviceId}:1`)).toEqual({ count: 100, lastResort: true })
    expect(ds.backups.get(ALICE)?.items.map((i) => i.kind)).toEqual(['identity'])
    // The chain of this device passes the chain check as an entering leaf.
    const ctx = await dev.svc.chainContextFor(ALICE, true)
    expect(identity.verifyChain(self.chain, { ...ctx, leaf: { credentialIdentity: identity.credentialIdentity(ALICE, self.deviceId), signatureKey: self.mlsSignatureKey.publicKey } })).toEqual({ ok: true, firstSight: false })
  })

  it('reloads from the store', async () => {
    const { dev } = await primary()
    const again = await makeDevice(ds, ALICE, 'Desktop', dev.store)
    expect(again.svc.status().state).toBe('ready')
    expect(again.svc.self().chain).toEqual(dev.svc.self().chain)
  })

  it('refuses a second first device', async () => {
    await primary()
    const other = await makeDevice(ds, ALICE, 'Laptop')
    await expect(other.svc.setupFirstDevice()).rejects.toMatchObject({ code: 'Unsupported' })
  })
})

describe('user keys', () => {
  it('gives an empty chain context for a user who shares no guild any more (404)', async () => {
    const { dev } = await primary()
    dev.transport.getUserKeys = async () => {
      throw new DsError('NotFound')
    }
    const c = await dev.svc.chainContextFor(BOB, false)
    expect(c).toMatchObject({ pinnedMaster: null, currentDsk: null, revokedDeviceIds: new Set() })
  })
})

describe('device linking', () => {
  it('links in SAS mode and in QR mode', async () => {
    const { dev: a } = await primary()
    const b = await linkSas(a, 'Phone')
    expect(b.svc.status()).toMatchObject({ state: 'ready', primary: false })
    expect(b.svc.self().chain.dsk).toEqual(a.svc.self().chain.dsk)
    const c = await linkQr(b, 'Tablet')
    expect(c.svc.status().state).toBe('ready')
    // The new devices hold certified chains that verify from another device.
    for (const d of [b, c]) {
      const s = d.svc.self()
      const ctx = await a.svc.chainContextFor(ALICE, true)
      expect(identity.verifyChain(s.chain, { ...ctx, leaf: { credentialIdentity: `${ALICE}:${s.deviceId}`, signatureKey: s.mlsSignatureKey.publicKey } }).ok).toBe(true)
      expect(await a.svc.deviceCertificate(ALICE, s.deviceId)).toEqual(s.chain.device)
    }
    expect(ds.links.size).toBe(0)
    // The new device gets a full set of key packages.
    expect(ds.keyPackages.get(`${c.svc.self().deviceId}:1`)).toEqual({ count: 100, lastResort: true })
  })

  it('the new device stores the history keys before it is ready, and says which arrived', async () => {
    const { dev: a } = await primary()
    const g = new Uint8Array(22).fill(5)
    for (const e of [1, 2]) await a.store.put('epochSecrets', secretKey(g, e), { groupId: g, epoch: e, secret: new Uint8Array(32).fill(e), backedUp: false })
    const b = await linkSas(a, 'Phone')
    expect((await b.store.list('epochSecrets')).map((x) => x.value.epoch).sort()).toEqual([1, 2])
    // The pending messages of those epochs decrypt again (the UI retries the group).
    expect(b.of('epochKeysAvailable')).toEqual([{ groupId: toB64url(g), epochs: [1, 2] }])
    // 'ready' opens the app, which decrypts the open channel at once: the keys come first.
    const kinds = b.events.map((x) => (x.event === 'status' ? `status:${(x.payload as { state: string }).state}` : x.event))
    expect(kinds.indexOf('epochKeysAvailable')).toBeLessThan(kinds.indexOf('status:ready'))
  })

  it('a history above one link message: the newest keys in the transfer, the rest in the inbox', async () => {
    const { dev: a } = await primary()
    const groups = [1, 2, 3].map((n) => new Uint8Array(22).fill(n))
    for (const g of groups) for (let e = 0; e < 3000; e++) await a.store.put('epochSecrets', secretKey(g, e), { groupId: g, epoch: e, secret: new Uint8Array(32).fill(e % 256), backedUp: false })
    const b = await linkSas(a, 'Phone')
    const inTransfer = (await b.store.list('epochSecrets')).map((x) => x.key)
    expect(inTransfer.length).toBeGreaterThan(0)
    expect(inTransfer.length).toBeLessThan(9000)
    for (const g of groups) expect(inTransfer).toContain(secretKey(g, 2999))
    // One history_keys item per group, sent in the background.
    await vi.waitFor(() => expect(ds.inbox.get(b.svc.self().deviceId)).toHaveLength(3))
    const items = ds.inbox.get(b.svc.self().deviceId)!
    expect(items.every((i) => i.kind === 'history_keys')).toBe(true)
    const pushed: string[] = []
    for (const item of items) {
      const opened = await openDeviceMessage({
        recipientHpkePrivateKey: b.svc.self().hpkeKey.privateKey,
        recipientDeviceId: b.svc.self().deviceId,
        sealed: fromB64url(item.body),
        senderSignatureKey: () => Promise.resolve(a.svc.self().mlsSignatureKey.publicKey),
      })
      const p = decodeHistoryKeysPayload(opened.payload)
      pushed.push(...p.keys.map((k) => secretKey(p.groupId, k.epoch)))
    }
    expect([...inTransfer, ...pushed].sort()).toEqual(groups.flatMap((g) => Array.from({ length: 3000 }, (_, e) => secretKey(g, e))).sort())
  })

  it('SAS mode: a key substituted by the DS changes the emoji and the user stops the transfer', async () => {
    const { dev: a } = await primary()
    const b = await makeDevice(ds, ALICE, 'Phone')
    const { sessionId } = await b.svc.linkAsNewDevice('sas')
    // The DS replaces e_existing in the accept message.
    const evil = identity.link.createOffer({ userId: ALICE, deviceId: b.svc.status().deviceId!, mlsSignatureKey: new Uint8Array(32), hpkeKey: new Uint8Array(32), deviceName: 'x', platform: 'electron' }, 'sas').secrets.ephemeral
    ds.tamperLink = (body) => {
      const m = identity.link.decodeMessage(body)
      return m.type === 'accept' ? identity.link.encodeMessage({ ...m, ephemeralPublic: evil.publicKey }) : body
    }
    await a.svc.linkAccept(sessionId)
    await ds.flush()
    const ea = a.of('linkSas')[0]!.emoji
    const eb = b.of('linkSas')[0]!.emoji
    expect(ea).not.toEqual(eb)
    await a.svc.linkConfirmSas(sessionId, false)
    await ds.flush()
    expect(a.of('linkDone')).toEqual([{ sessionId, role: 'existing_device', ok: false, error: 'SasMismatch' }])
    expect(b.of('linkDone')).toEqual([{ sessionId, role: 'new_device', ok: false, error: 'SasMismatch' }])
    expect(b.svc.status().state).toBe('linking')
    expect(ds.devices.get(b.svc.status().deviceId!)?.status).toBe('pending')
  })

  it('QR mode: a substituted key on the DS makes the transfer fail on the new device', async () => {
    const { dev: a } = await primary()
    const c = await makeDevice(ds, ALICE, 'Tablet')
    const { qrPayload } = await c.svc.linkAsNewDevice('qr')
    const evil = identity.link.createOffer({ userId: ALICE, deviceId: c.svc.status().deviceId!, mlsSignatureKey: new Uint8Array(32), hpkeKey: new Uint8Array(32), deviceName: 'x', platform: 'electron' }, 'sas').secrets.ephemeral
    ds.tamperLink = (body) => {
      const m = identity.link.decodeMessage(body)
      return m.type === 'accept' ? identity.link.encodeMessage({ ...m, ephemeralPublic: evil.publicKey }) : body
    }
    await a.svc.linkScan(qrPayload!)
    await ds.flush()
    expect(c.of('linkDone')).toEqual([expect.objectContaining({ role: 'new_device', ok: false })])
    expect(c.svc.status().state).toBe('linking')
  })

  it('rejects a QR code whose offer differs from the DS session', async () => {
    const { dev: a } = await primary()
    const c = await makeDevice(ds, ALICE, 'Tablet')
    const { sessionId, qrPayload } = await c.svc.linkAsNewDevice('qr')
    const s = ds.links.get(sessionId)!
    const offer = identity.link.decodeOffer(fromB64url(s.offer))
    s.offer = toB64url(identity.link.encodeOffer({ ...offer, deviceName: 'Evil' }))
    await expect(a.svc.linkScan(qrPayload!)).rejects.toMatchObject({ code: 'LinkAborted' })
  })

  it('expires after 10 minutes', async () => {
    const { dev: a } = await primary()
    const b = await makeDevice(ds, ALICE, 'Phone')
    const { sessionId } = await b.svc.linkAsNewDevice('sas')
    ds.now += LINK_SESSION_TTL_MS + 1
    expect(await a.svc.listLinkSessions()).toEqual([])
    await expect(a.svc.linkAccept(sessionId)).rejects.toMatchObject({ code: 'LinkExpired' })
    await b.svc.onGatewayEvent({ t: 'DEVICE_LINK', d: { sessionId, seq: 1, fromDevice: a.svc.self().deviceId } })
    expect(b.of('linkDone')).toEqual([{ sessionId, role: 'new_device', ok: false, error: 'LinkExpired' }])
  })

  it('cancels', async () => {
    const { dev: a } = await primary()
    const b = await makeDevice(ds, ALICE, 'Phone')
    const { sessionId } = await b.svc.linkAsNewDevice('sas')
    await a.svc.linkAccept(sessionId)
    await ds.flush()
    await a.svc.linkCancel(sessionId)
    await ds.flush()
    expect(a.of('linkDone')).toEqual([{ sessionId, role: 'existing_device', ok: false, error: 'LinkAborted' }])
    expect(b.of('linkDone')).toEqual([{ sessionId, role: 'new_device', ok: false, error: 'LinkAborted' }])
  })

  it('ignores a cancel from the new device after it took the keys', async () => {
    const { dev: a } = await primary()
    const b = await makeDevice(ds, ALICE, 'Phone')
    const { sessionId, qrPayload } = await b.svc.linkAsNewDevice('qr')
    // The UI unmounts the link screen at status 'ready' and cancels a session it thinks is open.
    const push = b.events.push.bind(b.events)
    b.events.push = (...items) => {
      for (const i of items) if (i.event === 'status' && (i.payload as { state: string }).state === 'ready') void b.svc.linkCancel(sessionId)
      return push(...items)
    }
    await ds.flush()
    await a.svc.linkScan(qrPayload!)
    await ds.flush()
    expect(b.of('linkDone')).toEqual([{ sessionId, role: 'new_device', ok: true, error: null }])
    expect(a.of('linkDone')).toEqual([{ sessionId, role: 'existing_device', ok: true, error: null }])
  })
})

describe('revocation and DSK rotation across devices', () => {
  it('rotates the DSK, re-certifies the others, ignores a replayed dsk_transfer, verifies signed_out', async () => {
    const { dev: a } = await primary()
    const b = await linkSas(a, 'Phone')
    const c = await linkSas(a, 'Tablet')
    const d = await linkSas(a, 'Old laptop')
    const cId = c.svc.self().deviceId
    const dId = d.svc.self().deviceId
    const bRotationsBefore = b.dskRotations

    // A non-primary device cannot revoke.
    await expect(b.svc.revokeDevice(cId, 'lost')).rejects.toMatchObject({ code: 'Unsupported' })

    // Revoke C: generation 2. Before the dsk_transfer, B does not upload packages with the old chain.
    const uploadsBefore = ds.uploads.filter((u) => u.deviceId === b.svc.self().deviceId).length
    await a.svc.revokeDevice(cId, 'lost')
    await ds.flush()
    expect(ds.devices.get(cId)?.status).toBe('revoked')
    expect(a.svc.self().chain.dsk.generation).toBe(2)
    expect(a.dskRotations).toBe(1)
    expect(ds.uploads.filter((u) => u.deviceId === b.svc.self().deviceId).length).toBe(uploadsBefore)

    const firstTransfer = (await b.transport.fetchInbox(0))[0]!
    expect(await deliverInbox(b)).toBe(1)
    expect(b.svc.self().chain.dsk.generation).toBe(2)
    expect(b.dskRotations).toBe(bRotationsBefore + 1)
    expect(ds.keyPackages.get(`${b.svc.self().deviceId}:1`)).toEqual({ count: 100, lastResort: true })
    expect(b.keyPackageCalls.at(-1)?.dskGeneration).toBe(2)
    // The revoked device gets no transfer.
    expect(ds.inbox.get(cId) ?? []).toEqual([])

    // C is revoked in every chain context, and its chain fails.
    const ctx = await b.svc.chainContextFor(ALICE, false)
    expect(ctx.revokedDeviceIds.has(cId)).toBe(true)

    // Revoke D: generation 3. Then replay the generation 2 transfer: no effect.
    await a.svc.revokeDevice(dId, 'compromised')
    await ds.flush()
    await deliverInbox(b)
    expect(b.svc.self().chain.dsk.generation).toBe(3)
    const rotations = b.dskRotations
    await b.svc.handleInboxItem(firstTransfer)
    expect(b.svc.self().chain.dsk.generation).toBe(3)
    expect(b.dskRotations).toBe(rotations)

    // The identity backup follows the rotation.
    const bk = ds.backups.get(ALICE)!
    expect(bk.items.filter((i) => i.kind === 'identity')).toHaveLength(1)

    // A new device signs itself out with its own MLS key. The DS verifies it under the device certificate.
    const e = await linkQr(b, 'Browser')
    const eId = e.svc.self().deviceId
    await e.svc.signOutDevice()
    expect(e.svc.status().state).toBe('revoked')
    expect(e.store.destroyed).toBe(1)
    const row = ds.devices.get(eId)!
    expect(row.revokeReason).toBe('signed_out')
    const rev = identity.decodeRevocation(fromB64url(row.revocation!))
    expect(rev.reason).toBe(5)
    const cert = identity.decodeDeviceCertificate(fromB64url(row.certificate!))
    expect(identity.verifyRevocation(rev, { master: a.svc.self().chain.master, device: cert })).toBe(true)
  })

  it('rejects a dsk_transfer that is not under the own master or comes from a stranger', async () => {
    const { dev: a } = await primary()
    const b = await linkSas(a, 'Phone')
    const s = b.svc.self()
    // A valid-looking transfer signed by another master key.
    const foreign = identity.createMasterKey(ALICE, 1, null)
    const dsk = identity.createDeviceSigningKey(foreign, 2)
    const device = identity.certifyDevice(dsk, { deviceId: s.deviceId, mlsSignatureKey: s.mlsSignatureKey.publicKey, hpkeKey: s.hpkeKey.publicKey, issuedAtMs: 0, displayName: 'Phone' })
    const aSelf = a.svc.self()
    const sealed = await identity.sealToDevice(s.hpkeKey.publicKey, 'dsk_transfer', aSelf.deviceId, encodeDskTransfer({ dsk: dsk.cert, dskPrivateKey: dsk.keyPair.privateKey, device }), { recipientDeviceId: s.deviceId, signatureKey: aSelf.mlsSignatureKey.privateKey })
    const item = { id: 'x', seq: 1, kind: 'dsk_transfer' as const, senderDevice: aSelf.deviceId, body: toB64url(sealed), createdAt: '' }
    await expect(b.svc.handleInboxItem(item)).rejects.toMatchObject({ code: 'InvalidChain' })
    // A sender that is not a device of the same user, or a mislabelled sender.
    await expect(b.svc.handleInboxItem({ ...item, senderDevice: s.deviceId })).rejects.toMatchObject({ code: 'Malformed' })
    expect(b.svc.self().chain.dsk.generation).toBe(1)
  })

  it('keeps a superseded member leaf valid for the grace period only', async () => {
    const { dev: a } = await primary()
    const b = await linkSas(a, 'Phone')
    const c = await linkSas(a, 'Tablet')
    const oldChain = b.svc.self().chain
    await a.svc.revokeDevice(c.svc.self().deviceId, 'user')
    await ds.flush()
    const leaf = { credentialIdentity: `${ALICE}:${b.svc.self().deviceId}`, signatureKey: b.svc.self().mlsSignatureKey.publicKey }
    const member = await a.svc.chainContextFor(ALICE, false)
    expect(identity.verifyChain(oldChain, { ...member, leaf })).toEqual({ ok: true, firstSight: false })
    expect(identity.verifyChain(oldChain, { ...(await a.svc.chainContextFor(ALICE, true)), leaf })).toEqual({ ok: false, reason: 'dsk_superseded' })
    expect(identity.verifyChain(oldChain, { ...member, leaf, nowMs: member.currentDsk!.issuedAtMs + DSK_ROTATION_GRACE_MS })).toEqual({ ok: false, reason: 'dsk_superseded' })
  })
})

describe('recovery', () => {
  it('restores the identity from the recovery key, and a wrong key fails', async () => {
    const { dev: a, recoveryKey } = await primary()
    const wrong = await makeDevice(ds, ALICE, 'New')
    await expect(wrong.svc.restoreFromRecoveryKey(identity.generateRecoveryKey().text)).rejects.toMatchObject({ code: 'WrongRecoveryKey' })
    await expect(wrong.svc.restoreFromRecoveryKey('HRK1-nope')).rejects.toMatchObject({ code: 'InvalidRecoveryKey' })
    const st = await wrong.svc.restoreFromRecoveryKey(recoveryKey)
    expect(st).toMatchObject({ state: 'ready', primary: true, recoveryConfigured: true })
    expect(wrong.svc.self().chain.master).toEqual(a.svc.self().chain.master)
    expect(ds.devices.get(wrong.svc.self().deviceId)?.status).toBe('active')
  })

  it('restores after a password reset with the same master record', async () => {
    const { dev: a, recoveryKey } = await primary()
    await a.store.put('epochSecrets', secretKey(new Uint8Array(22).fill(1), 1), { groupId: new Uint8Array(22).fill(1), epoch: 1, secret: new Uint8Array(32).fill(7), backedUp: false })
    expect(await a.svc.backupNow()).toEqual({ uploaded: 1 })
    ds.passwordReset(ALICE)
    expect((await a.transport.getUserKeys(ALICE)).masterKey).toBeNull()
    const n = await makeDevice(ds, ALICE, 'After reset')
    await n.svc.restoreFromRecoveryKey(recoveryKey)
    expect(n.svc.self().chain.master).toEqual(a.svc.self().chain.master)
    expect((await n.transport.getUserKeys(ALICE)).masterKey?.generation).toBe(1)
    // History keys come back from the backup, and the messages pending on them decrypt again.
    const secrets = await n.store.list('epochSecrets')
    expect(secrets.map((s) => s.value.epoch)).toEqual([1])
    expect(n.of('epochKeysAvailable')).toEqual([{ groupId: toB64url(new Uint8Array(22).fill(1)), epochs: [1] }])
  })

  it('makes a new identity on reset, and contacts see a key change', async () => {
    const { dev: a } = await primary(ALICE)
    const { dev: bob } = await primary(BOB, 'Bob desktop')
    expect((await bob.svc.getTrust(ALICE)).state).toBe('tofu')
    await bob.svc.setVerified(ALICE, true)
    ds.passwordReset(ALICE)
    const n = await makeDevice(ds, ALICE, 'After reset')
    const { recoveryKey } = await n.svc.resetIdentity()
    expect(identity.parseRecoveryKey(recoveryKey)).toHaveLength(32)
    expect(n.svc.self().chain.master.generation).toBe(2)
    expect(n.svc.self().chain.master.prevSignature).toBeNull()
    // UserKeys shows no DSK without a current master: the new identity starts at generation 1.
    expect(n.svc.self().chain.dsk.generation).toBe(1)
    await ds.flush()
    expect(bob.of('keyChange')).toEqual([{ userId: ALICE, severity: 'blocking' }])
    expect((await bob.svc.getTrust(ALICE)).state).toBe('changed')
    await bob.svc.acknowledgeKeyChange(ALICE)
    expect((await bob.svc.getTrust(ALICE)).state).toBe('tofu')
    // Old chains no longer pass: the pin moved to the new master.
    const ctx = await bob.svc.chainContextFor(ALICE, false)
    expect(identity.verifyChain(a.svc.self().chain, ctx)).toEqual({ ok: false, reason: 'master_changed' })
  })

  it('rotates the recovery key and uploads every blob again', async () => {
    const { dev: a, recoveryKey } = await primary()
    for (let e = 0; e < 3; e++) await a.store.put('epochSecrets', secretKey(new Uint8Array(22).fill(2), e), { groupId: new Uint8Array(22).fill(2), epoch: e, secret: new Uint8Array(32).fill(e), backedUp: false })
    const { recoveryKey: next } = await a.svc.rotateRecoveryKey()
    expect(next).not.toBe(recoveryKey)
    const b = ds.backups.get(ALICE)!
    expect(b.items.map((i) => i.kind).sort()).toEqual(['history', 'identity'])
    expect((await a.store.list('epochSecrets')).every((s) => s.value.backedUp)).toBe(true)
    const n = await makeDevice(ds, ALICE, 'New')
    await expect(n.svc.restoreFromRecoveryKey(recoveryKey)).rejects.toMatchObject({ code: 'WrongRecoveryKey' })
    await n.svc.restoreFromRecoveryKey(next)
    expect((await n.store.list('epochSecrets')).length).toBe(3)
  })

  it('a secret that GroupService replaces during the upload stays not backed up (§12.11.1)', async () => {
    const { dev: a } = await primary()
    const g = new Uint8Array(22).fill(4)
    const imported = new Uint8Array(32).fill(1)
    const fromMls = new Uint8Array(32).fill(2)
    await a.store.put('epochSecrets', secretKey(g, 0), { groupId: g, epoch: 0, secret: imported, backedUp: false })
    await a.store.put('epochSecrets', secretKey(g, 1), { groupId: g, epoch: 1, secret: new Uint8Array(32).fill(3), backedUp: false })
    const post = a.transport.postHistoryBackup
    a.transport.postHistoryBackup = async (body) => {
      // The device enters epoch 0 while the blob is on the way: the MLS secret replaces the imported one.
      await a.store.put('epochSecrets', secretKey(g, 0), { groupId: g, epoch: 0, secret: fromMls, backedUp: false })
      return post(body)
    }
    expect(await a.svc.backupNow()).toEqual({ uploaded: 1 })
    a.transport.postHistoryBackup = post
    expect(await a.store.get('epochSecrets', secretKey(g, 0))).toMatchObject({ secret: fromMls, backedUp: false })
    expect((await a.store.get('epochSecrets', secretKey(g, 1)))?.backedUp).toBe(true)
    // The next backup uploads the MLS secret.
    ds.now += 24 * 60 * 60_000
    expect(await a.svc.backupNow()).toEqual({ uploaded: 1 })
    expect(await a.store.get('epochSecrets', secretKey(g, 0))).toMatchObject({ secret: fromMls, backedUp: true })
  })

  it('uploads history blobs at 64 unbacked epochs or after 24 h', async () => {
    const { dev: a } = await primary()
    expect(await a.svc.backupNow()).toEqual({ uploaded: 0 })
    const g = new Uint8Array(22).fill(3)
    await a.store.put('epochSecrets', secretKey(g, 0), { groupId: g, epoch: 0, secret: new Uint8Array(32), backedUp: false })
    expect(await a.svc.backupNow()).toEqual({ uploaded: 1 })
    for (let e = 1; e < 10; e++) await a.store.put('epochSecrets', secretKey(g, e), { groupId: g, epoch: e, secret: new Uint8Array(32), backedUp: false })
    expect(await a.svc.backupNow()).toEqual({ uploaded: 0 })
    for (let e = 10; e < 70; e++) await a.store.put('epochSecrets', secretKey(g, e), { groupId: g, epoch: e, secret: new Uint8Array(32), backedUp: false })
    expect(await a.svc.backupNow()).toEqual({ uploaded: 1 })
    await a.store.put('epochSecrets', secretKey(g, 70), { groupId: g, epoch: 70, secret: new Uint8Array(32), backedUp: false })
    ds.now += 24 * 60 * 60_000
    expect(await a.svc.backupNow()).toEqual({ uploaded: 1 })
  })
})

describe('trust and verification', () => {
  it('gives a symmetric safety number and verifies by QR code', async () => {
    const { dev: a } = await primary(ALICE)
    const { dev: b } = await primary(BOB, 'Bob')
    const sa = await a.svc.getSafetyNumber(BOB)
    const sb = await b.svc.getSafetyNumber(ALICE)
    expect(sa.digits).toBe(sb.digits)
    expect(await a.svc.verifyQr(sb.qrPayload)).toEqual({ userId: BOB, match: true })
    expect((await a.svc.getTrust(BOB)).state).toBe('verified')
    expect(await a.svc.trustOf(BOB)).toBe('verified')
    // A code for another key does not match.
    const fake = identity.safetyNumber({ userId: BOB, masterKey: new Uint8Array(32).fill(9) }, { userId: ALICE, masterKey: a.svc.self().chain.master.publicKey })
    expect(await a.svc.verifyQr(fake.qrPayload)).toEqual({ userId: BOB, match: false })
  })

  it('verifiedAt: set by setVerified and verifyQr, cleared by unverify and a key change, kept in the store', async () => {
    const { dev: a } = await primary(ALICE)
    const { dev: b } = await primary(BOB, 'Bob')
    expect((await a.svc.getTrust(BOB)).verifiedAt).toBeNull()
    const t1 = new Date(ds.now).toISOString()
    expect(await a.svc.setVerified(BOB, true)).toMatchObject({ state: 'verified', verifiedAt: t1 })
    expect((await a.store.get('contacts', BOB))?.verifiedAtMs).toBe(ds.now)
    // A store row of an older version has no verifiedAtMs: verified, without a date.
    const row = (await a.store.get('contacts', BOB))!
    const { verifiedAtMs: _drop, ...old } = row
    await a.store.put('contacts', BOB, old)
    expect(await a.svc.getTrust(BOB)).toMatchObject({ state: 'verified', verifiedAt: null })
    expect(await a.svc.setVerified(BOB, false)).toMatchObject({ state: 'tofu', verifiedAt: null })
    expect((await a.store.get('contacts', BOB))?.verifiedAtMs).toBeNull()
    ds.now += 60_000
    expect(await a.svc.verifyQr((await b.svc.getSafetyNumber(ALICE)).qrPayload)).toEqual({ userId: BOB, match: true })
    expect((await a.svc.getTrust(BOB)).verifiedAt).toBe(new Date(ds.now).toISOString())
    // A new master key of the contact clears it; a new verification sets a new time.
    ds.passwordReset(BOB)
    const n = await makeDevice(ds, BOB, 'Bob after reset')
    await n.svc.resetIdentity()
    await ds.flush()
    expect(await a.svc.getTrust(BOB)).toMatchObject({ state: 'changed', verifiedAt: null })
    expect((await a.store.get('contacts', BOB))?.verifiedAtMs).toBeNull()
    ds.now += 60_000
    expect(await a.svc.setVerified(BOB, true)).toMatchObject({ state: 'verified', verifiedAt: new Date(ds.now).toISOString() })
    expect((await a.svc.getTrust(ALICE)).verifiedAt).toBeNull()
  })

  it('raises keyChange on a DSK downgrade and keeps the highest generation', async () => {
    const { dev: a } = await primary(ALICE)
    const { dev: b } = await primary(BOB, 'Bob')
    const c = await linkSas(b, 'Bob phone')
    await a.svc.chainContextFor(BOB, false)
    const oldKeys = await a.transport.getUserKeys(BOB)
    await b.svc.revokeDevice(c.svc.self().deviceId, 'user')
    await ds.flush()
    expect((await a.svc.chainContextFor(BOB, false)).highestSeenDskGeneration).toBe(2)
    // The DS now serves the old generation 1 DSK again.
    ds.tamperKeys = (k) => (k.userId === BOB ? { ...k, deviceSigningKey: oldKeys.deviceSigningKey } : k)
    await a.svc.onGatewayEvent({ t: 'USER_KEYS_UPDATE', d: { userId: BOB, kind: 'dsk_rotated', deviceId: null } })
    expect(a.of('keyChange')).toEqual([{ userId: BOB, severity: 'notice' }])
    const ctx = await a.svc.chainContextFor(BOB, false)
    expect(ctx.currentDsk?.generation).toBe(1)
    expect(identity.verifyChain(b.svc.self().chain, ctx)).toEqual({ ok: false, reason: 'dsk_downgrade' })
  })

  it('lists only the contact devices whose chain verifies, and finds a device under its owner', async () => {
    const { dev: a } = await primary(ALICE)
    const { dev: b } = await primary(BOB, 'Bob')
    const c = await linkSas(b, 'Bob phone')
    const phone = c.svc.self().deviceId
    const names = async () => (await a.svc.listContactDevices(BOB)).map((d) => d.displayName).sort()
    expect(await names()).toEqual(['Bob', 'Bob phone'])
    expect((await a.svc.listContactDevices(BOB)).find((d) => d.displayName === 'Bob')).toMatchObject({ deviceId: b.svc.self().deviceId, dskGeneration: 1 })
    // Bob's phone under Alice's hint: found among the users this Worker already fetched.
    expect((await a.svc.deviceOwnerCertificate(phone, ALICE))?.userId).toBe(BOB)
    expect(await a.svc.deviceCertificate(ALICE, phone)).toBeNull()
    // A certificate whose signature does not verify is left out.
    ds.tamperKeys = (k) =>
      k.userId !== BOB
        ? k
        : {
            ...k,
            devices: k.devices.map((d) => {
              if (d.id !== phone || d.certificate === null) return d
              const bytes = fromB64url(d.certificate)
              bytes[bytes.length - 1]! ^= 1
              return { ...d, certificate: toB64url(bytes) }
            }),
          }
    await a.svc.onGatewayEvent({ t: 'USER_KEYS_UPDATE', d: { userId: BOB, kind: 'device_added', deviceId: phone } })
    expect(await names()).toEqual(['Bob'])
    ds.tamperKeys = null
    // A revoked device is left out.
    await b.svc.revokeDevice(phone, 'lost')
    await ds.flush()
    await a.svc.onGatewayEvent({ t: 'USER_KEYS_UPDATE', d: { userId: BOB, kind: 'device_revoked', deviceId: phone } })
    expect(await names()).toEqual(['Bob'])
  })

  it('lists own devices with the REST name and renames without re-certifying', async () => {
    const { dev: a } = await primary()
    const b = await linkSas(a, 'Phone')
    const id = b.svc.self().deviceId
    await a.svc.renameDevice(id, 'Work phone')
    const list = await a.svc.listDevices()
    expect(list.find((d) => d.id === id)).toMatchObject({ name: 'Work phone', current: false, primary: false, status: 'active' })
    expect(list.find((d) => d.current)).toMatchObject({ primary: true })
    expect((await a.svc.deviceCertificate(ALICE, id))?.displayName).toBe('Phone')
  })
})

describe('key packages', () => {
  it('replenishes on KEY_PACKAGES_LOW', async () => {
    const { dev: a } = await primary()
    const id = a.svc.self().deviceId
    ds.keyPackages.set(`${id}:1`, { count: 4, lastResort: true })
    await a.svc.onGatewayEvent({ t: 'KEY_PACKAGES_LOW', d: { deviceId: id, cipherSuite: 1, remaining: 4 } })
    expect(ds.keyPackages.get(`${id}:1`)).toEqual({ count: 100, lastResort: true })
    expect(a.keyPackageCalls.at(-1)).toEqual({ count: 96, lastResort: false, dskGeneration: 1 })
    expect((await a.store.list('keyPackages')).length).toBe(100 + 1 + 96)
  })
})

describe('key transparency', () => {
  it('proves fetched keys, self-checks and flags an unknown entry', async () => {
    ds.ktEnabled = true
    const { dev: a } = await primary(ALICE)
    const { dev: b } = await primary(BOB, 'Bob')
    ds.signHead()
    await ds.flush()
    expect(a.of('ktAlert')).toEqual([])
    expect(await a.svc.ktSelfCheck()).toMatchObject({ ok: true, unknownEntries: [] })
    // Bob's keys are proven against the head.
    await a.svc.chainContextFor(BOB, true)
    expect(a.of('ktAlert')).toEqual([])

    // The DS adds a DSK cert for Alice that her master did not sign.
    const rogueMaster = identity.createMasterKey(ALICE, 1, null)
    const rogue = identity.createDeviceSigningKey(rogueMaster, 9)
    const entry = kt.encodeEntry({ type: 2, userId: ALICE, timestampMs: ds.now, object: identity.encodeDskCert(rogue.cert) })
    ds.ktEntries.push({ index: ds.ktEntries.length, userId: ALICE, type: 2, entry, leaf: kt.leafHash(entry) })
    ds.signHead()
    await ds.flush()
    const alerts = a.of('ktAlert').filter((x) => x.kind === 'self_unknown_entry')
    expect(alerts.length).toBeGreaterThan(0)
    const r = await a.svc.ktSelfCheck()
    // The cursor moved: a second check reports only new entries.
    expect(r.ok).toBe(true)
    expect(b.of('ktAlert').filter((x) => x.kind === 'self_unknown_entry')).toEqual([])
  })

  it('fails closed on a key object that the log does not hold', async () => {
    ds.ktEnabled = true
    const { dev: a } = await primary(ALICE)
    await primary(BOB, 'Bob')
    ds.signHead()
    await ds.flush()
    ds.tamperKeys = (k) =>
      k.userId === BOB && k.masterKey ? { ...k, masterKey: { ...k.masterKey, ktEntry: toB64url(kt.encodeEntry({ type: 1, userId: BOB, timestampMs: 1, object: new Uint8Array([1]) })) } } : k
    await expect(a.svc.chainContextFor(BOB, true)).rejects.toMatchObject({ code: 'InvalidChain' })
    expect(a.of('ktAlert').map((x) => x.kind)).toContain('bad_proof')
    expect(await a.svc.treeHeadForGossip('g')).not.toBeNull()
    expect(await a.svc.treeHeadForGossip('g')).toBeNull()
  })
})

describe('key transparency required', () => {
  it('pins ktRequired and rejects a key object without a KT entry (kt_missing)', async () => {
    ds.ktEnabled = true
    const { dev: a } = await primary(ALICE)
    await primary(BOB, 'Bob')
    ds.signHead()
    await ds.flush()
    expect((await a.store.get('identity', 'self'))?.ktRequired).toBe(true)
    ds.tamperKeys = (k) => (k.userId === BOB && k.masterKey ? { ...k, masterKey: { ...k.masterKey, ktIndex: null, ktEntry: null } } : k)
    await expect(a.svc.chainContextFor(BOB, true)).rejects.toMatchObject({ code: 'InvalidChain' })
    expect(a.of('ktAlert').map((x) => x.kind)).toContain('kt_missing')
  })

  it('rejects a DSK cert without a KT entry before any head is stored', async () => {
    ds.ktEnabled = true
    const { dev: a } = await primary(ALICE)
    await primary(BOB, 'Bob')
    ds.tamperKeys = (k) =>
      k.userId === BOB ? { ...k, masterKey: k.masterKey && { ...k.masterKey, ktIndex: null, ktEntry: null }, deviceSigningKey: k.deviceSigningKey && { ...k.deviceSigningKey, ktIndex: null, ktEntry: null } } : k
    await expect(a.svc.chainContextFor(BOB, true)).rejects.toMatchObject({ code: 'InvalidChain' })
    expect(a.of('ktAlert').map((x) => x.kind)).toContain('kt_missing')
  })
})

describe('signed admin actions', () => {
  it('signs the genesis and the next action against the replayed head', async () => {
    const { dev: a } = await primary()
    const svc = createAdminService(
      { store: a.store, transport: a.transport, emit: () => undefined, now: () => ds.now, random: () => new Uint8Array(), origin: '', platform: 'electron', clientVersion: '1.0.0' },
      a.svc,
      testPermissions,
    )
    expect(await a.svc.adminState(GUILD)).toBeNull()
    expect(await svc.adminGuildPermissions(GUILD, ALICE)).toBeNull()
    await expect(svc.signAdminAction(GUILD, 1, admin.encodePayload({ type: 1, roleId: GUILD, permissions: 0, position: 1 }))).rejects.toMatchObject({ code: 'Unsupported' })
    const g = await svc.signAdminAction(GUILD, 0, admin.encodePayload({ type: 0, ownerId: ALICE }))
    expect(g.seq).toBe(0)
    ds.storeAdminAction(GUILD, g.header)
    const role = '66666666-6666-4666-8666-666666666666'
    const next = await svc.signAdminAction(GUILD, 1, admin.encodePayload({ type: 1, roleId: role, permissions: 1024, position: 1 }))
    expect(next.seq).toBe(1)
    const decoded = admin.decodeAction(fromB64url(next.header))
    expect(decoded.prevHash).toEqual(admin.hash(admin.decodeAction(fromB64url(g.header))))
    expect(admin.verify(decoded, a.svc.self().chain.device)).toBe(true)
    ds.storeAdminAction(GUILD, next.header)
    const st = await a.svc.adminState(GUILD)
    expect(st?.seq).toBe(1)
    expect(st?.roles.map((r) => r.id)).toContain(role)
    expect((await a.store.get('adminState', GUILD))?.seq).toBe(1)
    expect(await svc.adminGuildPermissions(GUILD, ALICE)).toBe(0x7fffffff)
    expect(await svc.adminGuildPermissions(GUILD, BOB)).toBe(DEFAULT_EVERYONE_PERMISSIONS)
    await expect(svc.signAdminAction(GUILD, 3, new Uint8Array([1]))).rejects.toMatchObject({ code: 'Malformed' })
  })

  it('rejects a chain with a forged action', async () => {
    const { dev: a } = await primary()
    const svc = createAdminService({ store: a.store, transport: a.transport, emit: () => undefined, now: () => ds.now, random: () => new Uint8Array(), origin: '', platform: 'electron', clientVersion: '1.0.0' }, a.svc, testPermissions)
    const g = await svc.signAdminAction(GUILD, 0, admin.encodePayload({ type: 0, ownerId: ALICE }))
    const forged = admin.decodeAction(fromB64url(g.header))
    ds.storeAdminAction(GUILD, toB64url(admin.encodeAction({ ...forged, timestampMs: forged.timestampMs + 1 })))
    await expect(a.svc.adminState(GUILD)).rejects.toMatchObject({ code: 'Malformed' } satisfies Partial<CryptoErrorShape>)
  })
})

describe('key changes, revocation of this device, recovery key rotation', () => {
  it('keeps the old pin on a key change until a new verification', async () => {
    const { dev: a } = await primary(ALICE)
    const { dev: bob } = await primary(BOB, 'Bob desktop')
    await bob.svc.setVerified(ALICE, true)
    const oldChain = a.svc.self().chain
    ds.passwordReset(ALICE)
    const n = await makeDevice(ds, ALICE, 'After reset')
    await n.svc.resetIdentity()
    await ds.flush()
    expect(bob.of('keyChange')).toEqual([{ userId: ALICE, severity: 'blocking' }])
    // The DS serves the new master, but the pin stays: no chain of the user passes.
    const before = await bob.svc.chainContextFor(ALICE, true)
    expect(before.pinnedMaster).toEqual({ publicKey: oldChain.master.publicKey, generation: oldChain.master.generation })
    expect(before.currentDsk).toBeNull()
    expect(identity.verifyChain(n.svc.self().chain, before)).toEqual({ ok: false, reason: 'master_changed' })
    expect(await bob.svc.listContactDevices(ALICE)).toEqual([])
    expect(await bob.svc.trustOf(ALICE)).toBe('changed')
    // A second fetch of the same candidate raises no second alert.
    await bob.svc.onGatewayEvent({ t: 'USER_KEYS_UPDATE', d: { userId: ALICE, kind: 'master_key_changed', deviceId: null } })
    expect(bob.of('keyChange')).toHaveLength(1)
    // setVerified(false) does not end a pending change.
    expect((await bob.svc.setVerified(ALICE, false)).state).toBe('changed')
    // Re-verification by QR code accepts the new master key.
    const qr = (await n.svc.getSafetyNumber(BOB)).qrPayload
    expect(await bob.svc.verifyQr(qr)).toEqual({ userId: ALICE, match: true })
    expect((await bob.svc.getTrust(ALICE)).state).toBe('verified')
    const after = await bob.svc.chainContextFor(ALICE, true)
    expect(identity.verifyChain(n.svc.self().chain, after)).toEqual({ ok: true, firstSight: false })
    expect(identity.verifyChain(oldChain, after)).toEqual({ ok: false, reason: 'master_changed' })
  })

  it('acknowledgeKeyChange moves the pin to the candidate', async () => {
    await primary(ALICE)
    const { dev: bob } = await primary(BOB, 'Bob desktop')
    await bob.svc.getTrust(ALICE)
    ds.passwordReset(ALICE)
    const n = await makeDevice(ds, ALICE, 'After reset')
    await n.svc.resetIdentity()
    await ds.flush()
    expect(bob.of('keyChange')).toEqual([{ userId: ALICE, severity: 'notice' }])
    expect(identity.verifyChain(n.svc.self().chain, await bob.svc.chainContextFor(ALICE, true)).ok).toBe(false)
    await bob.svc.acknowledgeKeyChange(ALICE)
    expect(identity.verifyChain(n.svc.self().chain, await bob.svc.chainContextFor(ALICE, true)).ok).toBe(true)
    expect((await bob.svc.listContactDevices(ALICE)).map((d) => d.displayName)).toEqual(['After reset'])
  })

  it('a pending device that another device removed starts over at the next start', async () => {
    await primary(ALICE)
    const b = await makeDevice(ds, ALICE, 'Phone')
    await b.svc.linkAsNewDevice('sas')
    const oldId = b.svc.status().deviceId!
    ds.devices.get(oldId)!.status = 'revoked' // removed in the devices panel while the app was closed
    const again = await makeDevice(ds, ALICE, 'Phone', b.store)
    // Locked, with no status event: the UI must not take it for a revocation while running.
    expect(again.of('status')).toEqual([])
    expect(again.svc.status().state).toBe('revoked')
    // The UI wipes a revoked start, and the next start links as a new device.
    await again.svc.signOutDevice()
    const fresh = await makeDevice(ds, ALICE, 'Phone', b.store)
    expect(fresh.svc.status()).toMatchObject({ state: 'needs_identity', deviceId: null })
    await fresh.svc.linkAsNewDevice('sas')
    expect(fresh.svc.status().state).toBe('linking')
    expect(fresh.svc.status().deviceId).not.toBe(oldId)
  })

  it('a half-linked device (certified on the DS, the transfer lost) starts over at the next start', async () => {
    const { dev: a } = await primary(ALICE)
    const b = await makeDevice(ds, ALICE, 'Phone')
    const { sessionId } = await b.svc.linkAsNewDevice('sas')
    const oldId = b.svc.status().deviceId!
    await ds.flush()
    await a.svc.linkAccept(sessionId)
    await ds.flush()
    // The certificate PUT goes through, then the transfer is lost.
    const put = a.transport.putDeviceCertificate.bind(a.transport)
    const post = a.transport.postLinkMessage.bind(a.transport)
    let certified = false
    a.transport.putDeviceCertificate = (id, body) => put(id, body).then((d) => ((certified = true), d))
    a.transport.postLinkMessage = (id, body) => (certified ? Promise.reject(new Error('network')) : post(id, body))
    await expect(a.svc.linkConfirmSas(sessionId, true)).rejects.toThrow('network')
    await ds.flush()
    expect(ds.devices.get(oldId)!.status).toBe('active')
    const again = await makeDevice(ds, ALICE, 'Phone', b.store)
    expect(again.of('status')).toEqual([])
    expect(again.svc.status().state).toBe('revoked')
    // The wipe signs the device out on the DS too: no active device that nobody holds.
    again.transport.deviceId = oldId // the device proof of the restarted store
    await again.svc.signOutDevice()
    expect(ds.devices.get(oldId)).toMatchObject({ status: 'revoked', revokeReason: 'signed_out' })
    const fresh = await makeDevice(ds, ALICE, 'Phone', b.store)
    expect(fresh.svc.status()).toMatchObject({ state: 'needs_identity', deviceId: null })
    await fresh.svc.linkAsNewDevice('sas')
    expect(fresh.svc.status().deviceId).not.toBe(oldId)
  })

  it('a set-up device revoked while the app was closed starts locked, quietly, until the wipe', async () => {
    const { dev: a } = await primary(ALICE)
    const id = a.svc.status().deviceId!
    ds.devices.get(id)!.status = 'revoked'
    const again = await makeDevice(ds, ALICE, 'Desktop', a.store)
    expect(again.of('status')).toEqual([])
    expect(again.svc.status().state).toBe('revoked')
    expect((await a.store.get('identity', 'self'))?.lockedAtMs).toBe(ds.now)
    await again.svc.signOutDevice()
    expect(await a.store.get('identity', 'self')).toBeUndefined()
  })

  it('locks the device on an unsigned server revocation and keeps the store until an explicit wipe', async () => {
    const { dev: a } = await primary(ALICE)
    ds.passwordReset(ALICE)
    await a.svc.onGatewayEvent({ t: 'USER_KEYS_UPDATE', d: { userId: ALICE, kind: 'device_revoked', deviceId: a.svc.status().deviceId! } })
    expect(a.svc.status().state).toBe('revoked')
    const row = await a.store.get('identity', 'self')
    expect(row?.master?.privateKey).not.toBeNull()
    expect(row?.lockedAtMs).toBe(ds.now)
    // A restart keeps the lock.
    const again = await makeDevice(ds, ALICE, 'Desktop', a.store)
    expect(again.svc.status().state).toBe('revoked')
    await again.svc.signOutDevice()
    expect(await again.store.get('identity', 'self')).toBeUndefined()
  })

  it('erases the store on a master-signed revocation', async () => {
    const { dev: a } = await primary(ALICE)
    const b = await linkSas(a, 'Phone')
    const id = b.svc.self().deviceId
    await a.svc.revokeDevice(id, 'lost')
    await ds.flush()
    // The DS sends no event to a revoked device: the event as the gateway would have sent it.
    await b.svc.onGatewayEvent({ t: 'USER_KEYS_UPDATE', d: { userId: ALICE, kind: 'device_revoked', deviceId: id } })
    expect(b.of('error')).toEqual([])
    expect(b.svc.status().state).toBe('revoked')
    expect(await b.store.get('identity', 'self')).toBeUndefined()
  })

  it('continues a failed recovery key rotation with the same key', async () => {
    const { dev: a, recoveryKey } = await primary()
    const g = new Uint8Array(22).fill(4)
    await a.store.put('epochSecrets', secretKey(g, 0), { groupId: g, epoch: 0, secret: new Uint8Array(32).fill(1), backedUp: false })
    const post = a.transport.postHistoryBackup.bind(a.transport)
    a.transport.postHistoryBackup = () => Promise.reject(new Error('network'))
    await expect(a.svc.rotateRecoveryKey()).rejects.toThrow('network')
    const pending = (await a.store.get('identity', 'self'))?.pendingRecoveryKey
    expect(typeof pending).toBe('string')
    // No upload under the old key while the rotation is open.
    expect(await a.svc.backupNow()).toEqual({ uploaded: 0 })
    a.transport.postHistoryBackup = post
    const { recoveryKey: next } = await a.svc.rotateRecoveryKey()
    expect(next).toBe(pending)
    expect(next).not.toBe(recoveryKey)
    expect((await a.store.get('identity', 'self'))?.pendingRecoveryKey).toBeNull()
    const n = await makeDevice(ds, ALICE, 'New')
    await n.svc.restoreFromRecoveryKey(next)
    expect((await n.store.list('epochSecrets')).map((s) => s.value.epoch)).toEqual([0])
  })
})
