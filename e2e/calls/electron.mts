/**
 * The Electron client of the call test: the real main process, preload and renderer (built with
 * electron-vite against the test stack, served from hachiman://app), driven with Playwright's
 * _electron.
 *
 * Sign-in needs the system browser in the real app (shell.openExternal, then the
 * app.hachiman://oauth-callback deep link). The test replaces only that hop: main's
 * shell.openExternal records the URL, a helper Chrome page signs up and passes the OIDC prompts,
 * and the bridge page's deep link goes to main's own 'open-url' handler.
 * Screen share: main's source list answers null, so the renderer takes the browser path
 * (getDisplayMedia, which the probe gives a test pattern) instead of the in-app picker, which
 * needs the macOS Screen Recording permission.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from 'playwright'

import { attachLogs, setUpDevice, type Client } from './client.mts'
import { probe } from './probe.ts'
import { loadPlaywright } from './pw.mts'
import { CFG, ROOT, TAKUSEN_URL, stackEnv } from './stack.mts'

const ELECTRON_DIR = join(ROOT, 'apps/hachiman-electron')
// Inside the app package (gitignored out/): main resolves its externalized deps from node_modules there.
const OUT = join(ELECTRON_DIR, 'out/e2ee-calls')
let built = false

function build(): void {
  if (built && existsSync(join(OUT, 'main/index.js'))) return
  const r = spawnSync(join(ELECTRON_DIR, 'node_modules/.bin/electron-vite'), ['build', '--outDir', OUT], {
    cwd: ELECTRON_DIR,
    env: { ...stackEnv(), NODE_ENV: 'production' },
    encoding: 'utf8'
  })
  if (r.status !== 0) throw new Error(`electron-vite build failed: ${r.stderr || r.stdout}`)
  built = true
}

function electronBinary(): string {
  const r = spawnSync('node', ['-p', "require('electron')"], { cwd: ELECTRON_DIR, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`electron not found: ${r.stderr}`)
  return r.stdout.trim()
}

export async function launchElectron(name: string): Promise<Client> {
  build()
  const pw = loadPlaywright()
  const userData = mkdtempSync(join(CFG.dir, 'electron-user-'))
  const app = await pw._electron.launch({
    executablePath: electronBinary(),
    args: [
      join(OUT, 'main/index.js'),
      `--user-data-dir=${userData}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required'
    ],
    env: { ...stackEnv(), NODE_ENV: 'production' }
  })
  const out = (d: Buffer): void => {
    if (process.env.E2EE_CALLS_VERBOSE === '1') process.stdout.write(`  [${name} main] ${d.toString()}`)
  }
  app.process().stdout?.on('data', out)
  app.process().stderr?.on('data', out)
  // Main-process seams: see the file comment.
  await app.evaluate(({ shell, ipcMain }) => {
    const g = globalThis as unknown as { __openedUrls: string[] }
    g.__openedUrls = []
    shell.openExternal = async (url: string) => {
      g.__openedUrls.push(url)
    }
    ipcMain.removeHandler('hachiman:screen-sources')
    ipcMain.handle('hachiman:screen-sources', () => null)
  })
  const page = await app.firstWindow()
  await page.context().addInitScript(probe, { fakeMic: false })
  // The init script applies to new documents: load the app again with it.
  await page.reload()
  attachLogs(page, name)

  let helper: { close(): Promise<void>; page: Page } | null = null
  return {
    kind: 'electron',
    name,
    page,
    signIn: async (displayName: string, signUpIn: (p: Page, displayName: string) => Promise<void>) => {
      const browser = await pw.chromium.launch({ channel: 'chrome', headless: process.env.E2EE_CALLS_HEADED !== '1' })
      const ctx = await browser.newContext()
      const hp = await ctx.newPage()
      helper = { page: hp, close: async () => void (await browser.close().catch(() => {})) }
      attachLogs(hp, `${name} helper`)
      await signUpIn(hp, displayName)
      await page.getByRole('button', { name: 'Sign in with Takusen' }).click({ timeout: 60_000 })
      const authUrl = await waitFor(() => app.evaluate(() => (globalThis as unknown as { __openedUrls: string[] }).__openedUrls.at(-1) ?? null))
      // The bridge page turns the code into the deep link (app.hachiman://oauth-callback?...).
      let deepLink: string | null = null
      await hp.goto(authUrl)
      for (let i = 0; i < 30 && deepLink === null; i++) {
        const at = new URL(hp.url())
        if (at.pathname === '/oauth/electron-bridge' && at.searchParams.has('code')) deepLink = 'app.hachiman://oauth-callback' + at.search
        else if (at.pathname.includes('/oidc/interaction/')) await hp.locator('form button[type=submit]').last().click().catch(() => {})
        if (deepLink === null) await hp.waitForTimeout(1000)
      }
      if (deepLink === null) throw new Error(`${name}: no OAuth deep link (at ${hp.url()})`)
      await app.evaluate(({ app: electronApp }, url) => {
        electronApp.emit('open-url', { preventDefault() {} }, url)
      }, deepLink)
      await setUpDevice(page)
    },
    close: async () => {
      await helper?.close()
      await app.close().catch(() => {})
    }
  }
}

async function waitFor<T>(f: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await f()
    if (v !== null) return v
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 250))
  }
}
