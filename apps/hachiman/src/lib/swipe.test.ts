import { describe, expect, it } from 'vitest'
import {
  SWIPE_IDLE,
  directionOf,
  drawerWidth,
  openShare,
  swipeIntents,
  swipeStep,
  type SwipeEnv,
  type SwipeInput,
  type SwipeStart,
  type SwipeState,
  type SwipeStep
} from './swipe'

const env = (over: Partial<SwipeEnv> = {}): SwipeEnv => ({
  open: null,
  pushed: false,
  hasRight: true,
  edge: 24,
  drawerWidth: 320,
  screenWidth: 393,
  ...over
})
const at = (x: number, over: Partial<SwipeStart> = {}): SwipeStart => ({
  x,
  y: 400,
  ignore: false,
  inChat: true,
  ...over
})
const down = (start: SwipeStart, e: SwipeEnv = env()): SwipeInput => ({
  type: 'down',
  env: e,
  start
})
const move = (x: number, t: number, y = 400): SwipeInput => ({ type: 'move', x, y, t })
const up = (t: number): SwipeInput => ({ type: 'up', t })

function run(...inputs: SwipeInput[]): SwipeStep[] {
  let state: SwipeState = SWIPE_IDLE
  return inputs.map((input) => {
    const s = swipeStep(state, input)
    state = s.state
    return s
  })
}
const last = (steps: SwipeStep[]): SwipeStep => steps[steps.length - 1]

describe('drawerWidth', () => {
  it('is 320, also on the iPhone SE, and leaves at least 48 px of the chat in view', () => {
    expect(drawerWidth(393)).toBe(320)
    expect(drawerWidth(375)).toBe(320)
    expect(drawerWidth(360)).toBe(312)
    expect(drawerWidth(40)).toBe(0)
  })
})

describe('swipeIntents', () => {
  it('opens the left drawer from the edge and the right one from the chat', () => {
    expect(swipeIntents(env(), at(10))).toEqual([
      { kind: 'open', side: 'left' },
      { kind: 'open', side: 'right' }
    ])
    expect(swipeIntents(env(), at(200))).toEqual([{ kind: 'open', side: 'right' }])
    expect(swipeIntents(env(), at(10, { inChat: false }))).toEqual([{ kind: 'open', side: 'left' }])
  })

  it('has no right drawer without a channel', () => {
    expect(swipeIntents(env({ hasRight: false }), at(200))).toEqual([])
  })

  it('counts the safe inset in the edge zone', () => {
    expect(swipeIntents(env({ edge: 24 + 47 }), at(60, { inChat: false }))).toEqual([
      { kind: 'open', side: 'left' }
    ])
  })

  it('only closes an open drawer', () => {
    expect(swipeIntents(env({ open: 'left' }), at(10))).toEqual([{ kind: 'close', side: 'left' }])
    expect(swipeIntents(env({ open: 'right' }), at(200))).toEqual([
      { kind: 'close', side: 'right' }
    ])
  })

  it('means Back at the edge of a pushed screen, and nothing elsewhere', () => {
    expect(swipeIntents(env({ pushed: true }), at(10))).toEqual([{ kind: 'back' }])
    expect(swipeIntents(env({ pushed: true }), at(200))).toEqual([])
  })

  it('starts nothing in a scroller, a field or [data-swipe-ignore]', () => {
    expect(swipeIntents(env(), at(10, { ignore: true }))).toEqual([])
    expect(swipeIntents(env({ open: 'left' }), at(10, { ignore: true }))).toEqual([])
  })
})

describe('directionOf and openShare', () => {
  it('gives the finger direction of each swipe', () => {
    expect(directionOf({ kind: 'open', side: 'left' })).toBe(1)
    expect(directionOf({ kind: 'close', side: 'left' })).toBe(-1)
    expect(directionOf({ kind: 'open', side: 'right' })).toBe(-1)
    expect(directionOf({ kind: 'close', side: 'right' })).toBe(1)
    expect(directionOf({ kind: 'back' })).toBe(1)
  })

  it('turns progress into the open share of the drawer', () => {
    expect(openShare({ kind: 'open', side: 'left' }, 0.25)).toBe(0.25)
    expect(openShare({ kind: 'close', side: 'right' }, 0.25)).toBe(0.75)
  })
})

