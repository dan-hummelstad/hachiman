/** AdminService (docs/gateway-protocol.md §12.16, Phase 4): signs the next action of a guild chain. */
import { CryptoError, type AdminActionTypeId, type CreateAdminService } from '../api'
import { toB64url } from '../codec'
import { AdminActionType } from '../constants'
import { admin } from './index'

export const createAdminService: CreateAdminService = (ctx, identity) => ({
  async signAdminAction(guildId, type: AdminActionTypeId, payload) {
    const self = identity.self()
    // adminState fetches the newest actions and verifies the chain before it gives the head.
    const head = await identity.adminState(guildId)
    if (head === null && type !== AdminActionType.GENESIS) throw new CryptoError('Unsupported', 'the guild has no genesis action yet')
    if (head !== null && type === AdminActionType.GENESIS) throw new CryptoError('Unsupported', 'the guild already has a genesis action')
    // Fail before signing when the payload does not decode for its type.
    try {
      admin.decodePayload(type, payload)
    } catch (e) {
      throw new CryptoError('Malformed', `admin payload: ${(e as Error).message}`)
    }
    const action = admin.sign(
      {
        guildId,
        seq: head === null ? 0 : head.seq + 1,
        type,
        actorUserId: self.userId,
        actorDeviceId: self.deviceId,
        timestampMs: ctx.now(),
        prevHash: head === null ? new Uint8Array(32) : head.headHash,
        payload,
      },
      self.mlsSignatureKey.privateKey,
    )
    return { header: toB64url(admin.encodeAction(action)), seq: action.seq }
  },
})
