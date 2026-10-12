import { shouldCommitDrag } from '@/lib/drag-commit'
import type { DrawerSide } from '@/lib/mobile-drawer'

/**
 * The drawer and Back swipes of the mobile shell (docs/ios-mobile-ui-spec.md §2.4). Pure: the
 * hook (`components/mobile/use-swipe.ts`) feeds it pointer input and applies what it returns.
 *
 * - A touch in the left edge zone that moves right opens the left drawer.
 * - A touch in the chat that moves left opens the right drawer.
 * - With a drawer open, a drag toward its own edge closes it.
 * - On a pushed screen only the left edge works, and it means Back.
 * - A touch in a horizontal scroller, a text field or `[data-swipe-ignore]` starts nothing.
 *
 * The axis locks after LOCK_PX: a move more sideways than AXIS_RATIO in the direction of a
 * possible swipe drags, anything else lets the page scroll. At the lift `shouldCommitDrag`
 * decides (35 % of the size or a 0.5 px/ms flick), as for the sheet handle.
 */

/** The left edge zone, before the left safe inset. */
export const EDGE_PX = 24
/** The move before the axis locks. */
export const LOCK_PX = 10
/** A sideways move must be this much larger than the vertical move. */
export const AXIS_RATIO = 1.2
/**
 * The drawer width: 320, and at least DRAWER_PEEK of the chat stays in view. 320 fits the iPhone
 * SE (375 wide, 55 of the chat in view, spec §2.12).
 */
export const DRAWER_MAX_WIDTH = 320
export const DRAWER_PEEK = 48

/** The width of a drawer in a `viewport` wide window (CSS `min(320px, 100vw - 48px)`). */
export function drawerWidth(viewport: number): number {
  return Math.max(0, Math.min(DRAWER_MAX_WIDTH, viewport - DRAWER_PEEK))
}

export type SwipeIntent =
  { kind: 'open'; side: DrawerSide } | { kind: 'close'; side: DrawerSide } | { kind: 'back' }

/** The shell when a touch starts. */
export interface SwipeEnv {
  open: DrawerSide | null
  /** A pushed screen shows: the left edge means Back, the drawers do not move. */
  pushed: boolean
  /** The right drawer has something to show (a channel or DM is open). */
  hasRight: boolean
  /** The left edge zone: EDGE_PX plus the left safe inset. */
  edge: number
  drawerWidth: number
  screenWidth: number
}

export interface SwipeStart {
  x: number
  y: number
  /** In a horizontal scroller, a text field or `[data-swipe-ignore]`. */
  ignore: boolean
  inChat: boolean
}

/** The swipes that a touch at `start` can become. */
export function swipeIntents(env: SwipeEnv, start: SwipeStart): SwipeIntent[] {
  if (start.ignore) return []
  const atEdge = start.x < env.edge
  if (env.pushed) return atEdge ? [{ kind: 'back' }] : []
  if (env.open) return [{ kind: 'close', side: env.open }]
  const out: SwipeIntent[] = []
  if (atEdge) out.push({ kind: 'open', side: 'left' })
  if (start.inChat && env.hasRight) out.push({ kind: 'open', side: 'right' })
  return out
}

/** The finger direction of a swipe: +1 to the right, -1 to the left. */
export function directionOf(intent: SwipeIntent): 1 | -1 {
  if (intent.kind === 'back') return 1
  const towardRight = intent.side === 'left' ? intent.kind === 'open' : intent.kind === 'close'
  return towardRight ? 1 : -1
}

/**
 * The open share (0–1) of the drawer that `intent` moves, at `progress` (0–1 of the way). For
 * Back, the share of the screen width that the pushed screen moved.
 */
export function openShare(intent: SwipeIntent, progress: number): number {
  return intent.kind === 'close' ? 1 - progress : progress
}

