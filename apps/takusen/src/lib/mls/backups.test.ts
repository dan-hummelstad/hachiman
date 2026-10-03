/**
 * Restore with the recovery key runs on a pending device: GET /backups,
 * GET /backups/:id and PUT /users/@me/device-signing-key come before
 * PUT /devices/:id/certificate (§12.11.3, §12.12).
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { ApiError } from '@/lib/errors'

import { getBackup, backupIndex } from './device-data'
import { requireDeviceWith } from './device-auth'
import { registerDevice } from './identity'
import { InMemoryMlsRepo } from './repo.in-memory'

const API = join(import.meta.dirname, '../../app/api/v1')

function routeMode(file: string, method: string): string | null {
  const src = readFileSync(join(API, file), 'utf8')
  const m = new RegExp(`export const ${method} = dsRoute(?:<[^>]*>)?\\('(\\w+)'`).exec(src)
  return m ? m[1]! : null
}

describe('backups on a pending device', () => {
  test('the restore routes allow pending devices; the backup mutations do not', () => {
    assert.equal(routeMode('backups/route.ts', 'GET'), 'pending')
    assert.equal(routeMode('backups/[id]/route.ts', 'GET'), 'pending')
    assert.equal(routeMode('users/[id]/device-signing-key/route.ts', 'PUT'), 'pending')
    assert.equal(routeMode('users/[id]/master-key/route.ts', 'PUT'), 'pending')
    assert.equal(routeMode('backups/route.ts', 'DELETE'), 'active')
    assert.equal(routeMode('backups/identity/route.ts', 'PUT'), 'active')
    assert.equal(routeMode('backups/history/route.ts', 'POST'), 'active')
  })

  test('a pending device lists and fetches its own backups, not the backups of another user', async () => {
    const repo = new InMemoryMlsRepo()
    const alice = repo.addUser()
    const bob = repo.addUser()
    const keyId = new Uint8Array(randomBytes(16))
    const blob = new Uint8Array(randomBytes(64))
    await repo.putIdentityBackup({ userId: alice, keyId, kind: 'identity', groupId: null, epochFrom: null, epochTo: null, blob, size: blob.length })
    const bobBlob = new Uint8Array(randomBytes(32))
    const bobBackup = await repo.insertBackup({ userId: bob, keyId, kind: 'identity', groupId: null, epochFrom: null, epochTo: null, blob: bobBlob, size: bobBlob.length })

    const wire = await registerDevice(repo, alice, { name: 'New laptop', platform: 'electron', clientVersion: '1.0.0' })
    const device = await requireDeviceWith(repo, wire.id, alice, { allowPending: true })
    assert.equal(device.status, 'pending')

    const index = await backupIndex(repo, device.userId)
    assert.equal(index.items.length, 1)
    assert.equal(index.items[0]!.kind, 'identity')
    const got = await getBackup(repo, device.userId, index.items[0]!.id)
    assert.deepEqual(Buffer.from(got.blob, 'base64url'), Buffer.from(blob))

    await assert.rejects(getBackup(repo, device.userId, bobBackup), (err) => err instanceof ApiError && err.code === 'NotFound')
    // Bob's id in the device header does not authenticate as Bob's device either.
    await assert.rejects(requireDeviceWith(repo, wire.id, bob, { allowPending: true }), (err) => err instanceof ApiError && err.code === 'DeviceNotActive')
  })
})
