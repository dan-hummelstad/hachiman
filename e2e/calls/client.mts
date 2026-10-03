/**
 * One test client: a browser engine (or Electron) with one page of the Hachiman app, and the UI
 * steps of the call test. Every step goes through the real UI, as a user would.
 */
import type { Browser, BrowserContext, Page } from 'playwright'

import { probe } from './probe.ts'
import { loadPlaywright } from './pw.mts'
import { TAKUSEN_URL, WEB_URL } from './stack.mts'

export type ClientKind = 'chrome' | 'firefox' | 'webkit' | 'electron'

export interface Client {
  kind: ClientKind
  name: string
  page: Page
  /** Electron: its own sign-in hop (electron.mts). Browsers sign in on the page. */
  signIn?(displayName: string, takusenSignUp: (p: Page, displayName: string) => Promise<void>): Promise<void>
  close(): Promise<void>
}

const HEADED = process.env.E2EE_CALLS_HEADED === '1'
const CHROMIUM_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required'
]

export async function launch(kind: ClientKind, name: string): Promise<Client> {
  const pw = loadPlaywright()
  let browser: Browser | null = null
  let context: BrowserContext
  switch (kind) {
    case 'chrome':
      browser = await pw.chromium.launch({ channel: 'chrome', headless: !HEADED, args: CHROMIUM_ARGS })
      break
    case 'firefox':
      browser = await pw.firefox.launch({
        headless: !HEADED,
        firefoxUserPrefs: {
          'media.navigator.streams.fake': true,
          'media.navigator.permission.disabled': true,
          'media.autoplay.default': 0,
          'media.autoplay.blocking_policy': 0
        }
      })
      break
    case 'webkit':
      browser = await pw.webkit.launch({ headless: !HEADED })
      break
    case 'electron':
      throw new Error('use launchElectron')
  }
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  // WebKit has no fake capture devices: the probe gives it a tone.
  if (process.env.E2EE_CALLS_NO_PROBE !== '1') await context.addInitScript(probe, { fakeMic: kind === 'webkit' })
  const page = await context.newPage()
  attachLogs(page, name)
  return {
    kind,
    name,
    page,
    close: async () => {
      // A close can hang on an engine that still has a live call: do not wait more than 15 s.
      await Promise.race([browser?.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
    }
  }
}

export function attachLogs(page: Page, name: string): void {
  const verbose = process.env.E2EE_CALLS_VERBOSE === '1'
  page.on('console', (m) => {
    const t = m.type()
    if (verbose || t === 'error' || t === 'warning') console.log(`  [${name} ${t}] ${m.text().slice(0, 400)}`)
  })
  page.on('pageerror', (e) => console.log(`  [${name} pageerror] ${e.message}`))
}

// MARK: - account and guild

/** A new Takusen account, signed in on `page` (Takusen's own session). */
export async function takusenSignUp(page: Page, displayName: string): Promise<void> {
  const email = `${displayName.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@e2ee-calls.test`
  // Next dev compiles routes on first use and can answer 404 once.
  for (let i = 0; i < 10; i++) {
    await page.goto(`${TAKUSEN_URL}/signup`)
    if ((await page.locator('#displayName').count()) > 0) break
    await page.waitForTimeout(2000)
  }
  await page.fill('#displayName', displayName)
  await page.fill('#email', email)
  await page.fill('#password', 'e2ee-calls-password')
  await page.click('button[type=submit]')
  await page.waitForURL(/\/dashboard/, { timeout: 60_000 })
}

/** A new account, signed in to the app, with this device set up as the first device. */
export async function signUp(c: Client, displayName: string): Promise<void> {
  if (c.signIn) return c.signIn(displayName, takusenSignUp)
  const { page } = c
  await takusenSignUp(page, displayName)
  await page.goto(WEB_URL)
  await page.getByRole('button', { name: 'Sign in with Takusen' }).click({ timeout: 60_000 })
  await page.waitForURL((u) => u.origin === TAKUSEN_URL, { timeout: 60_000 })
  // The login and consent prompts of the OIDC provider.
  for (let i = 0; i < 20 && new URL(page.url()).origin !== WEB_URL; i++) {
    if (page.url().includes('/oidc/interaction/')) {
      await page.locator('form button[type=submit]').last().click()
    }
    await page.waitForTimeout(1000)
  }
  await setUpDevice(page)
}

export async function setUpDevice(page: Page): Promise<void> {
  // A Vite dev server can fail the first Worker load while it optimizes deps: "Try again".
  const choice = page.getByRole('button', { name: /Set up this device/ }).first()
  const retry = page.getByRole('button', { name: 'Try again' })
  for (let i = 0; i < 3; i++) {
    await choice.or(retry).first().waitFor({ timeout: 90_000 })
    if (await retry.isVisible()) {
      await page.reload()
      continue
    }
    break
  }
  await choice.click()
  await page.getByRole('button', { name: 'Set up this device', exact: true }).click()
  await page.getByLabel('I saved my recovery key in a safe place.').check({ timeout: 180_000 })
  await page.getByRole('button', { name: /^(Done|Continue|Close)/ }).last().click()
  await page.getByLabel('Create or join a guild').waitFor({ timeout: 60_000 })
}

export async function createGuild(c: Client, name: string): Promise<void> {
  const { page } = c
  await page.getByLabel('Create or join a guild').click()
  await page.getByRole('button', { name: /Create a guild/ }).click()
  await page.fill('#guild-name', name)
  await page.getByRole('button', { name: 'Create guild' }).click()
  await page.getByRole('button', { name: 'General (voice)' }).waitFor({ timeout: 60_000 })
}

export async function createInvite(c: Client, guildName: string): Promise<string> {
  const { page } = c
  await page.locator('button[aria-haspopup="menu"]', { hasText: guildName }).first().click()
  await page.getByRole('menuitem', { name: 'Invite people' }).click()
  await page.getByRole('button', { name: 'Create link' }).click()
  const input = page.locator('#invite-link')
  await page.waitForFunction(() => (document.querySelector('#invite-link') as HTMLInputElement | null)?.value, null, {
    timeout: 30_000
  })
  const link = await input.inputValue()
  await closeDialog(page)
  return link
}

export async function joinGuild(c: Client, link: string): Promise<void> {
  const { page } = c
  await page.getByLabel('Create or join a guild').click()
  await page.getByRole('button', { name: /Join with an invite/ }).click()
  await page.fill('#invite', link)
  await page.getByRole('button', { name: 'Join guild' }).click()
  await page.getByRole('button', { name: 'General (voice)' }).waitFor({ timeout: 60_000 })
}

// MARK: - voice

export async function joinVoice(c: Client): Promise<void> {
  const { page } = c
  // A double click on a voice channel joins it (channel-sidebar.tsx).
  await page.getByRole('button', { name: 'General (voice)' }).dblclick({ force: true })
  await page.getByRole('button', { name: /End-to-end encrypted|Setting up encryption/ }).first().waitFor({ timeout: 30_000 })
}

export async function leaveVoice(c: Client): Promise<void> {
  // The voice panel button: the one in the channel row sits in an aria-disabled row.
  await c.page.getByRole('button', { name: 'Disconnect' }).last().click()
  await c.page.getByLabel(/End-to-end encrypted|Setting up encryption|Reconnecting securely/).first().waitFor({ state: 'detached', timeout: 30_000 })
}

const SECURE_LABEL = 'End-to-end encrypted. Verify the call'

/** The lock of the own call shows "secure". */
export async function waitSecure(c: Client, timeoutMs = 60_000): Promise<void> {
  await c.page.getByRole('button', { name: SECURE_LABEL }).first().waitFor({ timeout: timeoutMs })
}

export interface CallCode {
  epoch: number
  code: string
}

/** The "Verify call" dialog: the epoch number and the 30-digit code. */
export async function readCallCode(c: Client): Promise<CallCode> {
  const { page } = c
  await page.getByRole('button', { name: SECURE_LABEL }).first().click()
  const section = page.getByRole('region', { name: 'Epoch code' })
  await section.locator('.font-mono').waitFor({ timeout: 30_000 })
  const text = await section.innerText()
  await closeDialog(page)
  const epoch = Number(/Epoch (\d+)/.exec(text)?.[1] ?? NaN)
  const code = text.replace(/Epoch \d+/, '').replace(/\D/g, '')
  return { epoch, code }
}

/** The safety number with `otherName`, opened from the "Verify call" participant list. */
export async function readSafetyNumber(c: Client, otherName: string): Promise<string> {
  const { page } = c
  await page.getByRole('button', { name: SECURE_LABEL }).first().click()
  const row = page.getByRole('region', { name: 'Participants' }).getByRole('listitem').filter({ hasText: otherName })
  await row.getByRole('button', { name: 'Safety number' }).click()
  const sn = page.getByLabel('Safety number', { exact: true })
  await page.waitForFunction(
    () => (document.querySelector('[aria-label="Safety number"]')?.textContent ?? '').replace(/\D/g, '').length >= 60,
    null,
    { timeout: 30_000 }
  )
  const digits = (await sn.innerText()).replace(/\D/g, '')
  await closeDialog(page)
  return digits
}

/** Closes the open dialog with its own button (Close or Done), then waits until it is gone. */
async function closeDialog(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /^(Close|Done)$/ }).first().click()
  await dialog.first().waitFor({ state: 'detached', timeout: 10_000 })
}

