import { describe, expect, it } from 'vitest'
import { applyCompletion, findTrigger, matchRank, rankItems, toWire } from './mention-complete'

describe('findTrigger', () => {
  it('finds @ and # at the start or after a space', () => {
    expect(findTrigger('@ke', 3)).toEqual({ char: '@', query: 'ke', start: 0, end: 3 })
    expect(findTrigger('hi #gen', 7)).toEqual({ char: '#', query: 'gen', start: 3, end: 7 })
    expect(findTrigger('hi @', 4)).toEqual({ char: '@', query: '', start: 3, end: 4 })
  })

  it('ignores an @ inside a word and a query that a space ended', () => {
    expect(findTrigger('mail a@b', 8)).toBeNull()
    expect(findTrigger('@kes trel', 9)).toBeNull()
  })

  it('reads only the text before the caret', () => {
    expect(findTrigger('@ke rest', 3)).toEqual({ char: '@', query: 'ke', start: 0, end: 3 })
  })
})

describe('applyCompletion', () => {
  it('replaces the trigger, adds one space and puts the caret after it', () => {
    const t = findTrigger('hi @ke', 6)!
    expect(applyCompletion('hi @ke', t, '@kestrel')).toEqual({ text: 'hi @kestrel ', caret: 12 })
  })

  it('does not double a space that already follows', () => {
    const t = findTrigger('@ke there', 3)!
    expect(applyCompletion('@ke there', t, '@kestrel').text).toBe('@kestrel there')
  })
})

describe('rankItems', () => {
  const items = ['juniper', 'Juni', 'kestrel', 'ninja']
  it('ranks prefix before word prefix before contains, ties in input order', () => {
    expect(matchRank('Squad Leads', 'lea')).toBe(1)
    expect(rankItems(items, 'jun', (s) => [s])).toEqual(['juniper', 'Juni'])
    expect(rankItems(items, 'ni', (s) => [s])).toEqual(['ninja', 'juniper', 'Juni'])
  })

  it('lists everything for an empty query, up to the limit', () => {
    expect(rankItems(items, '', (s) => [s], 2)).toEqual(['juniper', 'Juni'])
  })
})

describe('toWire', () => {
  it('turns picked role mentions into wire tokens, longest name first', () => {
    const roles = [
      { display: '@Squad', wire: '<@&r1>' },
      { display: '@Squad Leads', wire: '<@&r2>' }
    ]
    expect(toWire('ping @Squad Leads and @Squad.', roles)).toBe('ping <@&r2> and <@&r1>.')
  })

  it('leaves a longer word that only starts with the name alone', () => {
    expect(toWire('@Squadron', [{ display: '@Squad', wire: '<@&r1>' }])).toBe('@Squadron')
  })
})

describe('emoji completion', () => {
  it('opens on ":" with at least 2 shortcode characters', () => {
    expect(findTrigger('gg :jo', 6)).toEqual({ char: ':', query: 'jo', start: 3, end: 6 })
    expect(findTrigger(':+1', 3)).toEqual({ char: ':', query: '+1', start: 0, end: 3 })
    expect(findTrigger('gg :j', 5)).toBeNull()
    expect(findTrigger('nice :)', 7)).toBeNull()
    expect(findTrigger('note:jo', 7)).toBeNull()
    expect(findTrigger('see http://x', 12)).toBeNull()
  })

  it('sends a picked custom emoji in its wire form', () => {
    const party = { display: ':party:', wire: '<:party:e-1>' }
    expect(toWire('yay :party: :party:', [party])).toBe('yay <:party:e-1> <:party:e-1>')
  })
})
