import { describe, expect, it } from 'vitest'
import type { AdminPayload } from '@hachiman/crypto'
// The encoder that Takusen and the Worker use. Test only: the UI bundle never imports it.
import { admin } from '../../../../pkgs/hachiman-crypto/src/admin/index'
import { encodeAdminPayload } from './admin-payload'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'

const payloads: AdminPayload[] = [
  { type: 0, ownerId: A },
  { type: 1, roleId: A, permissions: 2 ** 30 + 5, position: 1 },
  { type: 2, roleId: B, permissions: 0, position: 7 },
  { type: 3, roleId: C },
  { type: 4, positions: [] },
  {
    type: 4,
    positions: [
      { roleId: A, position: 2 },
      { roleId: B, position: 1 }
    ]
  },
  { type: 5, channelId: A, targetId: B, targetType: 'role', allow: 1024, deny: 2048 },
  { type: 5, channelId: A, targetId: C, targetType: 'member', allow: 0, deny: 1 },
  { type: 6, channelId: A, targetId: B, targetType: 'member' },
  { type: 7, userId: A, roleIds: [B, C] },
  { type: 7, userId: A, roleIds: [] },
  { type: 8, channelId: C, historyVisibility: 'joined' },
  { type: 8, channelId: C, historyVisibility: 'shared' }
]

describe('encodeAdminPayload', () => {
  it('is byte-equal to AdminActionModule.encodePayload for every payload type', () => {
    for (const p of payloads) {
      expect([...encodeAdminPayload(p)]).toEqual([...admin.encodePayload(p)])
      expect(admin.decodePayload(p.type, encodeAdminPayload(p))).toEqual(p)
    }
  })
})
