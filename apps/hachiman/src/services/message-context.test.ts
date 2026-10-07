import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '@hachiman/client'
import type { ChatMessage } from '@/stores/messagesStore'
import { useUserStore } from '@/stores/userStore'

const me: User = { id: 'me', username: 'me', avatar: null } as User
const cache = { user: me as User | null, members: new Map() }
vi.mock('@/services/client', () => ({ hachiman: { cache } }))
vi.mock('cuelume', () => ({ play: vi.fn() }))

const { isNotification, messageContext } = await import('./message-context')
const { messageSound } = await import('./SoundService')

const row = (authorId: string, over: Partial<ChatMessage> = {}): ChatMessage =>
  ({
    id: 'm1',
    channelId: 'dm',
    guildId: null,
    author: { id: authorId, username: authorId, avatar: null },
    content: 'hi @me',
    mentions: [{ kind: 'user', userId: 'me' }],
    decrypt: { status: 'ok' },
    ...over
  }) as ChatMessage

beforeEach(() => {
  useUserStore.setState({ blocks: new Set() })
})

describe('isNotification', () => {
  it('is a row from someone else that I did not block', () => {
    expect(isNotification(row('bob'), 'me')).toBe(true)
    expect(isNotification(row('me'), 'me')).toBe(false)
    expect(isNotification(row('bob'), 'me', (id) => id === 'bob')).toBe(false)
    // A reaction is no row.
    expect(isNotification(undefined, 'me')).toBe(false)
    expect(isNotification(row('bob', { kind: 'page_activity' }), 'me')).toBe(true)
  })
})

describe('messageContext and the sound', () => {
  it('a blocked author counts nowhere: no unread, no mention, no sound', () => {
    useUserStore.setState({ blocks: new Set(['bob']) })
    const ctx = messageContext('dm', row('bob'))
    expect(ctx).toEqual({ viewing: false, isNotification: false, mentionsMe: false })
    expect(messageSound(row('bob'), ctx)).toBeNull()
  })

  it('a reaction (no row) is no notification', () => {
    expect(messageContext('dm', undefined).isNotification).toBe(false)
  })

  it('a DM from someone else pings, and mentions me', () => {
    const ctx = messageContext('dm', row('bob'))
    expect(ctx.isNotification).toBe(true)
    expect(ctx.mentionsMe).toBe(true)
    expect(messageSound(row('bob'), ctx)).toBe('message')
  })

  it('a page activity counts as unread but does not ping', () => {
    const r = row('bob', { kind: 'page_activity', content: '', mentions: [] })
    const ctx = messageContext('dm', r)
    expect(ctx.isNotification).toBe(true)
    expect(messageSound(r, ctx)).toBeNull()
  })
})
