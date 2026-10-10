/** The bottom of the input sensitivity scale, dBFS. Silence reads as this. */
export const MIN_DB = -100
/** How long the gate stays open after the level drops below the threshold. */
export const HANGOVER_MS = 300

/** Auto: the threshold sits this far above the noise floor, within these bounds. */
const AUTO_MARGIN_DB = 15
const AUTO_MIN_DB = -80
const AUTO_MAX_DB = -20
const START_FLOOR_DB = -70

/** The RMS level of `buf` in dBFS, at least MIN_DB. */
export function levelDb(buf: Float32Array): number {
  let sum = 0
  for (const v of buf) sum += v * v
  const rms = Math.sqrt(sum / buf.length)
  return rms > 0 ? Math.max(MIN_DB, 20 * Math.log10(rms)) : MIN_DB
}

export interface GateSettings {
  auto: boolean
  /** The manual threshold, dBFS. Ignored while `auto`. */
  db: number
}

export interface GateStep {
  /** The level is above the threshold, or was within HANGOVER_MS. */
  open: boolean
  /** The threshold of this step, dBFS. */
  threshold: number
}

/**
 * A voice-activity gate. Feed it one level per tick. Auto tracks the noise floor: it follows a
 * quieter level fast and a louder one slowly (slower again while the gate is open, so speech
 * barely lifts it), and sets the threshold AUTO_MARGIN_DB above it.
 * ponytail: an energy gate; loud steady noise (a fan close to the mic) can still open it. A
 * speech classifier (the RNNoise VAD output) is the upgrade if that matters.
 */
export function createGate(): (db: number, now: number, s: GateSettings) => GateStep {
  let floor = START_FLOOR_DB
  let lastLoud = -Infinity
  let last = 0
  return (db, now, s) => {
    const dt = Math.min(1, last ? (now - last) / 1000 : 0)
    last = now
    const autoThreshold = Math.min(AUTO_MAX_DB, Math.max(AUTO_MIN_DB, floor + AUTO_MARGIN_DB))
    const threshold = s.auto ? autoThreshold : s.db
    if (db > threshold) lastLoud = now
    const open = now - lastLoud < HANGOVER_MS
    if (db < floor) floor += (db - floor) * Math.min(1, dt * 10)
    else floor = Math.min(db, floor + (open ? 0.5 : 3) * dt)
    return { open, threshold }
  }
}