export type SwipeState =
  | { phase: 'idle' }
  | {
      phase: 'pending'
      x0: number
      y0: number
      intents: SwipeIntent[]
      drawerWidth: number
      screenWidth: number
    }
  | {
      phase: 'dragging'
      intent: SwipeIntent
      x0: number
      /** The full distance (px): the drawer width, or the screen width for Back. */
      size: number
      /** The distance (px) in the swipe's direction, 0 to `size`. */
      offset: number
      lastX: number
      lastT: number
      /** The speed (px/ms) in the swipe's direction at the last move. */
      velocity: number
    }

export const SWIPE_IDLE: SwipeState = { phase: 'idle' }

export type SwipeInput =
  | { type: 'down'; env: SwipeEnv; start: SwipeStart }
  | { type: 'move'; x: number; y: number; t: number }
  | { type: 'up'; t: number }
  | { type: 'cancel' }

export type SwipeOutput =
  | null
  /** The axis locked: capture the pointer, the surface follows the finger from here. */
  | { kind: 'lock'; intent: SwipeIntent; progress: number }
  | { kind: 'drag'; intent: SwipeIntent; progress: number }
  /** The finger lifted (or the touch was cancelled: no commit). */
  | { kind: 'end'; intent: SwipeIntent; commit: boolean }

export interface SwipeStep {
  state: SwipeState
  out: SwipeOutput
}

const clamp = (v: number, max: number): number => Math.min(max, Math.max(0, v))

const progressOf = (s: { offset: number; size: number }): number =>
  s.size > 0 ? s.offset / s.size : 0

export function swipeStep(state: SwipeState, input: SwipeInput): SwipeStep {
  switch (input.type) {
    case 'down': {
      const intents = swipeIntents(input.env, input.start)
      if (intents.length === 0) return { state: SWIPE_IDLE, out: null }
      return {
        state: {
          phase: 'pending',
          x0: input.start.x,
          y0: input.start.y,
          intents,
          drawerWidth: input.env.drawerWidth,
          screenWidth: input.env.screenWidth
        },
        out: null
      }
    }
    case 'move': {
      if (state.phase === 'idle') return { state, out: null }
      if (state.phase === 'pending') {
        const dx = input.x - state.x0
        const dy = input.y - state.y0
        if (Math.max(Math.abs(dx), Math.abs(dy)) < LOCK_PX) return { state, out: null }
        const sideways = Math.abs(dx) > AXIS_RATIO * Math.abs(dy)
        const intent = sideways
          ? state.intents.find((i) => directionOf(i) === Math.sign(dx))
          : undefined
        if (!intent) return { state: SWIPE_IDLE, out: null }
        const size = intent.kind === 'back' ? state.screenWidth : state.drawerWidth
        const next: SwipeState = {
          phase: 'dragging',
          intent,
          x0: state.x0,
          size,
          offset: clamp(directionOf(intent) * dx, size),
          lastX: input.x,
          lastT: input.t,
          velocity: 0
        }
        return { state: next, out: { kind: 'lock', intent, progress: progressOf(next) } }
      }
      const dir = directionOf(state.intent)
      const dt = input.t - state.lastT
      const next: SwipeState = {
        ...state,
        offset: clamp(dir * (input.x - state.x0), state.size),
        lastX: input.x,
        lastT: input.t,
        velocity: dt > 0 ? (dir * (input.x - state.lastX)) / dt : state.velocity
      }
      return { state: next, out: { kind: 'drag', intent: next.intent, progress: progressOf(next) } }
    }
    case 'up': {
      if (state.phase !== 'dragging') return { state: SWIPE_IDLE, out: null }
      const commit = shouldCommitDrag({
        offset: state.offset,
        size: state.size,
        velocity: state.velocity,
        msSinceLastMove: input.t - state.lastT
      })
      return { state: SWIPE_IDLE, out: { kind: 'end', intent: state.intent, commit } }
    }
    case 'cancel':
      return {
        state: SWIPE_IDLE,
        out:
          state.phase === 'dragging' ? { kind: 'end', intent: state.intent, commit: false } : null
      }
  }
}
