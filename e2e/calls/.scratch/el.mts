import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { loadPlaywright } from '../pw.mts'
import { CFG, stackEnv } from '../stack.mts'
const pw = loadPlaywright()
const bin = spawnSync('node', ['-p', "require('electron')"], { cwd: '/Users/danielhummelstad/Documents/Projects/hachiman/.claude/worktrees/docs-scope-refresh/apps/hachiman-electron', encoding: 'utf8' }).stdout.trim()
const ud = mkdtempSync(CFG.dir + '/el-')
const app = await pw._electron.launch({ executablePath: bin, args: [CFG.dir + '/electron-out/main/index.js', `--user-data-dir=${ud}`], env: { ...stackEnv(), NODE_ENV: 'production' } })
app.process().stdout?.on('data', (d) => process.stdout.write('[out] ' + d))
app.process().stderr?.on('data', (d) => process.stdout.write('[err] ' + d))
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  console.log(await app.evaluate(({ app, BrowserWindow }) => ({ ready: app.isReady(), windows: BrowserWindow.getAllWindows().length, ud: app.getPath('userData'), urls: BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()) })))
}
console.log(app.windows().length)
await app.close()
