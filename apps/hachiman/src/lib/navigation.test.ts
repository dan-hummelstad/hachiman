import { describe, expect, it } from 'vitest'
import { jumpStep } from './navigation'

describe('jumpStep', () => {
  it('shows a row that the transcript has, also while history loads', () => {
    expect(jumpStep('m2', ['m1', 'm2'], true)).toBe('show')
    expect(jumpStep('m2', ['m2'], false)).toBe('show')
  })

  it('waits for the history, then drops a row that is not in it', () => {
    expect(jumpStep('m9', [], false)).toBe('wait')
    expect(jumpStep('m9', ['m1'], true)).toBe('drop')
  })
})
