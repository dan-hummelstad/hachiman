import { describe, expect, it } from 'vitest'
import { autoSelect, isAutoSelect } from './auto-select'

describe('autoSelect', () => {
  it('marks only the run of its callback, also when it throws', () => {
    let seen = false
    autoSelect(() => {
      seen = isAutoSelect()
    })
    expect(seen).toBe(true)
    expect(isAutoSelect()).toBe(false)
    expect(() =>
      autoSelect(() => {
        throw new Error('x')
      })
    ).toThrow('x')
    expect(isAutoSelect()).toBe(false)
  })
})
