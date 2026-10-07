/** The number of bars of an audio card waveform (N24). */
export const WAVEFORM_BARS = 48
/** The lowest bar, as a fraction of the highest: silence still draws a dot. */
export const WAVEFORM_FLOOR = 0.08

/**
 * Downsamples PCM channels to `bars` peaks between WAVEFORM_FLOOR and 1. Each bar is the largest
 * absolute sample of its slice over all channels, scaled so that the loudest bar is 1. Silence and
 * empty input give flat floor bars.
 */
export function downsamplePeaks(
  channels: readonly ArrayLike<number>[],
  bars: number = WAVEFORM_BARS
): number[] {
  if (bars <= 0) return []
  const length = channels.reduce((n, c) => Math.max(n, c.length), 0)
  const peaks = new Array<number>(bars).fill(0)
  if (length === 0) return peaks.fill(WAVEFORM_FLOOR)
  for (let b = 0; b < bars; b++) {
    const from = Math.floor((b * length) / bars)
    const to = Math.max(from + 1, Math.floor(((b + 1) * length) / bars))
    let peak = 0
    for (const c of channels) {
      const end = Math.min(to, c.length)
      for (let i = from; i < end; i++) {
        const v = Math.abs(c[i])
        if (v > peak) peak = v
      }
    }
    peaks[b] = peak
  }
  const max = Math.max(...peaks)
  return peaks.map((p) => (max > 0 ? Math.max(WAVEFORM_FLOOR, p / max) : WAVEFORM_FLOOR))
}

/** `0:04`, `12:30`: minutes and seconds of a playback position. */
export function formatDuration(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
