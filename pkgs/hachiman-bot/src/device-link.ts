/**
 * How a bot device gets its keys, and how it gives them to new devices (contract §4 Bots "Device
 * linking"). A device with no keys restores them (saved recovery key), makes them (a new bot), or
 * links to a running device of the bot with the QR link of §12.5. A running device links the new
 * devices that the deployment key vouches for, and the link codes that the pinned owner sends in a
 * DM. The bot token alone never links a device.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CryptoError, type CryptoApi, type CryptoStatus } from '@hachiman/crypto'
import { LINK_QR_PREFIX } from '@hachiman/crypto/constants'
import { ensureDeploymentKey, openLinkPayload, readDeploymentKey, sealLinkPayload, type BotApi } from './link'
import type { BotMessage } from './runtime'
import { readTrimmed } from './state-dir'

/** How often a running device looks for link requests of new devices. */
const LINK_POLL_MS = 5_000
/** A link session lives 10 minutes (§12.5): a new device opens a new one after that. */
const LINK_WAIT_MS = 10 * 60_000
/** A new device looks for the deployment key this often while it waits. */
const KEY_POLL_MS = 2_000

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export interface DeviceLinkerDeps {
  api: CryptoApi
  /** The bot user. */
  userId: string
  stateDir: string
  deploymentDir: string
  bot: BotApi
  /** The pinned owner, or null (no DM approves a device). */
  owner: string | null
  /** Connects the gateway: the link messages of a pending device come as DEVICE_LINK events. */
  connect(): Promise<void>
  reply(channelId: string, text: string): Promise<unknown>
  log(msg: string): void
}

export class DeviceLinker {
  private readonly waiters = new Map<string, (ok: boolean) => void>()
  private readonly seen = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private deploymentKey: CryptoKey | null = null

  constructor(private readonly d: DeviceLinkerDeps) {}

  /** The engine's `linkDone` event. */
  onLinkDone(sessionId: string, ok: boolean): void {
    this.waiters.get(sessionId)?.(ok)
  }

  /** A device with no identity: restore, make, or link it. Returns the ready status. */
  async onboard(status: CryptoStatus): Promise<CryptoStatus> {
    const { api, stateDir, log } = this.d
    const recoveryPath = join(stateDir, 'recovery-key.txt')
    if (status.state === 'revoked')
      throw new Error(`this bot device was revoked. Delete ${stateDir} to register a new device.`)
    if (status.state === 'ready') return status
    const saved = await readTrimmed(recoveryPath)
    if (saved) {
      log('restoring the bot identity from the saved recovery key')
      return api.restoreFromRecoveryKey(saved)
    }
    if (status.state === 'needs_identity') {
      // A first start, or the first start after the owner reset the bot's keys: resetIdentity
      // makes generation 1, or the next generation after a reset (§12.4 "Password reset"). It
      // refuses while the bot has a current master key: then this device links instead.
      try {
        const first = await api.resetIdentity()
        await writeFile(recoveryPath, `${first.recoveryKey}\n`, { mode: 0o600 })
        log(`made the bot identity. Its recovery key is in ${recoveryPath}.`)
        return first.status
      } catch (e) {
        // 'Unsupported': the bot has a current master key. 'MasterKeyExists': another shard of a
        // new bot made it first, at the same time. Either way this device links.
        const exists =
          e instanceof CryptoError && (e.code === 'Unsupported' || e.dsCode === 'MasterKeyExists')
        if (!exists) throw e
      }
    }
    return this.linkAsNewDevice()
  }

