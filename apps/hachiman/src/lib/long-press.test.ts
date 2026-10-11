import { describe, expect, it } from 'vitest'
import {
  LONG_PRESS_IDLE,
  longPressStep,
  type LongPressInput,
  type LongPressState,
  type LongPressStep
} from '@/lib/long-press'

const down = (pointerType = 'touch', pointerId = 1, x = 100, y = 200): LongPressInput => ({
  type: 'down',
  pointerId,
  pointerType,
  x,
  y
})
const move = (x: number, y: number, pointerId = 1): LongPressInput => ({
  type: 'move',
  pointerId,
  x,
  y
})
const up = (pointerId = 1): LongPressInput => ({ type: 'up', pointerId })

function run(...inputs: LongPressInput[]): LongPressStep[] {
  let state: LongPressState = LONG_PRESS_IDLE
  return inputs.map((input) => {
    const s = longPressStep(state, input)
    state = s.state
    return s
  })
}

const last = (steps: LongPressStep[]): LongPressStep => steps[steps.length - 1]

describe('longPressStep', () => {
  it('starts the timer on a touch or pen down', () => {
    expect(run(down('touch'))[0]).toEqual({
      state: { phase: 'pressing', pointerId: 1, x: 100, y: 200 },
      effect: 'startTimer'
    })
    expect(run(down('pen'))[0].effect).toBe('startTimer')
  })

  it('ignores a mouse', () => {
    expect(run(down('mouse'))[0]).toEqual({ state: LONG_PRESS_IDLE, effect: null })
    expect(run(down('mouse'), { type: 'contextmenu' })[1].effect).toBeNull()
  })

  it('fires when the timer runs out', () => {
    const steps = run(down(), move(104, 203), { type: 'timeout' })
    expect(steps[1].effect).toBeNull()
    expect(last(steps)).toEqual({
      state: { phase: 'held', pointerId: 1, x: 100, y: 200 },
      effect: 'fire'
    })
  })

  it('cancels on a move past the slop', () => {
    const steps = run(down(), move(100, 209))
    expect(last(steps)).toEqual({ state: LONG_PRESS_IDLE, effect: 'stopTimer' })
    expect(longPressStep(last(steps).state, { type: 'timeout' }).effect).toBeNull()
  })

  it('measures the slop as a distance, not per axis', () => {
    expect(last(run(down(), move(105, 206))).state.phase).toBe('pressing')
    expect(last(run(down(), move(106, 206))).effect).toBe('stopTimer')
  })

  it('takes a custom slop', () => {
    const pressing = run(down())[0].state
    expect(longPressStep(pressing, move(112, 200), 16).effect).toBeNull()
    expect(longPressStep(pressing, move(117, 200), 16).effect).toBe('stopTimer')
  })

  it('cancels on a scroll or pointercancel', () => {
    expect(last(run(down(), { type: 'cancel' }))).toEqual({
      state: LONG_PRESS_IDLE,
      effect: 'stopTimer'
    })
    expect(last(run(down(), { type: 'cancel' }, { type: 'timeout' })).effect).toBeNull()
  })

  it('cancels on a lift before the hold time, and lets the click through', () => {
    const steps = run(down(), up(), { type: 'click' })
    expect(steps[1]).toEqual({ state: LONG_PRESS_IDLE, effect: 'stopTimer' })
    expect(steps[2].effect).toBeNull()
  })

  it('cancels when a second finger lands', () => {
    expect(last(run(down(), down('touch', 2)))).toEqual({
      state: LONG_PRESS_IDLE,
      effect: 'stopTimer'
    })
  })

  it('ignores the moves and lifts of other pointers', () => {
    expect(last(run(down(), move(300, 300, 2))).state.phase).toBe('pressing')
    expect(last(run(down(), up(2))).state.phase).toBe('pressing')
  })

  it('swallows the click after a fire', () => {
    const steps = run(down(), { type: 'timeout' }, up(), { type: 'click' })
    expect(steps[2]).toEqual({
      state: { phase: 'released', pointerId: 1, x: 100, y: 200 },
      effect: null
    })
    expect(steps[3]).toEqual({ state: LONG_PRESS_IDLE, effect: 'swallow' })
  })

  it('swallows only one click', () => {
    const steps = run(down(), { type: 'timeout' }, up(), { type: 'click' }, { type: 'click' })
    expect(last(steps)).toEqual({ state: LONG_PRESS_IDLE, effect: null })
  })

  it('does not swallow after the click window ends', () => {
    const steps = run(down(), { type: 'timeout' }, up(), { type: 'cancel' }, { type: 'click' })
    expect(last(steps).effect).toBeNull()
  })

  it('starts a new press after a release that made no click', () => {
    const steps = run(down(), { type: 'timeout' }, up(), down('touch', 3), up(3), {
      type: 'click'
    })
    expect(steps[3].effect).toBe('startTimer')
    expect(last(steps).effect).toBeNull()
  })

  it('ignores moves and other fingers while held', () => {
    const held = run(down(), { type: 'timeout' })[1].state
    expect(longPressStep(held, move(400, 400)).state).toBe(held)
    expect(longPressStep(held, down('touch', 2)).state).toBe(held)
  })

  it('swallows the native contextmenu of a press', () => {
    expect(last(run(down(), { type: 'contextmenu' }))).toMatchObject({
      state: { phase: 'pressing' },
      effect: 'swallow'
    })
    expect(last(run(down(), { type: 'timeout' }, { type: 'contextmenu' })).effect).toBe('swallow')
    expect(run({ type: 'contextmenu' })[0].effect).toBeNull()
  })

  it('ignores a late timeout', () => {
    expect(run({ type: 'timeout' })[0]).toEqual({ state: LONG_PRESS_IDLE, effect: null })
    expect(last(run(down(), { type: 'timeout' }, { type: 'timeout' })).effect).toBeNull()
  })
})
