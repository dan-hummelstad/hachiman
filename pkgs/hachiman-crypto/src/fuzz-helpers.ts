/**
 * Shared helpers of the *.fuzz.spec.ts property tests (docs/e2ee-audit-scope.md §6).
 * Test-only: no package export imports this file.
 *
 * FUZZ_RUNS=<n> multiplies every numRuns, so a long local run is
 * `FUZZ_RUNS=50 pnpm -F @hachiman/crypto test fuzz`.
 */
import fc from 'fast-check'

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const factor = Math.max(1, Number.parseInt(env['FUZZ_RUNS'] ?? '1', 10) || 1)

/** numRuns scaled by FUZZ_RUNS. */
export const runs = (n: number): { numRuns: number } => ({ numRuns: n * factor })

/** Up to `max` (index, value) byte overwrites. */
export const edits = (max = 6): fc.Arbitrary<[number, number][]> => fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: max })

/** Applies byte overwrites (indexes mod length), then an optional truncation or an appended tail. */
export function mutate(b: Uint8Array, changes: readonly [number, number][], cut: number | null = null, tail: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = b.slice()
  if (out.length > 0) for (const [i, v] of changes) out[i % out.length] = v
  const cutOut = cut === null ? out : out.subarray(0, cut % (out.length + 1))
  const r = new Uint8Array(cutOut.length + tail.length)
  r.set(cutOut)
  r.set(tail, cutOut.length)
  return r
}

/** A mutation that changes at least one byte: one XOR flip (never 0) plus optional extra edits. */
export const flip = fc.tuple(fc.nat(), fc.integer({ min: 1, max: 255 }))
export function flipped(b: Uint8Array, [i, x]: [number, number]): Uint8Array {
  const out = b.slice()
  out[i % out.length]! ^= x
  return out
}

/**
 * Runs fn. Returns its value, or undefined when it threw one of the allowed error classes.
 * Any other throw fails the property: a parser must fail closed with a typed error.
 */
export function only<T>(fn: () => T, ...allowed: (abstract new (...args: never[]) => Error)[]): T | undefined {
  try {
    return fn()
  } catch (e) {
    if (allowed.some((C) => e instanceof C)) return undefined
    throw e
  }
}
