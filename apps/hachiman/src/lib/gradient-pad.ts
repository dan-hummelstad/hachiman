import type { GradientStop } from '@/lib/guild-tint'

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
