import { beforeEach, describe, expect, it } from 'vitest'
import { usePokeStore } from './pokeStore'

const user = (id: string) => ({ id, username: id, avatar: null })

describe('pokeStore', () => {
  beforeEach(() => usePokeStore.setState({ toasts: [] }))

  it('keeps one toast per sender: a new poke replaces the old one', () => {
    const { add } = usePokeStore.getState()
    add({ id: 1, user: user('a') })
    add({ id: 2, user: user('b') })
    add({ id: 3, user: user('a') })
    expect(usePokeStore.getState().toasts.map((t) => t.id)).toEqual([2, 3])
  })

  it('shows at most three toasts, dropping the oldest', () => {
    const { add } = usePokeStore.getState()
    for (let i = 1; i <= 5; i++) add({ id: i, user: user(`u${i}`) })
    expect(usePokeStore.getState().toasts.map((t) => t.id)).toEqual([3, 4, 5])
    usePokeStore.getState().remove(4)
    expect(usePokeStore.getState().toasts.map((t) => t.id)).toEqual([3, 5])
  })
})
