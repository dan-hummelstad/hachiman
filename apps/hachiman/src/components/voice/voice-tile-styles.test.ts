import { describe, expect, it } from 'vitest'
import { mobileStageGrid, stageColumns } from './voice-tile-styles'

describe('mobileStageGrid', () => {
  it('stacks one or two people in one column that fills the stage', () => {
    expect(mobileStageGrid(1)).toEqual({ columns: 1, fill: true, spanLast: false })
    expect(mobileStageGrid(2)).toEqual({ columns: 1, fill: true, spanLast: false })
  })

  it('puts three and four people in two columns that fill the stage (M10)', () => {
    expect(mobileStageGrid(3)).toEqual({ columns: 2, fill: true, spanLast: true })
    expect(mobileStageGrid(4)).toEqual({ columns: 2, fill: true, spanLast: false })
  })

  it('scrolls square tiles in two columns past four people', () => {
    for (const count of [5, 6, 9, 25]) {
      expect(mobileStageGrid(count)).toEqual({ columns: 2, fill: false, spanLast: false })
    }
  })

  it('never uses more than two columns, where the desktop grid uses up to four', () => {
    expect(stageColumns(12)).toBe('grid-cols-4')
    expect(mobileStageGrid(12).columns).toBe(2)
  })
})
