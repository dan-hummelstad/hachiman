/**
 * Phase 3 load test (docs/gateway-protocol.md §12.7.8): a public_set group that grows to N leaves.
 * Opt-in, not part of `vitest run`:
 *
 *   cd pkgs/hachiman-crypto && LOAD_N=1000 LOAD_CHURN=20 LOAD_REPLAY=20 node_modules/.bin/vitest bench --run src/mls/load.bench.ts
 *
 * It measures commit size, ratchet tree bytes, the processing time of one commit at a member
 * under churn, commits per second, and the catch-up time of a joiner (decode the tree, join with
 * the chain check of every leaf, replay K handshakes). It prints a table and a recommendation
 * for PUBLIC_SET_MAX_MEMBERS. Adds go by value, so DS proposal signing is not in the numbers.
 */
import { bench, describe } from 'vitest'

import type { GroupDescriptor, MlsGroupHandle, ProposalPolicy } from '../api'
import { fromB64url } from '../codec'
import { BATCH_MAX_ADDS, PUBLIC_SET_MAX_MEMBERS } from '../constants'
import { mls } from './index'
import { dsSigner, keyPackage, makeDevice, makeUser, policy, uuid, type TestDevice } from './test-helpers'

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const N = Math.min(10_000, Math.max(10, Number(env['LOAD_N'] ?? 1000)))
const CHURN = Math.max(1, Number(env['LOAD_CHURN'] ?? 20))
const REPLAY = Math.max(1, Number(env['LOAD_REPLAY'] ?? 20))
/** Budgets for the recommendation: one commit at a member, the joiner catch-up, the tree download. */
const BUDGET = { processMs: 250, joinMs: 10_000, treeBytes: 8 * 1024 * 1024 }

interface Row {
  leaves: number
  commitBytes: number
  welcomeBytes: number
  treeBytes: number
  createMs: number
  processMs: number
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now()
  const r = await fn()
  return [r, performance.now() - t]
}

async function apply(h: MlsGroupHandle, commit: string, p: ProposalPolicy): Promise<MlsGroupHandle> {
  const r = await mls.processHandshake(h, fromB64url(commit), p)
  if (r.result !== 'applied') throw new Error(`member rejected the commit: ${r.result === 'rejected' ? r.reason : r.result}`)
  return r.handle
}

function row(pc: Awaited<ReturnType<typeof mls.commit>>, createMs: number, processMs: number): Row {
  return {
    leaves: mls.roster(pc.next).length,
    commitBytes: fromB64url(pc.request.commit).length,
    welcomeBytes: pc.request.welcome === null ? 0 : fromB64url(pc.request.welcome).length,
    treeBytes: fromB64url(pc.request.ratchetTree).length,
    createMs,
    processMs,
  }
}

