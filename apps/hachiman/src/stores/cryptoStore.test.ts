import type { MembershipEvent } from '@hachiman/crypto'
import { expect, it } from 'vitest'
import { addMembership, useCryptoStore } from './cryptoStore'

const invite = (inviteKeyId: string): MembershipEvent => ({
  groupId: 'g',
  channelId: 'c',
  epoch: 3,
  actorUserId: 'admin',
  kind: 'invite_with_history',
  subjects: [],
  inviteKeyId
})

it('addMembership keeps two invites with history of one epoch, and drops a repeat', () => {
  addMembership('c', [invite('k1'), invite('k2')])
  addMembership('c', [invite('k1')])
  expect(
    useCryptoStore
      .getState()
      .membership.get('c')
      ?.map((e) => e.inviteKeyId)
  ).toEqual(['k1', 'k2'])
})
