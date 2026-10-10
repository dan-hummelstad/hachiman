import { describe, expect, it } from 'vitest'
import { HANGOVER_MS, createGate, levelDb, type GateStep } from '@/lib/input-sensitivity'

const run = (
  gate: ReturnType<typeof createGate>,
  db: number,
  from: number,
  ms: number
): GateStep => {
  let step = gate(db, from, { auto: true, db: 0 })
  for (let t = from + 20; t <= from + ms; t += 20) step = gate(db, t, { auto: true, db: 0 })
  return step
}

describe('input sensitivity', () => {
  it('measures dBFS', () => {
    expect(levelDb(new Float32Array(8).fill(1))).toBeCloseTo(0)
    expect(levelDb(new Float32Array(8))).toBe(-100)
  })

  it('manual: opens above the threshold and holds for the hangover', () => {
    const gate = createGate()
    const s = { auto: false, db: -50 }
    expect(gate(-60, 1000, s).open).toBe(false)
    expect(gate(-40, 1020, s).open).toBe(true)
    expect(gate(-60, 1020 + HANGOVER_MS - 1, s).open).toBe(true)
    expect(gate(-60, 1020 + HANGOVER_MS, s).open).toBe(false)
  })

  it('auto: learns the noise floor, then opens on speech above it', () => {
    const gate = createGate()
    // Steady room noise at -55 dB: after a while the gate closes on it.
    expect(run(gate, -55, 1000, 20_000).open).toBe(false)
    // Speech 20 dB above the noise opens it.
    expect(gate(-35, 21_020, { auto: true, db: 0 }).open).toBe(true)
  })
})
