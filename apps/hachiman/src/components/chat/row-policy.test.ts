import { describe, expect, it } from 'vitest'
import { Permissions, type Channel } from '@hachiman/client'
import { rowKind, rowPolicy } from './row-policy'

const ok = { status: 'ok' } as const
const pending = { status: 'pending', reason: 'epoch_ahead' } as const
const activity = { pageId: 'p-1', changes: 2 }

describe('rowKind', () => {
  it('collapses a blocked author before the kind, also for page activity', () => {
    expect(rowKind({ decrypt: ok }, true)).toBe('blocked')
    expect(
      rowKind({ kind: 'page_activity', pageActivity: activity, decrypt: ok }, true)
    ).toBe('blocked')
  })

  it('shows the real kind of a blocked row once the user shows it', () => {
    const m = { kind: 'page_activity', pageActivity: activity, decrypt: ok } as const
    expect(rowKind(m, false)).toBe('page_activity')
    expect(rowKind({ decrypt: ok }, false)).toBe('message')
  })

  it('gives a page activity without readable content the message row (with its placeholder)', () => {
    expect(rowKind({ kind: 'page_activity', decrypt: ok })).toBe('message')
    expect(rowKind({ kind: 'page_activity', pageActivity: activity, decrypt: pending })).toBe(
      'message'
    )
    expect(rowKind({ kind: 'page_activity', pageActivity: activity, decrypt: ok })).toBe(
      'page_activity'
    )
  })
})

describe('rowPolicy', () => {
  const text = { id: 'c', type: 'text', guildId: 'g' } as Channel
  const dm = { id: 'd', type: 'dm', guildId: null } as unknown as Channel

  it('derives send, manage, pin and thread from the permission bits', () => {
    expect(rowPolicy(text, 0)).toEqual({
      canSend: false,
      canManage: false,
      canPin: false,
      canThread: false
    })
    const all = Permissions.SEND_MESSAGES | Permissions.MANAGE_MESSAGES
    expect(rowPolicy(text, all)).toEqual({
      canSend: true,
      canManage: true,
      canPin: true,
      canThread: true
    })
  })

  it('lets anyone pin in a DM, and starts no thread there', () => {
    const p = rowPolicy(dm, Permissions.SEND_MESSAGES)
    expect(p.canPin).toBe(true)
    expect(p.canThread).toBe(false)
  })
})
