/**
 * The DS and KT signing seeds (§12.7.1, §12.14).
 *
 * Both Takusen processes (Next and gRPC) load the same seed files. When a file
 * is missing, a process creates it exclusively (mode 0600) and then reads the
 * file again. Two processes that start together therefore use the one key that
 * won the create. A deployment with more than one Takusen instance shares the
 * files.
 */
import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto'
import { closeSync, constants, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

const SEED_BYTES = 32

/**
 * Returns the 32-byte seed at `path`, creating it first when it is missing.
 * The new seed goes to a private temp file (O_EXCL, 0600), and `link` puts it
 * at `path` only when no file is there yet. Thus no reader sees a partial file,
 * and the loser of a race reads the winner's key.
 */
export function loadOrCreateSeed(path: string, random: () => Uint8Array = () => randomBytes(SEED_BYTES)): Uint8Array {
  try {
    return readSeed(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    const seed = random()
    if (seed.length !== SEED_BYTES) throw new Error('seed must be 32 bytes')
    writeSync(fd, seed)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    linkSync(tmp, path)
  } catch (err) {
    // EEXIST: another process created the file first. Its key wins.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  } finally {
    unlinkSync(tmp)
  }
  return readSeed(path)
}

function readSeed(path: string): Uint8Array {
  const bytes = readFileSync(path)
  if (bytes.length !== SEED_BYTES) {
    // A damaged file is fatal: never replace a key silently.
    throw new Error(`${path}: expected a ${SEED_BYTES}-byte Ed25519 seed, got ${bytes.length} bytes`)
  }
  return new Uint8Array(bytes)
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/** The Ed25519 public key of a raw seed (the KT public key for GET /mls/ds). */
export function ed25519PublicKey(seed: Uint8Array): Uint8Array {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' })
  const jwk = createPublicKey(key).export({ format: 'jwk' })
  if (typeof jwk.x !== 'string') throw new Error('no public key')
  return new Uint8Array(Buffer.from(jwk.x, 'base64url'))
}
