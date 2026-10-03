import { describe, expect, it } from 'vitest'
import type { MembershipEvent } from '@hachiman/crypto'
import { membershipSlots } from './format'

const event = (groupId: string, epoch: number): MembershipEvent => ({
  groupId,
  channelId: 'c-1',
  epoch,
  actorUserId: 'u-1',
  kind: 'added',
  subjects: [{ userId: 'u-2', deviceId: 'd-2' }]
})

describe('membershipSlots', () => {
  const messages = [
    { groupId: 'g-a', epoch: 1 },
    { groupId: 'g-a', epoch: 2 },
    { groupId: 'g-a', epoch: 4 },
    { groupId: 'g-b', epoch: 0 }
  ]

  it('puts an event before the first message of its group at or after its epoch', () => {
    const e2 = event('g-a', 2)
    const e3 = event('g-a', 3)
    const b0 = event('g-b', 0)
    const slots = membershipSlots(messages, [e2, e3, b0])
    expect(slots.get(1)).toEqual([e2])
    expect(slots.get(2)).toEqual([e3])
    expect(slots.get(3)).toEqual([b0])
  })

  it('puts a newer event after the last message', () => {
    const late = event('g-a', 9)
    expect(membershipSlots(messages, [late]).get(messages.length)).toEqual([late])
  })
})
