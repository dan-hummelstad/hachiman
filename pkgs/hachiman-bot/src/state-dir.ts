/**
 * The files of a bot device (`stateDir`) and of its deployment (`deploymentDir`, shared by the
 * shards on one machine). See the README of @hachiman/discord.js "Keep the state directory".
 */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BotApi } from './link'

/** The trimmed text of a file, or null when it is missing or empty. */
export const readTrimmed = (path: string): Promise<string | null> =>
  readFile(path, 'utf8').then(
    s => s.trim() || null,
    () => null,
  )

/** The wrap key of the store: 32 random bytes in `wrap.key`, made on the first start. */
export async function loadWrapKey(dir: string): Promise<CryptoKey> {
  const path = join(dir, 'wrap.key')
  let raw: Uint8Array<ArrayBuffer>
  try {
    raw = Uint8Array.from(await readFile(path))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    raw = crypto.getRandomValues(new Uint8Array(32))
    await writeFile(path, raw, { mode: 0o600, flag: 'wx' })
  }
  if (raw.length !== 32) throw new Error(`${path}: not a 32-byte key`)
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/**
 * The token of this device in `device.token`, minted with the bot token on the first start of the
 * device (contract §4 Bots "Device tokens"). `renew`: the old one stopped (a token reset).
 */
export async function loadDeviceToken(stateDir: string, bot: BotApi, renew = false): Promise<string> {
  const path = join(stateDir, 'device.token')
  const saved = renew ? null : await readTrimmed(path)
  if (saved) return saved
  const token = await bot.mintDeviceToken()
  await writeFile(path, `${token}\n`, { mode: 0o600 })
  return token
}

/**
 * The owner from the server, checked against the one pinned in `owner` on the first start (TOFU).
 * Null when they differ: then no DM approves a device.
 */
export async function pinOwner(
  deploymentDir: string,
  ownerId: string,
  log: (msg: string) => void,
): Promise<string | null> {
  const path = join(deploymentDir, 'owner')
  const pinned = await readTrimmed(path)
  if (!pinned) {
    await writeFile(path, `${ownerId}\n`, { mode: 0o600 })
    return ownerId
  }
  if (pinned === ownerId) return pinned
  log(`warning: the server names another owner than the one pinned in ${path}. Link codes by DM are off.`)
  return null
}

/**
 * One process per device: the app takes a Web Lock for its store, and a bot takes `lock` in its
 * state directory (its pid). A lock of a process that is gone is taken over. Returns the release.
 */
export async function lockStateDir(stateDir: string): Promise<() => Promise<void>> {
  const path = join(stateDir, 'lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
      return () => rm(path, { force: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const pid = Number(await readTrimmed(path))
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid))
        throw new Error(
          `process ${pid} already runs this bot device (${stateDir}). Stop it, or give this process another state directory.`,
        )
      await rm(path, { force: true })
    }
  }
  throw new Error(`could not lock ${stateDir}`)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
