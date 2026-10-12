/**
 * Long press (docs/ios-mobile-ui-spec.md §2.9). A touch or a pen that holds still for the hold
 * time fires. A move past the slop, a lift, a cancel or a scroll stops it first. After a fire, the
 * click that the lift makes and a native `contextmenu` are swallowed. A mouse never long-presses.
 * `hooks/use-long-press.ts` drives this machine with timers and DOM events.
 */

/** The hold time before a press fires. */
export const LONG_PRESS_MS = 400
/** A press that moves farther than this (CSS px) is a scroll or a drag, not a long press. */
export const LONG_PRESS_SLOP = 8

/**
 * idle: no press. pressing: a finger is down and the hold timer runs. held: the press fired and
 * the finger is still down. released: the press fired and the finger lifted; the next click is
 * swallowed.
 */
export type LongPressPhase = 'idle' | 'pressing' | 'held' | 'released'

export interface LongPressState {
  phase: LongPressPhase
  /** The pointer of the press, null when idle. */
  pointerId: number | null
  /** Where the press started, in client px. */
  x: number
  y: number
}

export const LONG_PRESS_IDLE: LongPressState = { phase: 'idle', pointerId: null, x: 0, y: 0 }

export type LongPressInput =
  | { type: 'down'; pointerId: number; pointerType: string; x: number; y: number }
  | { type: 'move'; pointerId: number; x: number; y: number }
  | { type: 'up'; pointerId: number }
  /** `pointercancel`, a scroll, or the end of the click window after a release. */
  | { type: 'cancel' }
  /** The hold timer ran out. */
  | { type: 'timeout' }
  | { type: 'click' }
  | { type: 'contextmenu' }

/**
 * What the driver does after a step. startTimer and stopTimer start and stop the hold timer. fire
 * runs the long-press action. swallow calls preventDefault and stopPropagation on the event.
 */
export type LongPressEffect = 'startTimer' | 'stopTimer' | 'fire' | 'swallow' | null

export interface LongPressStep {
  state: LongPressState
  effect: LongPressEffect
}

const step = (state: LongPressState, effect: LongPressEffect = null): LongPressStep => ({
  state,
  effect
})

/** Only these pointers long-press. */
const holds = (pointerType: string): boolean => pointerType === 'touch' || pointerType === 'pen'

export function longPressStep(
  state: LongPressState,
  input: LongPressInput,
  slop: number = LONG_PRESS_SLOP
): LongPressStep {
  const { phase } = state
  switch (input.type) {
    case 'down':
      // A second finger is a pinch or a two-finger scroll, not a long press.
      if (phase === 'pressing') return step(LONG_PRESS_IDLE, 'stopTimer')
      if (phase === 'held') return step(state)
      if (!holds(input.pointerType)) return step(LONG_PRESS_IDLE)
      return step(
        { phase: 'pressing', pointerId: input.pointerId, x: input.x, y: input.y },
        'startTimer'
      )
    case 'move':
      if (phase !== 'pressing' || input.pointerId !== state.pointerId) return step(state)
      return Math.hypot(input.x - state.x, input.y - state.y) > slop
        ? step(LONG_PRESS_IDLE, 'stopTimer')
        : step(state)
    case 'up':
      if (input.pointerId !== state.pointerId) return step(state)
      if (phase === 'pressing') return step(LONG_PRESS_IDLE, 'stopTimer')
      if (phase === 'held') return step({ ...state, phase: 'released' })
      return step(state)
    case 'cancel':
      return phase === 'pressing' ? step(LONG_PRESS_IDLE, 'stopTimer') : step(LONG_PRESS_IDLE)
    case 'timeout':
      return phase === 'pressing' ? step({ ...state, phase: 'held' }, 'fire') : step(state)
    case 'click':
      return phase === 'held' || phase === 'released'
        ? step(LONG_PRESS_IDLE, 'swallow')
        : step(state)
    case 'contextmenu':
      return phase === 'idle' ? step(state) : step(state, 'swallow')
  }
}
