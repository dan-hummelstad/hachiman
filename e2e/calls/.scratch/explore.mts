import { loadPlaywright } from '../pw.mts'
const { chromium } = loadPlaywright()
const shots = '/tmp/claude-501/e2ee-calls/shots'
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
const ctx = await b.newContext()
const page = await ctx.newPage()
page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.request().method(), r.url().slice(0, 200)) })
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 300)))
const email = `a${Date.now()}@test.local`
for (let i = 0; i < 5; i++) { await page.goto('http://localhost:3200/signup'); if (await page.locator('#displayName').count()) break; await page.waitForTimeout(2000) }
await page.fill('#displayName', 'Alice')
await page.fill('#email', email)
await page.fill('#password', 'password1234')
await page.click('button[type=submit]')
await page.waitForURL(/dashboard/, { timeout: 60000 })
await page.goto('http://localhost:5273/')
await page.getByRole('button', { name: 'Sign in with Takusen' }).click()
await page.waitForURL(/localhost:3200/)
for (let i = 0; i < 10 && !page.url().startsWith('http://localhost:5273'); i++) {
  if (page.url().includes('/oidc/interaction/')) { await page.screenshot({ path: shots + '/i' + i + '.png' }); await page.locator('form button[type=submit]').last().click(); }
  await page.waitForTimeout(2000)
}
console.log('after oidc', page.url())
await page.getByRole('button', { name: /Set up this device/ }).first().click({ timeout: 60000 })
await page.getByRole('button', { name: 'Set up this device', exact: true }).click()
await page.getByLabel('I saved my recovery key in a safe place.').check({ timeout: 60000 })
await page.screenshot({ path: shots + '/2.png' })
await page.locator('button:not([disabled])', { hasText: /Done|Continue|Close/ }).last().click()
await page.getByLabel('Create or join a guild').click()
await page.getByRole('button', { name: /Create a guild/ }).click()
await page.fill('#guild-name', 'Calls')
await page.getByRole('button', { name: 'Create guild' }).click()
await page.waitForTimeout(6000)
await page.screenshot({ path: shots + '/3.png' })
await b.close()
