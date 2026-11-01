/**
 * Remote cursors arrive at most every AWARENESS_MS (DocAwareness.ts). Drawn as they arrive they
 * jump, so each one glides through its points on a Catmull-Rom spline instead, one segment per
 * frame interval, as Miro and perfect-cursors do. The cursor shows one interval behind the sender.
 */
export interface Point {
  x: number
  y: number
}

interface Segment {
  from: Point
  to: Point
  ms: number
}

/** Shortest and longest time for one segment: a fast burst or a pause between frames. */
const MIN_MS = 16
const MAX_MS = 500
/** More queued segments than this means the cursor fell behind: it drops the oldest. */
const MAX_QUEUE = 3

export class SmoothCursor {
  private segments: Segment[] = []
  private before: Point | null = null
  private last: Point | null = null
  private lastAt = 0
  private segmentStart = 0
  private shown: Point | null = null

  /** A new position from the network at time `now` (ms). */
  push(p: Point, now: number): void {
    if (!this.last) {
      this.last = this.shown = p
      this.lastAt = now
      return
    }
    const ms = Math.min(MAX_MS, Math.max(MIN_MS, now - this.lastAt))
    if (this.segments.length === 0) this.segmentStart = now
    this.segments.push({ from: this.last, to: p, ms })
    while (this.segments.length > MAX_QUEUE) {
      this.before = this.segments.shift()!.from
      this.segmentStart = now
    }
    this.last = p
    this.lastAt = now
  }

  /** The position to draw at time `now`, and whether it still moves. */
  at(now: number): { point: Point | null; moving: boolean } {
    while (this.segments.length > 0) {
      const seg = this.segments[0]!
      const t = (now - this.segmentStart) / seg.ms
      if (t < 1) {
        const p0 = this.before ?? seg.from
        const p3 = this.segments[1]?.to ?? seg.to
        this.shown = catmullRom(p0, seg.from, seg.to, p3, Math.max(0, t))
        return { point: this.shown, moving: true }
      }
      this.segmentStart += seg.ms
      this.before = seg.from
      this.segments.shift()
      this.shown = seg.to
    }
    return { point: this.shown, moving: false }
  }
}

/** The point at `t` (0..1) between p1 and p2 of a uniform Catmull-Rom spline. */
export function catmullRom(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const t2 = t * t
  const t3 = t2 * t
  const f = (a: number, b: number, c: number, d: number): number =>
    0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3)
  return { x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) }
}
