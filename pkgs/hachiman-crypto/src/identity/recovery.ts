/** Recovery key text form and backup blobs (docs/gateway-protocol.md §12.11.3). */
import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

import { CryptoError, type BackupKindId } from '../api'
import { CodecError } from '../codec'
import { HkdfInfo, RECOVERY_KEY_BYTES, RECOVERY_KEY_PREFIX, WIRE_VERSION } from '../constants'
import { equalBytes, randomBytes, utf8 } from './bytes'
import { decodeBackupBlob, encodeBackupBlob } from './codec'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CHECKSUM_BYTES = 2
/** 34 bytes = 272 bits, plus 3 zero pad bits = 275 bits = 55 characters. */
const TEXT_CHARS = 55
const PAD_BITS = TEXT_CHARS * 5 - (RECOVERY_KEY_BYTES + CHECKSUM_BYTES) * 8

const invalid = (why: string): CryptoError => new CryptoError('InvalidRecoveryKey', why)

export function encodeRecoveryKey(rk: Uint8Array): string {
  if (rk.length !== RECOVERY_KEY_BYTES) throw new CodecError('recovery key must be 32 bytes')
  const data = new Uint8Array(RECOVERY_KEY_BYTES + CHECKSUM_BYTES)
  data.set(rk)
  data.set(sha256(rk).subarray(0, CHECKSUM_BYTES), RECOVERY_KEY_BYTES)
  let chars = ''
  let acc = 0
  let bits = 0
  for (const byte of data) {
    acc = ((acc << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) {
      bits -= 5
      chars += ALPHABET.charAt((acc >>> bits) & 31)
    }
  }
  // The 3 zero pad bits complete the last character.
  chars += ALPHABET.charAt((acc << (5 - bits)) & 31)
  const groups = chars.match(/.{5}/g) ?? []
  return [RECOVERY_KEY_PREFIX, ...groups].join('-')
}

export function parseRecoveryKey(text: string): Uint8Array {
  const compact = text.replace(/[\s-]/g, '').toUpperCase()
  if (!compact.startsWith(RECOVERY_KEY_PREFIX)) throw invalid('missing HRK1 prefix')
  const body = compact.slice(RECOVERY_KEY_PREFIX.length)
  if (body.length !== TEXT_CHARS) throw invalid(`expected ${TEXT_CHARS} characters`)
  const out = new Uint8Array(RECOVERY_KEY_BYTES + CHECKSUM_BYTES)
  let acc = 0
  let bits = 0
  let o = 0
  for (const raw of body) {
    const c = raw === 'O' ? '0' : raw === 'I' || raw === 'L' ? '1' : raw
    const v = ALPHABET.indexOf(c)
    if (v < 0) throw invalid(`invalid character ${JSON.stringify(raw)}`)
    acc = ((acc << 5) | v) & 0xffff
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >>> bits) & 0xff
    }
  }
  if (bits !== PAD_BITS || (acc & ((1 << bits) - 1)) !== 0) throw invalid('non-zero pad bits')
  const rk = out.slice(0, RECOVERY_KEY_BYTES)
  if (!equalBytes(sha256(rk).subarray(0, CHECKSUM_BYTES), out.subarray(RECOVERY_KEY_BYTES))) throw invalid('checksum mismatch')
  return rk
}

export function generateRecoveryKey(): { bytes: Uint8Array; text: string } {
  const bytes = randomBytes(RECOVERY_KEY_BYTES)
  return { bytes, text: encodeRecoveryKey(bytes) }
}

export interface BackupKeys {
  key: Uint8Array
  keyId: Uint8Array
}

export function deriveBackupKeys(recoveryKey: Uint8Array): BackupKeys {
  if (recoveryKey.length !== RECOVERY_KEY_BYTES) throw invalid('recovery key must be 32 bytes')
  const salt = new Uint8Array(0)
  return {
    key: hkdf(sha256, recoveryKey, salt, utf8(HkdfInfo.BACKUP_KEY), 32),
    keyId: hkdf(sha256, recoveryKey, salt, utf8(HkdfInfo.BACKUP_KEY_ID), 16),
  }
}

const backupAad = (kind: BackupKindId, keyId: Uint8Array): Uint8Array => {
  const aad = new Uint8Array(2 + keyId.length)
  aad[0] = WIRE_VERSION
  aad[1] = kind
  aad.set(keyId, 2)
  return aad
}

export function sealBackup(keys: BackupKeys, kind: BackupKindId, plaintext: Uint8Array): Uint8Array {
  const nonce = randomBytes(12)
  const ciphertext = gcm(keys.key, nonce, backupAad(kind, keys.keyId)).encrypt(plaintext)
  return encodeBackupBlob({ kind, keyId: keys.keyId, nonce, ciphertext })
}

/** WrongRecoveryKey for another key id or a failed tag. Malformed for a blob that does not decode. */
export function openBackup(keys: BackupKeys, blob: Uint8Array): { kind: BackupKindId; plaintext: Uint8Array } {
  let parsed
  try {
    parsed = decodeBackupBlob(blob)
  } catch (e) {
    throw new CryptoError('Malformed', `backup blob: ${(e as Error).message}`)
  }
  if (!equalBytes(parsed.keyId, keys.keyId)) throw new CryptoError('WrongRecoveryKey', 'the backup uses another recovery key')
  try {
    const plaintext = gcm(keys.key, parsed.nonce, backupAad(parsed.kind, parsed.keyId)).decrypt(parsed.ciphertext)
    return { kind: parsed.kind, plaintext }
  } catch {
    throw new CryptoError('WrongRecoveryKey', 'the backup does not open with this recovery key')
  }
}