export async function startScreenShare(c: Client): Promise<void> {
  await c.page.getByRole('button', { name: 'Share your screen' }).first().click()
  await c.page.getByRole('button', { name: 'Stop sharing' }).first().waitFor({ timeout: 30_000 })
}

export async function stopScreenShare(c: Client): Promise<void> {
  await c.page.getByRole('button', { name: 'Stop sharing' }).first().click()
  await c.page.getByRole('button', { name: 'Share your screen' }).first().waitFor({ timeout: 30_000 })
}

// MARK: - media observations

export interface MediaSample {
  at: number
  /** Live peer connections. */
  pcs: number
  inbound: Record<'audio' | 'video', { bytes: number; packets: number; framesDecoded: number }>
  outbound: Record<'audio' | 'video', { bytes: number; packets: number }>
  /** Senders with a track, and how many of them have a transform. */
  senders: { withTrack: number; transformed: number; kinds: string[] }
  /** Receiving m-lines, and how many of their receivers have a transform. */
  receivers: { total: number; transformed: number }
  /** Sums of the transform Worker stats per role and track (every transform of this page). */
  frames: Record<string, { transforms: number; encrypted: number; decrypted: number; unknownKey: number; authFailed: number; replay: number; wrongSender: number }>
}

export function sample(c: Client): Promise<MediaSample> {
  return c.page.evaluate(async () => {
    const w = window as unknown as {
      __pcs: RTCPeerConnection[]
      __frames: { role: string; track: string; stats: null | { encrypted: number; decrypted: number; dropped: Record<string, number> } }[]
    }
    const live = w.__pcs.filter((pc) => pc.connectionState !== 'closed')
    const inbound = { audio: { bytes: 0, packets: 0, framesDecoded: 0 }, video: { bytes: 0, packets: 0, framesDecoded: 0 } }
    const outbound = { audio: { bytes: 0, packets: 0 }, video: { bytes: 0, packets: 0 } }
    let withTrack = 0
    let sTransformed = 0
    const kinds: string[] = []
    let rTotal = 0
    let rTransformed = 0
    for (const pc of live) {
      const stats = await pc.getStats()
      stats.forEach((s: Record<string, unknown>) => {
        const kind = (s.kind ?? s.mediaType) as 'audio' | 'video' | undefined
        if (kind !== 'audio' && kind !== 'video') return
        if (s.type === 'inbound-rtp') {
          inbound[kind].bytes += Number(s.bytesReceived ?? 0)
          inbound[kind].packets += Number(s.packetsReceived ?? 0)
          inbound[kind].framesDecoded += Number(s.framesDecoded ?? 0)
        } else if (s.type === 'outbound-rtp') {
          outbound[kind].bytes += Number(s.bytesSent ?? 0)
          outbound[kind].packets += Number(s.packetsSent ?? 0)
        }
      })
      for (const s of pc.getSenders()) {
        if (!s.track) continue
        withTrack++
        kinds.push(s.track.kind)
        if ((s as unknown as { transform?: unknown }).transform) sTransformed++
      }
      // Only m-lines that receive media (the upload slots are sendonly here).
      for (const t of pc.getTransceivers()) {
        if (t.currentDirection !== 'recvonly' && t.currentDirection !== 'sendrecv') continue
        rTotal++
        if ((t.receiver as unknown as { transform?: unknown }).transform) rTransformed++
      }
    }
    const frames: MediaSample['frames'] = {}
    for (const f of w.__frames) {
      const k = `${f.role}:${f.track}`
      const a = (frames[k] ??= { transforms: 0, encrypted: 0, decrypted: 0, unknownKey: 0, authFailed: 0, replay: 0, wrongSender: 0 })
      a.transforms++
      if (!f.stats) continue
      a.encrypted += f.stats.encrypted
      a.decrypted += f.stats.decrypted
      a.unknownKey += f.stats.dropped.unknownKey ?? 0
      a.authFailed += f.stats.dropped.authFailed ?? 0
      a.replay += f.stats.dropped.replay ?? 0
      a.wrongSender += f.stats.dropped.wrongSender ?? 0
    }
    return {
      at: Date.now(),
      pcs: live.length,
      inbound,
      outbound,
      senders: { withTrack, transformed: sTransformed, kinds },
      receivers: { total: rTotal, transformed: rTransformed },
      frames
    } satisfies MediaSample
  })
}

