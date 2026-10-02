import type { CryptoErrorCode } from '@hachiman/crypto'
import { errMsg } from '@/lib/utils'

/** REST error codes (§12.19) that a user can act on. */
const DS_TEXT: Record<string, string> = {
  TooManyDevices: 'Your account has 20 devices. Remove a device in Settings, then try again.',
  MasterKeyExists:
    'Your account already has a security key. Link this device from another device, or use your recovery key.',
  RateLimited: 'Too many tries. Wait a short time, then try again.',
  LinkExpired: 'The link request expired. Start again.',
  DeviceNotActive: 'This device is not active on your account.',
  InvalidRevocation: 'The server did not accept the removal.',
  WrongBackupKey: 'The backup uses a different recovery key.',
  BackupTooLarge: 'The backup is too large for the server.'
}

const CODE_TEXT: Partial<Record<CryptoErrorCode, string>> = {
  NotInitialized: 'Encryption is not ready on this device yet.',
  NoIdentity: 'This device has no security keys yet.',
  DeviceRevoked: 'This device was removed from your account.',
  SecureStorageUnavailable: 'This device cannot keep keys in safe storage.',
  StoreCorrupt: 'The key store on this device is damaged.',
  InvalidRecoveryKey: 'This is not a valid recovery key. Look for a typo.',
  WrongRecoveryKey: 'This recovery key does not open the backup of your account.',
  InvalidChain: 'A security key did not pass its checks.',
  LinkAborted: 'The link stopped.',
  LinkExpired: 'The link request expired. Start again.',
  SasMismatch: 'The emoji did not match. The link stopped and no keys were sent.',
  LockHeld: 'Hachiman is open in another tab or window. Close it there, then try again.'
}

const codeOf = (e: unknown): { code?: string; dsCode?: string } =>
  typeof e === 'object' && e !== null ? (e as { code?: string; dsCode?: string }) : {}

/** Plain text for a CryptoError (or its shape across the Worker boundary), else the message. */
export function cryptoErrorText(e: unknown): string {
  const { code, dsCode } = codeOf(e)
  if (dsCode && DS_TEXT[dsCode]) return DS_TEXT[dsCode]
  const text = code ? CODE_TEXT[code as CryptoErrorCode] : undefined
  return text ?? errMsg(e)
}

/** The CryptoErrorCode of `e`, or undefined. */
export const cryptoErrorCode = (e: unknown): string | undefined => codeOf(e).code

/** `p`, with a rejection turned into an Error with plain text (for useAction). */
export async function friendly<T>(p: Promise<T>): Promise<T> {
  try {
    return await p
  } catch (e) {
    throw new Error(cryptoErrorText(e))
  }
}
