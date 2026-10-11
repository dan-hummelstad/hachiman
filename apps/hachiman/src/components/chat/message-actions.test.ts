import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/MessagesService', () => ({ messagesService: {} }))
vi.mock('@/services/guild-features', () => ({ pinsService: {} }))

const {
  availableActions,
  liftPlacement,
  plainMessageText,
  quickReactionKeys,
  usableReactionKey,
  DEFAULT_QUICK_REACTIONS
} = await import('./message-actions')

const policy = { canSend: true, canManage: false, canPin: false, canThread: true }
const facts = {
  policy,
  mine: false,
  readable: true,
  pending: false,
  failed: false,
  hasTarget: true,
  hasText: true
}

describe('availableActions', () => {
  it('offers the answer actions on a sent row of someone else', () => {
    expect(availableActions(facts)).toEqual(['react', 'reply', 'thread', 'copy', 'info'])
  })

  it('offers edit and delete on my row, pin with the permission', () => {
    expect(availableActions({ ...facts, mine: true, policy: { ...policy, canPin: true } })).toEqual(
      ['react', 'reply', 'thread', 'copy', 'pin', 'edit', 'info', 'delete']
    )
  })

  it('lets a moderator delete the row of someone else', () => {
    expect(availableActions({ ...facts, policy: { ...policy, canManage: true } })).toContain(
      'delete'
    )
  })

  it('offers no answers without SEND_MESSAGES or a target', () => {
    const noSend = { ...facts, policy: { ...policy, canSend: false, canThread: false } }
    expect(availableActions(noSend)).toEqual(['copy', 'info'])
    expect(availableActions({ ...facts, hasTarget: false })).toEqual(['thread', 'copy', 'info'])
  })

  it('offers no react, thread, copy or edit on a row that did not decrypt', () => {
    expect(availableActions({ ...facts, mine: true, readable: false })).toEqual([
      'reply',
      'info',
      'delete'
    ])
  })

  it('offers no copy for a row without text', () => {
    expect(availableActions({ ...facts, hasText: false })).not.toContain('copy')
  })

  it('offers only copy on a pending row, and copy and delete on a failed one', () => {
    const mineAll = { ...facts, mine: true, policy: { ...policy, canPin: true, canManage: true } }
    expect(availableActions({ ...mineAll, pending: true })).toEqual(['copy'])
    expect(availableActions({ ...mineAll, pending: true, failed: true })).toEqual([
      'copy',
      'delete'
    ])
    expect(availableActions({ ...mineAll, failed: true, hasText: false })).toEqual(['delete'])
  })
})

describe('plainMessageText', () => {
  const names = {
    user: (id: string) => (id === 'u1' ? 'Juni' : null),
    role: (id: string) => (id === 'r1' ? 'Mods' : null)
  }

  it('turns the wire forms back into display text', () => {
    expect(plainMessageText('hi <@u1> and <@&r1> <:party:e1>', names)).toBe(
      'hi @Juni and @Mods :party:'
    )
  })

  it('keeps unknown users raw and names a deleted role as the row does', () => {
    expect(plainMessageText('<@u9> <@&r9>', names)).toBe('<@u9> @deleted-role')
  })

  it('keeps links and @usernames, and drops page links', () => {
    const page = 'hachiman:page/0a1b2c3d-0000-4000-8000-000000000000'
    expect(plainMessageText(`see https://a.example/x @kestrel [Plan](${page})`, names)).toBe(
      'see https://a.example/x @kestrel'
    )
  })
})

describe('quickReactionKeys', () => {
  const all = (): boolean => true

  it('tops up recent picks with the defaults, without repeats', () => {
    expect(quickReactionKeys(['🎮', '👍'], all)).toEqual(['🎮', '👍', '❤️', '😂', '🔥', '🎉'])
  })

  it('takes the defaults when nothing was picked', () => {
    expect(quickReactionKeys([], all)).toEqual([...DEFAULT_QUICK_REACTIONS].slice(0, 6))
  })

  it('stops at the count', () => {
    const recent = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(quickReactionKeys(recent, all)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('skips custom emojis that this client does not know', () => {
    const index = new Map([['e1', {}]])
    const usable = (k: string): boolean => usableReactionKey(k, index)
    expect(quickReactionKeys(['party:e1', 'gone:e2', '🎮'], usable).slice(0, 3)).toEqual([
      'party:e1',
      '🎮',
      '👍'
    ])
  })
})

describe('liftPlacement', () => {
  it('puts the row 12 px above the sheet', () => {
    expect(liftPlacement({ rowHeight: 111, sheetTop: 432, minTop: 62 })).toEqual({
      top: 309,
      height: 111,
      clamped: false
    })
  })

  it('cuts a row taller than the room under the status bar', () => {
    expect(liftPlacement({ rowHeight: 600, sheetTop: 432, minTop: 62 })).toEqual({
      top: 62,
      height: 358,
      clamped: true
    })
  })

  it('never gives a negative height', () => {
    expect(liftPlacement({ rowHeight: 50, sheetTop: 60, minTop: 62 }).height).toBe(0)
  })
})
