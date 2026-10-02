/**
 * The encoded AdminAction payloads of §12.16, for CryptoApi.signAdminAction.
 *
 * ponytail: a copy of AdminActionModule.encodePayload (pkgs/hachiman-crypto/src/admin), because
 * @hachiman/crypto exports only the codec to the UI thread. admin-payload.test.ts compares the two
 * byte for byte. Delete this file when the package exports the encoder.
 */
import type { AdminPayload } from '@hachiman/crypto'
import { encode, uuidToBytes, type Writer } from '@hachiman/crypto/codec'

const TARGET = { role: 1, member: 2 } as const
const VISIBILITY = { joined: 1, shared: 2 } as const

const uuid = (w: Writer, id: string): Writer => w.fixed(uuidToBytes(id), 16)

export function encodeAdminPayload(p: AdminPayload): Uint8Array {
  return encode((w) => {
    switch (p.type) {
      case 0:
        uuid(w, p.ownerId)
        return
      case 1:
      case 2:
        uuid(w, p.roleId).u64(p.permissions).u32(p.position)
        return
      case 3:
        uuid(w, p.roleId)
        return
      case 4:
        w.vector(p.positions, (x, rp) => void uuid(x, rp.roleId).u32(rp.position))
        return
      case 5:
        uuid(w, p.channelId)
        uuid(w, p.targetId).u8(TARGET[p.targetType]).u64(p.allow).u64(p.deny)
        return
      case 6:
        uuid(w, p.channelId)
        uuid(w, p.targetId).u8(TARGET[p.targetType])
        return
      case 7:
        uuid(w, p.userId).vector(p.roleIds, (x, id) => void uuid(x, id))
        return
      case 8:
        uuid(w, p.channelId).u8(VISIBILITY[p.historyVisibility])
        return
    }
  })
}
