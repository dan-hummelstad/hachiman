import { describe, expect, it } from 'vitest'
import type { Member } from '@hachiman/client'
import type { MembershipEvent } from '@hachiman/crypto'
import { joinSlots, keyChangeSlot, membershipSlots } from './format'

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

describe('joinSlots', () => {
  const member = (id: string, joinedAt: string): Member =>
    ({ user: { id }, joinedAt }) as unknown as Member
  const messages = [{ createdAt: '2026-10-01T10:00:00Z' }, { createdAt: '2026-10-02T10:00:00Z' }]

  it('puts a join before the first message after it, oldest first', () => {
    const b = member('b', '2026-10-01T12:00:00Z')
    const a = member('a', '2026-10-01T11:00:00Z')
    const late = member('c', '2026-10-03T00:00:00Z')
    const slots = joinSlots(messages, [b, late, a], true)
    expect(slots.get(1)).toEqual([a, b])
    expect(slots.get(2)).toEqual([late])
  })

  it('shows a join before the loaded page only when the history is complete', () => {
    const early = member('e', '2026-09-01T00:00:00Z')
    expect(joinSlots(messages, [early], false).size).toBe(0)
    expect(joinSlots(messages, [early], true).get(0)).toEqual([early])
    expect(joinSlots([], [early], false).size).toBe(0)
  })
})

describe('keyChangeSlot', () => {
  const messages = [
    { createdAt: '2026-10-06T07:41:00Z' },
    { createdAt: '2026-10-06T07:43:00Z' },
    { createdAt: '2026-10-06T10:53:00Z' }
  ]

  it('puts the line before the first message after the change', () => {
    expect(keyChangeSlot(messages, '2026-10-06T08:00:00Z', false)).toBe(2)
    expect(keyChangeSlot(messages, '2026-10-06T07:43:00Z', false)).toBe(2)
  })

  it('puts a newer change, or one with no time, after the last message', () => {
    expect(keyChangeSlot(messages, '2026-10-06T11:00:00Z', false)).toBe(3)
    expect(keyChangeSlot(messages, null, false)).toBe(3)
    expect(keyChangeSlot(messages, 'not a time', false)).toBe(3)
  })

  it('shows a change before the loaded page only when the history is complete', () => {
    expect(keyChangeSlot(messages, '2026-10-01T00:00:00Z', false)).toBeNull()
    expect(keyChangeSlot(messages, '2026-10-01T00:00:00Z', true)).toBe(0)
    expect(keyChangeSlot([], null, false)).toBeNull()
    expect(keyChangeSlot([], null, true)).toBe(0)
  })
})
