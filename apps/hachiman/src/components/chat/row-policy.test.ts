import { describe, expect, it } from 'vitest'
import { Permissions, type Channel } from '@hachiman/client'
import { rowPolicy } from './row-policy'

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
