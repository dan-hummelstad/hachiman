import { createGuild, createInvite, joinGuild, joinVoice, launch, sample, signUp, waitSecure } from '../client.mts'
import { launchElectron } from '../electron.mts'
const a = await launchElectron('A')
const b = await launch('chrome', 'B')
try {
  await signUp(a, 'Alice')
  console.log('A signed up')
  await signUp(b, 'Bob')
  await createGuild(a, 'Dbg')
  await joinGuild(b, await createInvite(a, 'Dbg'))
  await joinVoice(a)
  await waitSecure(a)
  await joinVoice(b)
  await Promise.all([waitSecure(a), waitSecure(b)])
  await new Promise((r) => setTimeout(r, 8000))
  for (const c of [a, b]) console.log(c.name, JSON.stringify(await sample(c)))
} catch (e) {
  console.log('ERR', e)
  await a.page.screenshot({ path: '/tmp/claude-501/e2ee-calls/shots/electron.png' })
} finally {
  await a.close()
  await b.close()
}
