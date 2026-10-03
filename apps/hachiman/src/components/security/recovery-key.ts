/**
 * Typo-tolerant input of the recovery key (§12.11.3). The Worker parses the key again
 * (CryptoApi.restoreFromRecoveryKey). This check only tells the user early which part is wrong.
 *
 * The rules are those of the Worker parser: spaces and `-` are removed, the `HRK1` prefix is
 * accepted in any case, lowercase becomes uppercase, and the only aliases are O → 0 and I, L → 1.
 * Every other character outside the Crockford alphabet (U included) is an error.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const PREFIX = 'HRK1'
export const RECOVERY_KEY_CHARS = 55
const KEY_BYTES = 32
const CHECKSUM_BYTES = 2

export type RecoveryKeyCheck =
  | { ok: true; text: string }
  | {
      ok: false
      reason: 'empty' | 'incomplete' | 'too_long' | 'bad_char' | 'checksum'
      detail: string
    }

/** Removes the separators and the prefix, applies the aliases. Keeps unknown characters. */
export function recoveryKeyBody(input: string): string {
  const s = input.replace(/[\s-]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1')
  // A full key without the prefix can start with "HRK1" by chance: then keep all 55 characters.
  return s.startsWith(PREFIX) && s.length !== RECOVERY_KEY_CHARS ? s.slice(PREFIX.length) : s
}

/** The canonical text form: `HRK1-` and 11 groups of 5. */
export function formatRecoveryKey(body: string): string {
  return [PREFIX, ...(body.match(/.{1,5}/g) ?? [])].join('-')
}

/** Synchronous part of the check: characters and length. */
export function checkRecoveryKeyShape(input: string): RecoveryKeyCheck {
  const body = recoveryKeyBody(input)
  if (body.length === 0)
    return { ok: false, reason: 'empty', detail: 'Type or paste your recovery key.' }
  const bad = [...body].findIndex((c) => !ALPHABET.includes(c))
  if (bad >= 0) {
    const c = body[bad]!
    return {
      ok: false,
      reason: 'bad_char',
      detail:
        c === 'U'
          ? `Character ${bad + 1} is "U". Recovery keys do not use the letter U. Look at that character again.`
          : `Character ${bad + 1} ("${c}") is not used in recovery keys.`
    }
  }
  if (body.length < RECOVERY_KEY_CHARS)
    return {
      ok: false,
      reason: 'incomplete',
      detail: `${body.length} of ${RECOVERY_KEY_CHARS} characters.`
    }
  if (body.length > RECOVERY_KEY_CHARS)
    return {
      ok: false,
      reason: 'too_long',
      detail: `The key has ${body.length - RECOVERY_KEY_CHARS} characters too many.`
    }
  return { ok: true, text: formatRecoveryKey(body) }
}

/** The 34 bytes (key and checksum) of a 55-character body, or null when the pad bits are not zero. */
export function decodeRecoveryKeyBody(body: string): Uint8Array | null {
  const out = new Uint8Array(KEY_BYTES + CHECKSUM_BYTES)
  let acc = 0
  let bits = 0
  let o = 0
  for (const c of body) {
    const v = ALPHABET.indexOf(c)
    if (v < 0) return null
    acc = ((acc << 5) | v) & 0xffff
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >>> bits) & 0xff
    }
  }
  if (o !== out.length || (acc & ((1 << bits) - 1)) !== 0) return null
  return out
}

/**
 * The full check: shape, pad bits and the 2-byte SHA-256 checksum. A checksum mismatch means a
 * typo. A key that passes can still be the wrong key (the Worker answers WrongRecoveryKey).
 */
export async function checkRecoveryKey(input: string): Promise<RecoveryKeyCheck> {
  const shape = checkRecoveryKeyShape(input)
  if (!shape.ok) return shape
  const bytes = decodeRecoveryKeyBody(recoveryKeyBody(input))
  const mismatch: RecoveryKeyCheck = {
    ok: false,
    reason: 'checksum',
    detail: 'The key has a typo. Compare each group with your saved key.'
  }
  if (!bytes) return mismatch
  const key = bytes.slice(0, KEY_BYTES)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', key))
  key.fill(0)
  const ok = digest[0] === bytes[KEY_BYTES] && digest[1] === bytes[KEY_BYTES + 1]
  bytes.fill(0)
  return ok ? shape : mismatch
}
