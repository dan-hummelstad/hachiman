import { describe, expect, it } from 'vitest'
import { SHEET_MAX_H, SHEET_SIZE } from './sheet-size'

describe('SHEET_SIZE', () => {
  it('fit adds no height: the content sizes the sheet', () => {
    expect(SHEET_SIZE.fit).toBe('')
  })

  it('full is exactly the max height, so the sheet never overflows its top stop', () => {
    expect(SHEET_SIZE.full.replace(/^h-/, '')).toBe(SHEET_MAX_H.replace(/^max-h-/, ''))
  })
})