describe('swipeStep', () => {
  it('stays idle for a touch that can do nothing', () => {
    const [s] = run(down(at(200), env({ hasRight: false })))
    expect(s.state).toBe(SWIPE_IDLE)
  })

  it('waits until the finger moved 10 px', () => {
    const steps = run(down(at(10)), move(19, 10))
    expect(last(steps).state.phase).toBe('pending')
    expect(last(steps).out).toBeNull()
  })

  it('locks a sideways move and follows the finger', () => {
    const steps = run(down(at(10)), move(30, 10, 405), move(90, 20))
    expect(steps[1].out).toEqual({
      kind: 'lock',
      intent: { kind: 'open', side: 'left' },
      progress: 20 / 320
    })
    expect(steps[2].out).toEqual({
      kind: 'drag',
      intent: { kind: 'open', side: 'left' },
      progress: 80 / 320
    })
  })

  it('picks the swipe that matches the direction', () => {
    const steps = run(down(at(10)), move(-5, 10))
    expect(steps[1].out).toMatchObject({ intent: { kind: 'open', side: 'right' } })
  })

  it('lets a vertical or diagonal move scroll', () => {
    expect(last(run(down(at(200)), move(200, 10, 420))).state).toBe(SWIPE_IDLE)
    // |dx| 12 is not more than 1.2 × |dy| 10.
    expect(last(run(down(at(200)), move(188, 10, 410))).state).toBe(SWIPE_IDLE)
  })

  it('drops a move in a direction that no swipe has', () => {
    expect(last(run(down(at(200)), move(230, 10))).state).toBe(SWIPE_IDLE)
    expect(last(run(down(at(200), env({ open: 'left' })), move(230, 10))).state).toBe(SWIPE_IDLE)
  })

  it('clamps the progress to the drawer', () => {
    const steps = run(down(at(10)), move(30, 10), move(500, 20), move(-50, 30))
    expect(steps[2].out).toMatchObject({ progress: 1 })
    expect(steps[3].out).toMatchObject({ progress: 0 })
  })

  it('commits a slow drag past 35 % and snaps back a short one', () => {
    const far = run(down(at(10)), move(30, 10), move(130, 500), up(700))
    expect(last(far).out).toEqual({
      kind: 'end',
      intent: { kind: 'open', side: 'left' },
      commit: true
    })
    const short = run(down(at(10)), move(30, 10), move(100, 500), up(700))
    expect(last(short).out).toMatchObject({ kind: 'end', commit: false })
  })

  it('commits a flick, but not one that stopped before the lift', () => {
    const flick = run(down(at(300)), move(285, 10), move(245, 50), up(60))
    expect(last(flick).out).toMatchObject({ intent: { side: 'right' }, commit: true })
    const stopped = run(down(at(300)), move(285, 10), move(245, 50), up(200))
    expect(last(stopped).out).toMatchObject({ commit: false })
  })

  it('closes an open drawer with a drag toward its edge', () => {
    const steps = run(down(at(200), env({ open: 'left' })), move(150, 10), move(40, 200), up(300))
    expect(last(steps).out).toEqual({
      kind: 'end',
      intent: { kind: 'close', side: 'left' },
      commit: true
    })
  })

  it('measures Back against the screen width', () => {
    const steps = run(down(at(5), env({ pushed: true })), move(25, 10), move(130, 500))
    expect(steps[2].out).toMatchObject({ intent: { kind: 'back' }, progress: 125 / 393 })
    expect(
      last(run(down(at(5), env({ pushed: true })), move(25, 10), move(160, 500), up(700))).out
    ).toMatchObject({ commit: true })
  })

  it('ends a cancelled drag without a commit', () => {
    const steps = run(down(at(10)), move(30, 10), move(300, 20), { type: 'cancel' })
    expect(last(steps).out).toMatchObject({ kind: 'end', commit: false })
    expect(last(steps).state).toBe(SWIPE_IDLE)
    expect(last(run(down(at(10)), { type: 'cancel' })).out).toBeNull()
  })

  it('ignores a lift that was no drag', () => {
    expect(last(run(down(at(10)), move(12, 5), up(10))).out).toBeNull()
  })
})
