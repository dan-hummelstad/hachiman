/**
 * Device linking for bots (contract §4 Bots "Device linking"). A bot device that has no keys (a new
 * shard, or the bot on a new machine) does the QR link of §12.5 with a running device of the same
 * bot. Two ways carry the QR payload, and neither gives it to Takusen in the clear:
 *
 * - The deployment key: 32 random bytes in `deployment.key`, made by the first device and copied
 *   by the operator to each machine of the deployment (shards on one machine share the file). The
 *   new device seals its QR payload with it and posts it to the bot's link mailbox; a running
 *   device opens it and links. Shards come up with no owner step.
 * - The owner: without the deployment key, the new device logs its QR payload, and the owner sends
 *   it to the bot in a DM. A running device links only a payload from the owner that it pinned.
 *
 * The bot token alone links nothing: a stolen token gets no keys.
 *
 * Sealed payload: `0x01 ‖ nonce[12] ‖ AES-256-GCM(deploymentKey, qrPayload)`, AAD =
 * "hachiman-bot-link:v1:" ‖ bot user id.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const VERSION = 1
const aad = (botId: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(`hachiman-bot-link:v1:${botId}`)

export const DEPLOYMENT_KEY_FILE = 'deployment.key'

/** The deployment key of `dir`, or null when the file is not there. */
export async function readDeploymentKey(dir: string): Promise<CryptoKey | null> {
  let raw: Uint8Array<ArrayBuffer>
  try {
    raw = Uint8Array.from(await readFile(join(dir, DEPLOYMENT_KEY_FILE)))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  if (raw.length !== 32) throw new Error(`${join(dir, DEPLOYMENT_KEY_FILE)}: not a 32-byte key`)
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** Reads the deployment key, or makes it (a device with keys, the first of the deployment). */
export async function ensureDeploymentKey(dir: string): Promise<{ key: CryptoKey; made: boolean }> {
  const existing = await readDeploymentKey(dir)
  if (existing) return { key: existing, made: false }
  try {
    await writeFile(join(dir, DEPLOYMENT_KEY_FILE), crypto.getRandomValues(new Uint8Array(32)), {
      mode: 0o600,
      flag: 'wx',
    })
  } catch (e) {
    // Another shard on this machine made it first: use theirs.
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
  const key = await readDeploymentKey(dir)
  if (!key) throw new Error('the deployment key was not written')
  return { key, made: true }
}

export async function sealLinkPayload(key: CryptoKey, botId: string, payload: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(botId) },
    key,
    new TextEncoder().encode(payload),
  )
  return Buffer.concat([Buffer.from([VERSION]), iv, Buffer.from(ct)]).toString('base64url')
}

/** The QR payload, or null when another deployment key sealed it. */
export async function openLinkPayload(key: CryptoKey, botId: string, blob: string): Promise<string | null> {
  const bytes = Uint8Array.from(Buffer.from(blob, 'base64url'))
  if (bytes[0] !== VERSION || bytes.length < 13 + 16) return null
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(1, 13), additionalData: aad(botId) },
      key,
      bytes.slice(13),
    )
    return new TextDecoder().decode(pt)
  } catch {
    return null
  }
}

/** The bot routes of Takusen (§4 Bots) with the bot token. */
export type BotApi = ReturnType<typeof botApi>

export function botApi(apiUrl: string, token: string) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch(`${apiUrl}/users/@me/bot${path}`, { ...init, headers })
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} /users/@me/bot${path}: ${res.status}`)
    return (await res.json()) as T
  }
  return {
    owner: () => call<{ ownerId: string }>('').then(r => r.ownerId),
    linkRequests: () => call<{ id: string; blob: string }[]>('/link-requests'),
    postLinkRequest: (blob: string) =>
      call<{ id: string }>('/link-requests', { method: 'POST', body: JSON.stringify({ blob }) }),
    /** Only the owner-issued bot token may mint (contract §4 Bots "Device tokens"). */
    mintDeviceToken: () =>
      call<{ token: string }>('/device-tokens', { method: 'POST', body: '{}' }).then(r => r.token),
  }
}
