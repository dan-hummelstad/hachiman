import type { MembershipEvent } from '@hachiman/crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  addMembership,
  deferKeyChange,
  dismissKeyChange,
  pushKeyChange,
  resetCryptoStore,
  useCryptoStore
} from './cryptoStore'

beforeEach(resetCryptoStore)

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

describe('deferred key changes', () => {
  const deferred = (): string[] => useCryptoStore.getState().deferredKeyChanges

  it('defers only a pending change, once', () => {
    deferKeyChange('u-a')
    expect(deferred()).toEqual([])
    pushKeyChange({ userId: 'u-a', severity: 'blocking' })
    deferKeyChange('u-a')
    deferKeyChange('u-a')
    expect(deferred()).toEqual(['u-a'])
    expect(useCryptoStore.getState().keyChanges).toEqual([{ userId: 'u-a', severity: 'blocking' }])
  })

  it('keeps the deferral for a repeat of the same change, and drops it for a new severity', () => {
    pushKeyChange({ userId: 'u-a', severity: 'blocking' })
    deferKeyChange('u-a')
    const before = deferred()
    pushKeyChange({ userId: 'u-a', severity: 'blocking' })
    expect(deferred()).toBe(before)
    pushKeyChange({ userId: 'u-a', severity: 'notice' })
    expect(deferred()).toEqual([])
  })

  it('drops the deferral with the change, and leaves other users alone', () => {
    pushKeyChange({ userId: 'u-a', severity: 'blocking' })
    pushKeyChange({ userId: 'u-b', severity: 'blocking' })
    deferKeyChange('u-a')
    deferKeyChange('u-b')
    dismissKeyChange('u-a')
    expect(deferred()).toEqual(['u-b'])
    expect(useCryptoStore.getState().keyChanges.map((k) => k.userId)).toEqual(['u-b'])
  })

  it('keeps the same array when nothing to drop', () => {
    pushKeyChange({ userId: 'u-a', severity: 'blocking' })
    const before = deferred()
    dismissKeyChange('u-a')
    expect(deferred()).toBe(before)
  })
})
