/**
 * A soft bell note sequence on Web Audio: the friendly two- and three-note voice sounds. Each note
 * is a sine with a quiet octave on top, a 5 ms attack and an exponential fade.
 */
export interface Chime {
  /** [frequency in Hz, start in seconds] per note. */
  notes: readonly (readonly [hz: number, at: number])[]
  /** Fade length per note, in seconds. Default 0.4. */
  decay?: number
  /** Loudness relative to the other chimes. Default 1. */
  gain?: number
}

const PEAK = 0.18
let ctx: AudioContext | null = null

export function playChime({ notes, decay = 0.4, gain = 1 }: Chime, volume: number): void {
  if (typeof AudioContext === 'undefined') return
  ctx ??= new AudioContext()
  const ac = ctx
  if (ac.state === 'suspended') void ac.resume()
  const peak = PEAK * gain * volume
  if (peak <= 0) return
  const t0 = ac.currentTime + 0.01
  for (const [hz, at] of notes) {
    const start = t0 + at
    const env = ac.createGain()
    env.gain.setValueAtTime(0.0001, start)
    env.gain.exponentialRampToValueAtTime(peak, start + 0.005)
    env.gain.exponentialRampToValueAtTime(0.0001, start + decay)
    env.connect(ac.destination)
    for (const [mult, level] of [
      [1, 1],
      [2, 0.12]
    ] as const) {
      const osc = ac.createOscillator()
      const g = ac.createGain()
      osc.frequency.value = hz * mult
      g.gain.value = level
      osc.connect(g).connect(env)
      osc.start(start)
      osc.stop(start + decay + 0.02)
    }
  }
}
