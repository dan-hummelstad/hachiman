import { launch, takusenSignUp } from '../client.mts'
import { WEB_URL, TAKUSEN_URL } from '../stack.mts'
const a = await launch('chrome', 'A')
const page = a.page
page.on('requestfailed', (r) => console.log('REQFAIL', r.method(), r.url(), r.failure()?.errorText))
page.on('response', (r) => { if (r.status() >= 400) console.log('RESP', r.status(), r.request().method(), r.url()) })
try {
  await takusenSignUp(page, 'Dbg' + Date.now())
  await page.goto(WEB_URL)
  await page.getByRole('button', { name: 'Sign in with Takusen' }).click({ timeout: 60_000 })
  await page.waitForURL((u) => u.origin === TAKUSEN_URL, { timeout: 60_000 })
  for (let i = 0; i < 20 && new URL(page.url()).origin !== WEB_URL; i++) {
    if (page.url().includes('/oidc/interaction/')) await page.locator('form button[type=submit]').last().click()
    await page.waitForTimeout(1000)
  }
  await page.waitForTimeout(8000)
  console.log('BODY1', (await page.locator('body').innerText()).slice(0, 800))
  await page.getByRole('button', { name: /Set up this device/ }).first().click()
  await page.waitForTimeout(2000)
  console.log('BODY2', (await page.locator('body').innerText()).slice(0, 800))
  await page.getByRole('button', { name: 'Set up this device', exact: true }).click()
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(2000)
    console.log('BODY3.' + i, (await page.locator('body').innerText()).slice(0, 500))
  }
  await page.screenshot({ path: '/tmp/claude-501/t7/3.png' })
} finally {
  await a.close()
}
