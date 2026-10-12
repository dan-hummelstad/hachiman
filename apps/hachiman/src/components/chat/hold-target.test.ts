import { describe, expect, it } from 'vitest'
import { holdIgnored } from './hold-target'

/** A DOM node stand-in: `closest` matches when `ignore` is set, `contains` walks `parent`. */
function node(parent: object | null, ignore = false): Node & Element {
  const self = {
    parent,
    closest: (): object | null => (ignore ? self : null),
    contains(other: { parent?: object | null } | null): boolean {
      for (let n = other; n; n = (n.parent ?? null) as typeof n) if (n === self) return true
      return false
    }
  }
  return self as unknown as Node & Element
}

describe('holdIgnored', () => {
  const row = node(null)

  it('starts the hold on a plain part of the row', () => {
    expect(holdIgnored(node(row), row)).toBe(false)
    expect(holdIgnored(row, row)).toBe(false)
  })

  it('skips links, media and [data-hold-ignore] parts', () => {
    expect(holdIgnored(node(row, true), row)).toBe(true)
  })

  it('skips a press in a portal child (a sheet the row opened), which is not in the row', () => {
    const sheet = node(null)
    expect(holdIgnored(node(sheet), row)).toBe(true)
    expect(holdIgnored(null, row)).toBe(true)
  })
})
