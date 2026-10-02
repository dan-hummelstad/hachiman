/**
 * Devices, keys, revocation and password reset (docs/gateway-protocol.md
 * §12.4, §12.12) with real master keys, DSK certs, device certificates and
 * revocations from @hachiman/crypto.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, test } from 'node:test'

import { identity } from '../../../../../pkgs/hachiman-crypto/src/identity/index'
import { generateEd25519 } from '../../../../../pkgs/hachiman-crypto/src/sign'

import { ApiError } from '@/lib/errors'
import { setBusPublisher } from '@/lib/events'

import { uuidToBytes } from './bytes'
import { DeviceRevocationReason, KtEntryType } from './crypto'
import { createLinkSession } from './device-data'
import { Outbox } from './events'
import { encodeForTests } from './wire-format'
import { putCertificate, putDeviceSigningKey, putMasterKey, registerDevice, revokeDevice, userKeys } from './identity'
import { uploadKeyPackages } from './key-packages'
import { onMembershipChangeWith } from './membership'
import type { DeviceRow } from './repo'
import { activate, fakeKeyPackage, newWorld, runBatchAndCommit, type World } from './testing'

setBusPublisher(async () => undefined)

async function rejects(p: Promise<unknown>, code: string): Promise<ApiError> {
  try {
    await p
  } catch (err) {
    assert.ok(err instanceof ApiError, String(err))
    assert.equal(err.code, code, err.message)
    return err
  }
  assert.fail(`expected ${code}`)
}

interface Identity {
  userId: string
  master: ReturnType<typeof identity.createMasterKey>
  dsk: ReturnType<typeof identity.createDeviceSigningKey>
}

interface Dev {
  row: DeviceRow
  mls: { publicKey: Uint8Array; privateKey: Uint8Array }
}

async function firstDevice(w: World, out = new Outbox()): Promise<{ id: Identity; dev: Dev }> {
  const userId = w.repo.addUser()
  const master = identity.createMasterKey(userId, 1, null)
  const dsk = identity.createDeviceSigningKey(master, 1)
  const wire = await registerDevice(w.repo, userId, { name: 'Laptop', platform: 'electron', clientVersion: '1.0.0' })
  const row = (await w.repo.getDevice(wire.id))!
  await putMasterKey(w.repo, w.deps, out, userId, { record: identity.encodeMasterKeyRecord(master.record), dskCert: identity.encodeDskCert(dsk.cert) })
  const id = { userId, master, dsk }
  const dev = await certify(w, id, row, row, out)
  return { id, dev }
}

async function certify(w: World, id: Identity, caller: DeviceRow, target: DeviceRow, out = new Outbox()): Promise<Dev> {
  const mls = generateEd25519()
  const cert = identity.certifyDevice(id.dsk, { deviceId: target.id, mlsSignatureKey: mls.publicKey, hpkeKey: new Uint8Array(randomBytes(32)), issuedAtMs: w.clock.now, displayName: 'Laptop' })
  await putCertificate(w.repo, w.deps, out, { userId: id.userId, device: caller }, target.id, identity.encodeDeviceCertificate(cert))
  return { row: (await w.repo.getDevice(target.id))!, mls }
}

async function secondDevice(w: World, id: Identity, by: Dev): Promise<Dev> {
  const wire = await registerDevice(w.repo, id.userId, { name: 'Phone', platform: 'browser', clientVersion: '1.0.0' })
  return certify(w, id, by.row, (await w.repo.getDevice(wire.id))!)
}

describe('devices and keys (§12.12)', () => {
  test('the first device self-certifies; each key change appends a KT entry; UserKeys carries ktEntry', async () => {
    const w = await newWorld()
    const out = new Outbox()
    const { id, dev } = await firstDevice(w, out)
    assert.equal(dev.row.status, 'active')
    assert.ok(out.events.some((e) => e.t === 'USER_KEYS_UPDATE' && (e.d as { kind: string }).kind === 'device_added'))
    const keys = await userKeys(w.repo, w.deps, id.userId, id.userId)
    assert.equal(keys.masterKey!.ktIndex, 0)
    assert.equal(keys.deviceSigningKey!.ktIndex, 1)
    assert.equal(keys.devices[0]!.ktIndex, 2)
    const entry = w.ds.kt.decodeEntry(Buffer.from(keys.devices[0]!.ktEntry!, 'base64url'))
    assert.equal(entry.type, KtEntryType.DEVICE_CERTIFICATE)
    assert.deepEqual(new Uint8Array(entry.object), dev.row.certificate)
  })

  test('another active device certifies a new device; a superseded DSK gives 409', async () => {
    const w = await newWorld()
    const { id, dev } = await firstDevice(w)
    const phone = await secondDevice(w, id, dev)
    assert.equal(phone.row.status, 'active')

    const dsk2 = identity.createDeviceSigningKey(id.master, 2)
    await putDeviceSigningKey(w.repo, w.deps, new Outbox(), id.userId, identity.encodeDskCert(dsk2.cert))
    const wire = await registerDevice(w.repo, id.userId, { name: 'Tablet', platform: 'browser', clientVersion: '1.0.0' })
    const tablet = (await w.repo.getDevice(wire.id))!
    await rejects(certify(w, id, dev.row, tablet), 'StaleDeviceSigningKey')
    await certify(w, { ...id, dsk: dsk2 }, dev.row, tablet)
  })

  test('with an open link session, the certificate must carry the keys of the offer', async () => {
    const w = await newWorld()
    const { id, dev } = await firstDevice(w)
    const wire = await registerDevice(w.repo, id.userId, { name: 'Phone', platform: 'browser', clientVersion: '1.0.0' })
    const fresh = (await w.repo.getDevice(wire.id))!
    const mls = generateEd25519()
    const hpke = new Uint8Array(randomBytes(32))
    const offer = encodeForTests.linkOffer({ userId: uuidToBytes(id.userId), deviceId: uuidToBytes(fresh.id), mlsSignatureKey: mls.publicKey, hpkeKey: hpke })
    await createLinkSession(w.repo, new Outbox(), { userId: id.userId, device: fresh }, offer, new Date(w.clock.now))
    const other = identity.certifyDevice(id.dsk, { deviceId: fresh.id, mlsSignatureKey: generateEd25519().publicKey, hpkeKey: hpke, issuedAtMs: w.clock.now, displayName: 'Phone' })
    await rejects(putCertificate(w.repo, w.deps, new Outbox(), { userId: id.userId, device: dev.row }, fresh.id, identity.encodeDeviceCertificate(other)), 'InvalidCertificate')
    const right = identity.certifyDevice(id.dsk, { deviceId: fresh.id, mlsSignatureKey: mls.publicKey, hpkeKey: hpke, issuedAtMs: w.clock.now, displayName: 'Phone' })
    const done = await putCertificate(w.repo, w.deps, new Outbox(), { userId: id.userId, device: dev.row }, fresh.id, identity.encodeDeviceCertificate(right))
    assert.equal(done.status, 'active')
    // A pending device cannot certify another device.
    const wire2 = await registerDevice(w.repo, id.userId, { name: 'X', platform: 'browser', clientVersion: '1.0.0' })
    const pending = (await w.repo.getDevice(wire2.id))!
    await rejects(putCertificate(w.repo, w.deps, new Outbox(), { userId: id.userId, device: pending }, fresh.id, identity.encodeDeviceCertificate(right)), 'DeviceNotActive')
  })

  test('PUT device-signing-key deletes the lower-generation key packages and sends KEY_PACKAGES_LOW 0', async () => {
    const w = await newWorld()
    const { id, dev } = await firstDevice(w)
    await uploadKeyPackages(w.repo, w.deps, dev.row, { cipherSuite: 1, keyPackages: [fakeKeyPackage(dev.row), fakeKeyPackage(dev.row)], lastResort: fakeKeyPackage(dev.row) })
    const out = new Outbox()
    await rejects(putDeviceSigningKey(w.repo, w.deps, out, id.userId, identity.encodeDskCert(identity.createDeviceSigningKey(id.master, 3).cert)), 'StaleDeviceSigningKey')
    await putDeviceSigningKey(w.repo, w.deps, out, id.userId, identity.encodeDskCert(identity.createDeviceSigningKey(id.master, 2).cert))
    assert.deepEqual(await w.repo.countKeyPackages(dev.row.id), [])
    const low = out.events.filter((e) => e.t === 'KEY_PACKAGES_LOW')
    assert.deepEqual(low.map((e) => e.d), [{ deviceId: dev.row.id, cipherSuite: 1, remaining: 0 }])
    assert.ok(out.events.some((e) => e.t === 'USER_KEYS_UPDATE' && (e.d as { kind: string }).kind === 'dsk_rotated'))
  })

  test('PUT master-key: rotation needs prev_signature; a bearer token alone cannot replace a current master', async () => {
    const w = await newWorld()
    const { id } = await firstDevice(w)
    const out = new Outbox()
    const fresh = identity.createMasterKey(id.userId, 2, null)
    const freshDsk = identity.createDeviceSigningKey(fresh, 2)
    await rejects(putMasterKey(w.repo, w.deps, out, id.userId, { record: identity.encodeMasterKeyRecord(fresh.record), dskCert: identity.encodeDskCert(freshDsk.cert) }), 'MasterKeyExists')
    const rotated = identity.createMasterKey(id.userId, 2, id.master.keyPair)
    const rotatedDsk = identity.createDeviceSigningKey(rotated, 2)
    await putMasterKey(w.repo, w.deps, out, id.userId, { record: identity.encodeMasterKeyRecord(rotated.record), dskCert: identity.encodeDskCert(rotatedDsk.cert) })
    const keys = await userKeys(w.repo, w.deps, id.userId, id.userId)
    assert.equal(keys.masterKey!.generation, 2)
    assert.equal(keys.deviceSigningKey!.generation, 2)
  })
})

describe('revocation (§12.4)', () => {
  async function inGroup(w: World) {
    const { id, dev } = await firstDevice(w)
    const phone = await secondDevice(w, id, dev)
    w.presence.online.add(dev.row.id)
    w.presence.online.add(phone.row.id)
    const other = w.repo.addUser()
    const dm = w.repo.addDm([id.userId, other])
    const out = new Outbox()
    for (const d of [phone.row]) await uploadKeyPackages(w.repo, w.deps, d, { cipherSuite: 1, keyPackages: [fakeKeyPackage(d)], lastResort: null })
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'dm_created', channelId: dm }, dev.row.id))
    const group = await activate(w, out, (await w.repo.listGroupsByChannel(dm))[0]!, dev.row)
    await runBatchAndCommit(w, group.groupId)
    assert.ok(await w.repo.memberByDevice(group.groupId, phone.row.id))
    return { id, dev, phone, group }
  }

  test('a master-signed revocation queues Removes in every group and closes the device', async () => {
    const w = await newWorld()
    const { id, dev, phone, group } = await inGroup(w)
    const rev = identity.revoke(id.master, phone.row.id, DeviceRevocationReason.LOST, w.clock.now)
    const out = new Outbox()
    await revokeDevice(w.repo, w.deps, out, { userId: id.userId, device: dev.row }, phone.row.id, { revocation: identity.encodeRevocation(rev), reason: 'lost' })
    assert.equal((await w.repo.getDevice(phone.row.id))!.status, 'revoked')
    const leaf = (await w.repo.memberByDevice(group.groupId, phone.row.id))!.leafIndex
    const removes = await w.repo.listPending(group.groupId, ['queued'])
    assert.deepEqual(removes.map((p) => [p.op, p.leafIndex]), [['remove', leaf]])
    assert.ok(out.events.some((e) => e.t === 'DEVICE_REVOKED' && e.channel === `device:${phone.row.id}`))
    assert.ok(out.events.some((e) => e.t === 'USER_KEYS_UPDATE' && (e.d as { kind: string }).kind === 'device_revoked'))
    const keys = await userKeys(w.repo, w.deps, id.userId, id.userId)
    const d = keys.devices.find((x) => x.id === phone.row.id)!
    assert.equal(d.status, 'revoked')
    assert.notEqual(d.revocationKtIndex, null)
  })

  test('a revocation signed by the wrong key is rejected', async () => {
    const w = await newWorld()
    const { id, dev, phone } = await inGroup(w)
    const forged = identity.revoke({ record: id.master.record, keyPair: generateEd25519() }, phone.row.id, DeviceRevocationReason.USER, w.clock.now)
    await rejects(revokeDevice(w.repo, w.deps, new Outbox(), { userId: id.userId, device: dev.row }, phone.row.id, { revocation: identity.encodeRevocation(forged), reason: 'user' }), 'InvalidRevocation')
    await rejects(revokeDevice(w.repo, w.deps, new Outbox(), { userId: id.userId, device: dev.row }, phone.row.id, { revocation: null, reason: 'user' }), 'InvalidRevocation')
  })

  test('signed_out needs the device signature, and only for the caller device', async () => {
    const w = await newWorld()
    const { id, dev, phone } = await inGroup(w)
    // A signed_out revocation signed by the master key instead of the device key.
    const byMaster = identity.signOut({ userId: id.userId, deviceId: phone.row.id, masterGeneration: 1, mlsSignatureKey: id.master.keyPair }, w.clock.now)
    assert.equal(byMaster.reason, DeviceRevocationReason.SIGNED_OUT)
    await rejects(revokeDevice(w.repo, w.deps, new Outbox(), { userId: id.userId, device: phone.row }, phone.row.id, { revocation: identity.encodeRevocation(byMaster), reason: 'signed_out' }), 'InvalidRevocation')
    const own = identity.signOut({ userId: id.userId, deviceId: phone.row.id, masterGeneration: 1, mlsSignatureKey: { publicKey: phone.mls.publicKey, privateKey: phone.mls.privateKey } }, w.clock.now)
    await rejects(revokeDevice(w.repo, w.deps, new Outbox(), { userId: id.userId, device: dev.row }, phone.row.id, { revocation: identity.encodeRevocation(own), reason: 'signed_out' }), 'InvalidRevocation')
    await revokeDevice(w.repo, w.deps, new Outbox(), { userId: id.userId, device: phone.row }, phone.row.id, { revocation: identity.encodeRevocation(own), reason: 'signed_out' })
    assert.equal((await w.repo.getDevice(phone.row.id))!.status, 'revoked')
  })

  test('a pending device signs itself out with revocation null', async () => {
    const w = await newWorld()
    const { id } = await firstDevice(w)
    const wire = await registerDevice(w.repo, id.userId, { name: 'New', platform: 'browser', clientVersion: '1.0.0' })
    const pending = (await w.repo.getDevice(wire.id))!
    await revokeDevice(w.repo, w.deps, new Outbox(), { userId: id.userId, device: pending }, pending.id, { revocation: null, reason: 'signed_out' })
    assert.equal((await w.repo.getDevice(pending.id))!.status, 'revoked')
  })
})

describe('password reset (§12.4)', () => {
  test('revokes all devices and supersedes the master; a restore or a new generation succeeds', async () => {
    const w = await newWorld()
    const { id, dev } = await firstDevice(w)
    const phone = await secondDevice(w, id, dev)
    const out = new Outbox()
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'devices_revoked', userId: id.userId, deviceIds: 'all', reason: 'password_reset' }, null))
    for (const d of [dev.row, phone.row]) assert.equal((await w.repo.getDevice(d.id))!.status, 'revoked')
    assert.equal(out.events.filter((e) => e.t === 'DEVICE_REVOKED').length, 2)
    assert.equal((await userKeys(w.repo, w.deps, id.userId, id.userId)).masterKey, null)

    // A record that is neither the newest superseded one nor generation + 1 without prev_signature: 409.
    const wrongGen = identity.createMasterKey(id.userId, 5, null)
    await rejects(putMasterKey(w.repo, w.deps, out, id.userId, { record: identity.encodeMasterKeyRecord(wrongGen.record), dskCert: identity.encodeDskCert(identity.createDeviceSigningKey(wrongGen, 2).cert) }), 'MasterKeyExists')

    // Restore from the recovery key: the same record, the same DSK.
    await putMasterKey(w.repo, w.deps, out, id.userId, { record: identity.encodeMasterKeyRecord(id.master.record), dskCert: identity.encodeDskCert(id.dsk.cert) })
    assert.equal((await userKeys(w.repo, w.deps, id.userId, id.userId)).masterKey!.generation, 1)
  })

  test('without the recovery key: a new master key, generation + 1 and no prev_signature', async () => {
    const w = await newWorld()
    const { id } = await firstDevice(w)
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, new Outbox(), { kind: 'devices_revoked', userId: id.userId, deviceIds: 'all', reason: 'password_reset' }, null))
    const fresh = identity.createMasterKey(id.userId, 2, null)
    const freshDsk = identity.createDeviceSigningKey(fresh, 2)
    await putMasterKey(w.repo, w.deps, new Outbox(), id.userId, { record: identity.encodeMasterKeyRecord(fresh.record), dskCert: identity.encodeDskCert(freshDsk.cert) })
    const keys = await userKeys(w.repo, w.deps, id.userId, id.userId)
    assert.equal(keys.masterKey!.generation, 2)
    assert.equal(keys.deviceSigningKey!.generation, 2)
    // The new device self-certifies under the new DSK.
    const wire = await registerDevice(w.repo, id.userId, { name: 'Again', platform: 'browser', clientVersion: '1.0.0' })
    const row = (await w.repo.getDevice(wire.id))!
    const d = await certify(w, { userId: id.userId, master: fresh, dsk: freshDsk }, row, row)
    assert.equal(d.row.status, 'active')
  })
})