async function run(): Promise<void> {
  const signer = await dsSigner()
  const devices: TestDevice[] = Array.from({ length: N + CHURN + REPLAY }, () => makeDevice(makeUser()))
  // One mutable reader set: a churned-out member loses access, so a Remove by value is allowed.
  const readers = new Set(devices.map((d) => d.user.userId))
  const p: ProposalPolicy = { ...policy({ kind: 'public_set', users: devices.map((d) => d.user), dsKey: signer.publicKey }), readers }
  const [committer, observer, ...rest] = devices as [TestDevice, TestDevice, ...TestDevice[]]
  const guildId = uuid()
  const descriptor: GroupDescriptor = { kind: 'public_set', guildId, channelId: null, historyVisibility: 'shared', createdByUserId: committer.user.userId }
  const created = await mls.createGroup({ groupId: mls.groupId({ kind: 'public_set', scope: guildId, generation: 0 }), descriptor, dsExternalSender: signer.externalSender, cipherSuite: 1, keyPackage: await keyPackage(committer) })
  const okp = await keyPackage(observer)
  const first = await mls.commit(created.handle, { adds: [okp.publicPackage], removes: [], descriptor: null, policy: p })
  let ch = first.next
  let oh = await mls.joinFromWelcome({ welcome: fromB64url(first.request.welcome!), ratchetTree: fromB64url(first.request.ratchetTree), keyPackage: okp, policy: p })

  // Growth in batches of BATCH_MAX_ADDS.
  const growth: Row[] = []
  const members = rest.slice(0, N - 2)
  for (let i = 0; i < members.length; i += BATCH_MAX_ADDS) {
    const kps = await Promise.all(members.slice(i, i + BATCH_MAX_ADDS).map((d) => keyPackage(d)))
    const [pc, createMs] = await timed(() => mls.commit(ch, { adds: kps.map((k) => k.publicPackage), removes: [], descriptor: null, policy: p }))
    const [next, processMs] = await timed(() => apply(oh, pc.request.commit, p))
    ch = pc.next
    oh = next
    growth.push(row(pc, createMs, processMs))
  }

  // Churn at N: each commit removes one member and adds one. The device added in round CHURN - 1
  // is the joiner; it replays the REPLAY commits after it.
  const churn: Row[] = []
  const spare = rest.slice(N - 2)
  let joiner: { welcome: string; tree: string; kp: Awaited<ReturnType<typeof keyPackage>>; commits: string[] } | null = null
  const t0 = performance.now()
  for (let i = 0; i < CHURN + REPLAY; i++) {
    const roster = mls.roster(ch)
    const victim = roster[2 + (i % (roster.length - 2))]!
    readers.delete(victim.userId)
    const kp = await keyPackage(spare[i]!)
    const [pc, createMs] = await timed(() => mls.commit(ch, { adds: [kp.publicPackage], removes: [victim.leafIndex], descriptor: null, policy: p }))
    const [next, processMs] = await timed(() => apply(oh, pc.request.commit, p))
    ch = pc.next
    oh = next
    if (i === CHURN - 1) joiner = { welcome: pc.request.welcome!, tree: pc.request.ratchetTree, kp, commits: [] }
    else if (joiner !== null) joiner.commits.push(pc.request.commit)
    if (i < CHURN) churn.push(row(pc, createMs, processMs))
  }
  const commitsPerSecond = (CHURN + REPLAY) / ((performance.now() - t0) / 1000)

  // Joiner catch-up: decode the tree, join with the chain check of every leaf, replay K handshakes.
  const w = joiner!
  const [joined, joinMs] = await timed(() => mls.joinFromWelcome({ welcome: fromB64url(w.welcome), ratchetTree: fromB64url(w.tree), keyPackage: w.kp, policy: p }))
  let jh = joined
  const [, replayMs] = await timed(async () => {
    for (const c of w.commits) jh = await apply(jh, c, p)
  })

  const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
  const kb = (n: number): string => `${(n / 1024).toFixed(1)} KiB`
  const ms = (n: number): string => `${n.toFixed(1)} ms`
  const lines: string[] = [`public_set load test: N=${N}, churn commits=${CHURN}, replay K=${REPLAY}`, '', '| leaves | commit | welcome | ratchet tree | create | process at member |', '|---|---|---|---|---|---|']
  const step = Math.max(1, Math.floor(growth.length / 10))
  for (const [i, r] of growth.entries()) {
    if (i % step === 0 || i === growth.length - 1) lines.push(`| ${r.leaves} | ${kb(r.commitBytes)} | ${kb(r.welcomeBytes)} | ${kb(r.treeBytes)} | ${ms(r.createMs)} | ${ms(r.processMs)} |`)
  }
  const last = churn.at(-1)!
  const processAvg = avg(churn.map((r) => r.processMs))
  lines.push('', `Churn at ${last.leaves} leaves (1 Remove + 1 Add per commit):`)
  lines.push(`  commit ${kb(avg(churn.map((r) => r.commitBytes)))}, welcome ${kb(avg(churn.map((r) => r.welcomeBytes)))}, tree ${kb(last.treeBytes)}`)
  lines.push(`  create ${ms(avg(churn.map((r) => r.createMs)))}, process at member ${ms(processAvg)}, ${commitsPerSecond.toFixed(2)} commits/s (create + process)`)
  lines.push(`Joiner catch-up: tree ${kb(fromB64url(w.tree).length)}, join with chain checks ${ms(joinMs)}, replay ${w.commits.length} handshakes ${ms(replayMs)} (${ms(replayMs / Math.max(1, w.commits.length))} each)`)

  // Linear extrapolation per leaf, then the smallest limit over the three budgets.
  const leaves = last.leaves
  const limits = {
    process: Math.floor(BUDGET.processMs / (processAvg / leaves)),
    join: Math.floor(BUDGET.joinMs / (joinMs / leaves)),
    tree: Math.floor(BUDGET.treeBytes / (last.treeBytes / leaves)),
  }
  const min = Math.min(limits.process, limits.join, limits.tree)
  const unit = min >= 1000 ? 1000 : 100
  const rec = Math.max(100, Math.floor(min / unit) * unit)
  lines.push('', `Budgets: process ${BUDGET.processMs} ms per commit, join ${BUDGET.joinMs} ms, tree ${kb(BUDGET.treeBytes)}.`)
  lines.push(`Extrapolated limits: process ${limits.process}, join ${limits.join}, tree ${limits.tree} leaves.`)
  lines.push(`Recommendation: PUBLIC_SET_MAX_MEMBERS = ${rec} (current default ${PUBLIC_SET_MAX_MEMBERS}).`)
  console.log(lines.join('\n'))
}

describe('public_set load', () => {
  bench(`grow to ${N} leaves, churn, joiner catch-up`, run, { iterations: 1, warmupIterations: 0, time: 0, warmupTime: 0 })
})
