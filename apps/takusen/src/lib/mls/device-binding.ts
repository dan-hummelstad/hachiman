/**
 * Binds each OIDC grant to one device (§12.12 "Device binding").
 *
 * `X-Hachiman-Device` alone is only a device id. Without a binding, any bearer
 * token of the user could claim any active device of the user and read or ACK
 * its inbox, delete the backups or decline its batches. The first device id
 * that a grant presents is bound to that grant (refresh tokens keep the
 * grant, so the binding survives a token refresh). After that, the grant can
 * claim only that device. The one exception: a grant whose device is not
 * active (pending, revoked, unknown) can move to another pending device, so a
 * client that lost its local state can register again. A grant of a pending
 * device can never claim an active device.
 *
 * On revocation of a device, `revokeDeviceGrants` deletes the OIDC rows
 * (grant, access and refresh tokens) of every grant bound to it, so the bearer
 * token of a lost device stops working.
 */
import type { Redis } from 'ioredis'

const GRANT_KEY = 'takusen:grant_device:'
const DEVICE_KEY = 'takusen:device_grants:'

/** Longer than the OIDC Grant TTL (14 days). A use refreshes it. */
export const BINDING_TTL_SECONDS = 15 * 24 * 3600

export interface DeviceBindings {
  /** Binds the grant to `deviceId` if it has no device. Returns the bound device. */
  bind(grantId: string, deviceId: string): Promise<string>
  /** Moves the grant from `from` to `to` if it is still bound to `from`. */
  rebind(grantId: string, from: string, to: string): Promise<boolean>
  /** The grants bound to the device. */
  grantsOf(deviceId: string): Promise<string[]>
  /** Drops every binding of the device. */
  forget(deviceId: string): Promise<void>
}

const BIND = `
local cur = redis.call('GET', KEYS[1])
if not cur then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  redis.call('SADD', KEYS[2], ARGV[3])
  redis.call('EXPIRE', KEYS[2], ARGV[2])
  return ARGV[1]
end
if cur == ARGV[1] then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  redis.call('EXPIRE', KEYS[2], ARGV[2])
end
return cur`

const REBIND = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
redis.call('SREM', KEYS[2], ARGV[4])
redis.call('SADD', KEYS[3], ARGV[4])
redis.call('EXPIRE', KEYS[3], ARGV[3])
return 1`

export function redisDeviceBindings(client: Redis): DeviceBindings {
  return {
    async bind(grantId, deviceId) {
      const r = await client.eval(BIND, 2, GRANT_KEY + grantId, DEVICE_KEY + deviceId, deviceId, BINDING_TTL_SECONDS, grantId)
      return String(r)
    },
    async rebind(grantId, from, to) {
      const r = await client.eval(REBIND, 3, GRANT_KEY + grantId, DEVICE_KEY + from, DEVICE_KEY + to, from, to, BINDING_TTL_SECONDS, grantId)
      return Number(r) === 1
    },
    async grantsOf(deviceId) {
      return client.smembers(DEVICE_KEY + deviceId)
    },
    async forget(deviceId) {
      const grants = await client.smembers(DEVICE_KEY + deviceId)
      for (const g of grants) {
        if ((await client.get(GRANT_KEY + g)) === deviceId) await client.del(GRANT_KEY + g)
      }
      await client.del(DEVICE_KEY + deviceId)
    },
  }
}

/** For tests. */
export class InMemoryDeviceBindings implements DeviceBindings {
  readonly byGrant = new Map<string, string>()

  async bind(grantId: string, deviceId: string): Promise<string> {
    const cur = this.byGrant.get(grantId)
    if (cur) return cur
    this.byGrant.set(grantId, deviceId)
    return deviceId
  }
  async rebind(grantId: string, from: string, to: string): Promise<boolean> {
    if (this.byGrant.get(grantId) !== from) return false
    this.byGrant.set(grantId, to)
    return true
  }
  async grantsOf(deviceId: string): Promise<string[]> {
    return [...this.byGrant].filter(([, d]) => d === deviceId).map(([g]) => g)
  }
  async forget(deviceId: string): Promise<void> {
    for (const [g, d] of this.byGrant) if (d === deviceId) this.byGrant.delete(g)
  }
}

/**
 * Deletes the OIDC grant, access tokens and refresh tokens of every grant
 * bound to the devices, then their bindings. Runs after the revocation
 * commits (flushOutbox).
 */
export async function revokeDeviceGrants(
  bindings: DeviceBindings,
  deleteGrants: (grantIds: string[]) => Promise<unknown>,
  deviceIds: Iterable<string>,
): Promise<void> {
  for (const id of deviceIds) {
    const grants = await bindings.grantsOf(id)
    if (grants.length > 0) await deleteGrants(grants)
    await bindings.forget(id)
  }
}
