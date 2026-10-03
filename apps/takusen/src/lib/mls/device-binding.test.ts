/**
 * Device binding (device-binding.ts): a bearer token claims only the device
 * of its OIDC grant, and a revoked device's grants are deleted.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { ApiError } from '@/lib/errors'

import { requireDeviceWith, type DeviceCredential } from './device-auth'
import { InMemoryDeviceBindings, revokeDeviceGrants } from './device-binding'
import { Outbox } from './events'
import { registerDevice } from './identity'
import { revokeDevicesWith } from './membership'
import { InMemoryMlsRepo } from './repo.in-memory'

const notActive = (err: unknown) => err instanceof ApiError && err.code === 'DeviceNotActive' && err.status === 403

async function setup() {
  const repo = new InMemoryMlsRepo()
  const alice = repo.addUser()
  const reg = async (name: string, status: 'pending' | 'active') => {
    const wire = await registerDevice(repo, alice, { name, platform: 'electron', clientVersion: '1.0.0' })
    if (status === 'active') await repo.updateDevice(wire.id, { status: 'active' })
    return wire.id
  }
  const bindings = new InMemoryDeviceBindings()
  const as = (grantId: string): DeviceCredential => ({ bindings, grantId })
  return { repo, alice, reg, bindings, as }
}

describe('device binding', () => {
  test('the first device of a grant binds it; the grant cannot claim another active device', async () => {
    const { repo, alice, reg, bindings, as } = await setup()
    const laptop = await reg('laptop', 'active')
    const phone = await reg('phone', 'active')
    assert.equal((await requireDeviceWith(repo, laptop, alice, {}, new Date(), as('g-laptop'))).id, laptop)
    assert.equal((await requireDeviceWith(repo, phone, alice, {}, new Date(), as('g-phone'))).id, phone)
    // A stolen laptop token names the phone.
    await assert.rejects(requireDeviceWith(repo, phone, alice, {}, new Date(), as('g-laptop')), notActive)
    assert.equal(bindings.byGrant.get('g-laptop'), laptop)
    // The bound device still works.
    assert.equal((await requireDeviceWith(repo, laptop, alice, {}, new Date(), as('g-laptop'))).id, laptop)
  })

  test('a grant of a pending device never claims an active device', async () => {
    const { repo, alice, reg, as } = await setup()
    const phone = await reg('phone', 'active')
    const fresh = await reg('fresh', 'pending')
    await requireDeviceWith(repo, fresh, alice, { allowPending: true }, new Date(), as('g-fresh'))
    await assert.rejects(requireDeviceWith(repo, phone, alice, {}, new Date(), as('g-fresh')), notActive)
  })

  test('a grant whose device is not active moves to a new pending device', async () => {
    const { repo, alice, reg, bindings, as } = await setup()
    const first = await reg('first try', 'pending')
    await requireDeviceWith(repo, first, alice, { allowPending: true }, new Date(), as('g'))
    const second = await reg('second try', 'pending')
    assert.equal((await requireDeviceWith(repo, second, alice, { allowPending: true }, new Date(), as('g'))).id, second)
    assert.equal(bindings.byGrant.get('g'), second)
  })

  test('a grant of an active device cannot move to a pending device', async () => {
    const { repo, alice, reg, as } = await setup()
    const laptop = await reg('laptop', 'active')
    await requireDeviceWith(repo, laptop, alice, {}, new Date(), as('g'))
    const rogue = await reg('rogue', 'pending')
    await assert.rejects(requireDeviceWith(repo, rogue, alice, { allowPending: true }, new Date(), as('g')), notActive)
  })

  test('a cookie session (no grant) is not bound', async () => {
    const { repo, alice, reg, bindings } = await setup()
    const laptop = await reg('laptop', 'active')
    assert.equal((await requireDeviceWith(repo, laptop, alice, {}, new Date(), { bindings, grantId: null })).id, laptop)
    assert.equal(bindings.byGrant.size, 0)
  })

  test('revoking a device deletes the grants bound to it, and only those', async () => {
    const { repo, alice, reg, bindings, as } = await setup()
    const lost = await reg('lost', 'active')
    const kept = await reg('kept', 'active')
    await requireDeviceWith(repo, lost, alice, {}, new Date(), as('g-lost'))
    await requireDeviceWith(repo, kept, alice, {}, new Date(), as('g-kept'))

    const out = new Outbox()
    await revokeDevicesWith(repo, out, { userId: alice, devices: [lost], reason: 'lost', now: new Date() })
    assert.deepEqual([...out.revokedDevices], [lost])

    const deleted: string[] = []
    await revokeDeviceGrants(bindings, async (ids) => deleted.push(...ids), out.revokedDevices)
    assert.deepEqual(deleted, ['g-lost'])
    assert.equal(bindings.byGrant.has('g-lost'), false)
    assert.equal(bindings.byGrant.get('g-kept'), kept)
    await assert.rejects(requireDeviceWith(repo, lost, alice, {}, new Date(), as('g-lost')), notActive)
  })
})