  /**
   * Opens a QR link session, gives its payload to the running devices (sealed in the link mailbox,
   * or by the owner in a DM), and waits for the transfer. A new session after each expiry.
   */
  private async linkAsNewDevice(): Promise<CryptoStatus> {
    const { api, log } = this.d
    void this.d.connect()
    for (;;) {
      const start = await api.linkAsNewDevice('qr')
      if (!start.qrPayload) throw new Error('the link session has no QR payload')
      let expiry: ReturnType<typeof setTimeout> | undefined
      const done = new Promise<boolean>(resolve => {
        this.waiters.set(start.sessionId, resolve)
        expiry = setTimeout(() => resolve(false), LINK_WAIT_MS)
      })
      const posted = this.postWhenKeyAppears(start.qrPayload, done)
      const ok = await done
      clearTimeout(expiry)
      this.waiters.delete(start.sessionId)
      await posted
      if (ok) {
        log('linked this device')
        return api.status()
      }
      await api.linkCancel(start.sessionId).catch(() => undefined)
    }
  }

  /**
   * Posts the sealed payload once `deployment.key` is there (a shard that starts with the first one
   * finds it once the first one made it). Until then, it tells how to link by hand.
   */
  private async postWhenKeyAppears(qrPayload: string, done: Promise<boolean>): Promise<void> {
    let settled = false
    void done.then(() => (settled = true))
    for (let told = false; !settled; told = true) {
      const key = await readDeploymentKey(this.d.deploymentDir)
      if (key) {
        await this.d.bot.postLinkRequest(await sealLinkPayload(key, this.d.userId, qrPayload))
        this.d.log('this bot has keys on other devices: waiting for a running device to link this one')
        return
      }
      if (!told)
        this.d.log(
          `this bot has keys on other devices, and ${join(this.d.deploymentDir, 'deployment.key')} is not here. ` +
            `Copy it from a running instance, or have the owner send the bot this code in a DM (valid 10 minutes):\n${qrPayload}`,
        )
      await sleep(KEY_POLL_MS)
    }
  }

  /** A ready device: makes or reads the deployment key, then links the vouched-for new devices. */
  async serve(): Promise<void> {
    const { key, made } = await ensureDeploymentKey(this.d.deploymentDir)
    this.deploymentKey = key
    if (made)
      this.d.log(
        `made ${join(this.d.deploymentDir, 'deployment.key')}. Copy it to each machine that runs this bot: new shards link with it.`,
      )
    this.timer = setInterval(() => void this.serveLinkRequests(), LINK_POLL_MS)
    await this.serveLinkRequests()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * A link code that the pinned owner sent in a DM: the device links, and the caller must not pass
   * the message on (it holds a link secret). True when the message was such a code.
   */
  takeOwnerLinkCode(m: BotMessage): boolean {
    const code = m.content.trim()
    if (
      m.guildId !== null ||
      this.d.owner === null ||
      m.author.id !== this.d.owner ||
      !code.startsWith(LINK_QR_PREFIX)
    )
      return false
    void this.linkDevice(code).then(name =>
      this.d
        .reply(
          m.channelId,
          name
            ? `Linked the new device "${name}".`
            : 'That link code did not work. It may have expired: start the new device again.',
        )
        .catch((e: unknown) => this.d.log(`replying to the owner failed: ${String(e)}`)),
    )
    return true
  }

  private async serveLinkRequests(): Promise<void> {
    const key = this.deploymentKey
    if (!key) return
    let requests: { id: string; blob: string }[]
    try {
      requests = await this.d.bot.linkRequests()
    } catch (e) {
      return this.d.log(`reading link requests failed: ${String(e)}`)
    }
    for (const r of requests) {
      if (this.seen.has(r.id)) continue
      this.seen.add(r.id)
      const payload = await openLinkPayload(key, this.d.userId, r.blob)
      if (payload) await this.linkDevice(payload) // else another deployment key: not ours to link
    }
  }

  private async linkDevice(payload: string): Promise<string | null> {
    try {
      const { newDeviceName } = await this.d.api.linkScan(payload)
      this.d.log(`linking a new device: ${newDeviceName}`)
      return newDeviceName
    } catch (e) {
      // Another running shard may have linked it first.
      this.d.log(`linking a new device failed: ${String(e)}`)
      return null
    }
  }
}
