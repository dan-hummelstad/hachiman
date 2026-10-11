import { MAX_GRADIENT_STOPS, type CustomGradient, type GradientStop } from '@/lib/guild-tint'

/**
 * Geometry of the gradient picker (User settings → Appearance). On the pad, the angle of a stop
 * around the centre is its hue (0° to the right, clockwise as on screen) and its distance from
 * the centre is its saturation (the edge of the circle = 100%).
 */

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const DEG = 180 / Math.PI

/** The stop at offset (dx, dy) from the pad centre, for a colour circle of `radius`. */
export function stopAt(dx: number, dy: number, radius: number): GradientStop {
  const h = (Math.atan2(dy, dx) * DEG + 360) % 360
  const s = clamp(Math.hypot(dx, dy) / radius, 0, 1) * 100
  return { h: Math.round(h), s: Math.round(s) }
}

export function stopOffset({ h, s }: GradientStop, radius: number): { x: number; y: number } {
  const r = (clamp(s, 0, 100) / 100) * radius
  return { x: Math.cos(h / DEG) * r, y: Math.sin(h / DEG) * r }
}

/**
 * The stop that a press at (dx, dy) from the pad centre grabs: the nearest stop closer than
 * `reach` (`hit`), else `fallback` (the selected stop). The selected stop wins a tie, so that a
 * stop on top of another can still be grabbed. `grab` is the offset from the press to the centre
 * of the grabbed stop, so that a drag can keep it; it is zero for the fallback.
 */
export function pickStop(
  stops: readonly GradientStop[],
  dx: number,
  dy: number,
  radius: number,
  reach: number,
  fallback: number
): { index: number; hit: boolean; grab: { x: number; y: number } } {
  let index = fallback
  let hit = false
  let grab = { x: 0, y: 0 }
  let best = reach
  const order = stops.map((_, j) => j)
  if (fallback >= 0 && fallback < stops.length) order.unshift(...order.splice(fallback, 1))
  for (const j of order) {
    const o = stopOffset(stops[j], radius)
    const d = Math.hypot(o.x - dx, o.y - dy)
    if (d < best) {
      best = d
      index = j
      hit = true
      grab = { x: o.x - dx, y: o.y - dy }
    }
  }
  return { index, hit, grab }
}

/** An edit of the stops: the new gradient and the stop to select. */
export type StopEdit = { value: CustomGradient; selected: number }

/**
 * `value` with one more stop, the hue of stop `active` turned by 120°, and the new stop selected;
 * null at the limit.
 */
export function addedStop(value: CustomGradient, active: number): StopEdit | null {
  if (value.stops.length >= MAX_GRADIENT_STOPS) return null
  const base = value.stops[active] ?? value.stops[0]
  return {
    value: { ...value, stops: [...value.stops, { h: (base.h + 120) % 360, s: base.s }] },
    selected: value.stops.length
  }
}

/** `value` without stop `active`, and the stop before it selected; null when it is the last stop. */
export function withoutStop(value: CustomGradient, active: number): StopEdit | null {
  if (value.stops.length <= 1) return null
  return {
    value: { ...value, stops: value.stops.filter((_, j) => j !== active) },
    selected: Math.max(0, active - 1)
  }
}

/** The selected stop, kept in range when the stop count drops (a preset, another device). */
export function clampSelected(selected: number, count: number): number {
  return Math.max(0, Math.min(selected, count - 1))
}

/** The CSS gradient angle (0° = up, clockwise) of offset (dx, dy) from the dial centre. */
export function dialAngle(dx: number, dy: number): number {
  return Math.round((Math.atan2(dx, -dy) * DEG + 360) % 360)
}

/** A stop moved by the arrow keys: left/right turn the hue, up/down change the saturation. */
export function nudgeStop(stop: GradientStop, key: string, big: boolean): GradientStop | null {
  const step = big ? 15 : 5
  switch (key) {
    case 'ArrowLeft':
      return { ...stop, h: (stop.h - step + 360) % 360 }
    case 'ArrowRight':
      return { ...stop, h: (stop.h + step) % 360 }
    case 'ArrowUp':
      return { ...stop, s: clamp(stop.s + step, 0, 100) }
    case 'ArrowDown':
      return { ...stop, s: clamp(stop.s - step, 0, 100) }
    default:
      return null
  }
}

/** A value moved by a slider key (arrows, Page Up/Down, Home/End), or null for other keys. */
export function sliderKey(
  value: number,
  key: string,
  min: number,
  max: number,
  step: number,
  wrap = false
): number | null {
  let next: number
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      next = value - step
      break
    case 'ArrowRight':
    case 'ArrowUp':
      next = value + step
      break
    case 'PageDown':
      next = value - step * 5
      break
    case 'PageUp':
      next = value + step * 5
      break
    case 'Home':
      return min
    case 'End':
      return max
    default:
      return null
  }
  if (wrap) return ((((next - min) % (max - min)) + (max - min)) % (max - min)) + min
  return clamp(next, min, max)
}
