/**
 * The delays of the automatic voice rejoin after media close 4013 (E2EE resync, §8). A room that
 * stays broken closes each new session with 4013 again, so consecutive rejoins wait longer. After
 * RESYNC_MAX_ATTEMPTS the client stops and shows an error.
 */
export const RESYNC_MAX_ATTEMPTS = 5
const RESYNC_BASE_MS = 1_000
const RESYNC_MAX_MS = 30_000

export class ResyncBackoff {
  private attempts = 0

  /** The delay before the next rejoin: 1 s, then double, at most 30 s. Null when no attempt is left. */
  next(): number | null {
    if (this.attempts >= RESYNC_MAX_ATTEMPTS) return null
    const delay = Math.min(RESYNC_MAX_MS, RESYNC_BASE_MS * 2 ** this.attempts)
    this.attempts++
    return delay
  }

  /** A call got its keys, or the user joined or left: the count starts again. */
  reset(): void {
    this.attempts = 0
  }
}
