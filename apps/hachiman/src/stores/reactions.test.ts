import { beforeEach, describe, expect, it } from 'vitest'
import {
  foldReactions,
  resetMessagesStore,
  useMessageStore,
  type ChatMessage,
  type ReactionEvent
} from './messagesStore'

let seq = 0
const ev = (
  userId: string,
  emoji: string,
  sentAtMs: number,
  remove = false,
  target = 'cmid-t'
): ReactionEvent => ({
  messageId: `r-${++seq}`,
  target,
  userId,
  emoji,
  remove,
  sentAtMs,
  createdAt: new Date(1_000_000 + seq).toISOString()
})

const row = (id: string, clientMsgId: string, authorId = 'u-a'): ChatMessage =>
  ({
    id,
    channelId: 'c',
    clientMsgId,
    createdAt: id,
    author: { id: authorId, username: authorId, avatar: null },
    decrypt: { status: 'ok' }
  }) as unknown as ChatMessage

const reactionsOf = (target = 'cmid-t'): Record<string, string[]> => {
  const m = useMessageStore.getState().reactions.get('c')?.get(target)
  return Object.fromEntries([...(m ?? new Map())].map(([e, users]) => [e, [...users].sort()]))
}

beforeEach(() => resetMessagesStore())

describe('reaction fold', () => {
  it('adds reactions per emoji', () => {
    useMessageStore
      .getState()
      .applyReactions('c', [ev('u1', '🔥', 1), ev('u2', '🔥', 2), ev('u1', '👀', 3)])
    expect(reactionsOf()).toEqual({ '🔥': ['u1', 'u2'], '👀': ['u1'] })
  })

  it('a remove takes the reaction back, a later add puts it back', () => {
    const s = useMessageStore.getState()
    s.applyReactions('c', [ev('u1', '🔥', 1)])
    s.applyReactions('c', [ev('u1', '🔥', 2, true)])
    expect(reactionsOf()).toEqual({})
    s.applyReactions('c', [ev('u1', '🔥', 3)])
    expect(reactionsOf()).toEqual({ '🔥': ['u1'] })
  })

  it('the newest event per (user, emoji) wins, whatever the arrival order', () => {
    const s = useMessageStore.getState()
    s.applyReactions('c', [ev('u1', '🔥', 5, true)])
    s.applyReactions('c', [ev('u1', '🔥', 2)]) // an older add arrives late
    expect(reactionsOf()).toEqual({})
    s.applyReactions('c', [ev('u2', '🔥', 9), ev('u2', '🔥', 4, true)])
    expect(reactionsOf()).toEqual({ '🔥': ['u2'] })
  })

  it('keeps reactions whose target is not loaded; the target finds them when it loads', () => {
    const s = useMessageStore.getState()
    s.applyReactions('c', [ev('u1', '🔥', 1)])
    expect(useMessageStore.getState().byChannel.get('c')).toBeUndefined()
    s.upsert('c', [row('m1', 'cmid-t')])
    expect(reactionsOf()).toEqual({ '🔥': ['u1'] })
  })

  it('a reaction never becomes a row, and replaces a placeholder row of its id', () => {
    const s = useMessageStore.getState()
    s.upsert('c', [row('m1', 'cmid-t'), row('r-ph', 'cmid-ph')])
    s.applyReactions('c', [{ ...ev('u1', '🔥', 1), messageId: 'r-ph' }])
    expect(
      useMessageStore
        .getState()
        .byChannel.get('c')
        ?.map((m) => m.id)
    ).toEqual(['m1'])
  })

  it('a deleted reaction message takes its event back', () => {
    const s = useMessageStore.getState()
    const e = ev('u1', '🔥', 1)
    s.applyReactions('c', [e])
    s.remove('c', e.messageId)
    expect(reactionsOf()).toEqual({})
  })

  it('orders emojis by their oldest reaction', () => {
    const m = foldReactions([ev('u1', 'b', 2), ev('u2', 'a', 1), ev('u3', 'b', 3)])
    expect([...m.keys()]).toEqual(['a', 'b'])
  })
})

describe('restoreReaction', () => {
  it('a failed un-react shows the reaction again', () => {
    const s = useMessageStore.getState()
    const added = ev('u1', '👍', 1)
    s.applyReactions('c', [added])
    const undo = ev('u1', '👍', 2, true)
    s.applyReactions('c', [undo])
    expect(reactionsOf()).toEqual({})
    s.restoreReaction('c', undo, added)
    expect(reactionsOf()).toEqual({ '👍': ['u1'] })
  })

  it('a failed first reaction goes away', () => {
    const s = useMessageStore.getState()
    const add = ev('u1', '🎉', 1)
    s.applyReactions('c', [add])
    s.restoreReaction('c', add, undefined)
    expect(reactionsOf()).toEqual({})
  })

  it('keeps a newer event of the pair', () => {
    const s = useMessageStore.getState()
    const add = ev('u1', '🎉', 1)
    s.applyReactions('c', [add])
    s.applyReactions('c', [ev('u1', '🎉', 5)])
    s.restoreReaction('c', add, undefined)
    expect(reactionsOf()).toEqual({ '🎉': ['u1'] })
  })
})
