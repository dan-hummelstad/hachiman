import { loadPlaywright } from '../pw.mts'
const pw = loadPlaywright()
const which = process.argv[2] ?? 'firefox'
const t0 = Date.now()
const b =
  which === 'webkit'
    ? await pw.webkit.launch({ timeout: 60_000 })
    : await pw.firefox.launch({
        timeout: 60_000,
        headless: process.env.HEADED !== '1',
        env: { ...process.env, MOZ_DISABLE_CONTENT_SANDBOX: '1', MOZ_DISABLE_GMP_SANDBOX: '1', MOZ_DISABLE_RDD_SANDBOX: '1', MOZ_DISABLE_SOCKET_PROCESS_SANDBOX: '1', MOZ_DISABLE_GPU_SANDBOX: '1', MOZ_DISABLE_UTILITY_SANDBOX: '1' },
        firefoxUserPrefs: { 'security.sandbox.content.level': 0 }
      })
console.log('launched in', Date.now() - t0)
const p = await b.newPage()
await p.goto('http://localhost:8280/healthz')
console.log(await p.evaluate(() => [typeof RTCRtpScriptTransform, navigator.userAgent]))
await b.close()
