/**
 * Phase 3 load test (docs/e2ee-plan.md "Verification", docs/gateway-protocol.md §12.7.8):
 * a public_set group at 1k to 10k leaves under churn, with the real `mls` and `ds` modules over
 * ts-mls. Results and the cap decision: docs/e2ee-load-test.md. Opt-in, not part of `vitest run`:
 *
 *   cd pkgs/hachiman-crypto
 *   LOAD_SIZES=1000,2000 LOAD_ROUNDS=3 node_modules/.bin/vitest bench --run --execArgv=--expose-gc src/mls/load.bench.ts
 *
 * ts-mls 1.6.4 cannot encode a group of more than 2048 leaves with the default V8 stack (its
 * vector encoder recurses once per element). For larger sizes, raise the stack:
 *
 *   ulimit -s 65520 && LOAD_SIZES=1000,2000,5000,10000 LOAD_ROUNDS=3 node_modules/.bin/vitest bench --run \
 *     --execArgv=--expose-gc --execArgv=--stack-size=60000 --execArgv=--max-old-space-size=16384 src/mls/load.bench.ts
 *
 * Variables: LOAD_SIZES (checkpoints, default 1000), LOAD_ROUNDS (steady batches per checkpoint,
 * default 5), LOAD_JOINS and LOAD_LEAVES (items per steady batch, default 2 and 2: one join and
 * one leave per second at the 2 s batch interval), LOAD_ADOPT_EXTERNAL (1 keeps the external
 * joiner in the group; see step 1 below), LOAD_MODE=join (only the committer keeps state, and each
 * checkpoint only times a join by external commit and a join by Welcome, in a small heap).
 *
 * One process holds all leaves. The committer (leaf 0) and one observer member (leaf 1) keep
 * their state the whole run.
 * - Growth to a checkpoint uses Adds by value in commits of BATCH_MAX_ADDS. The tree that results
 *   is the same as from DS Add proposals: every added leaf is unmerged until it commits itself.
 * - At each checkpoint, the run measures the real paths of §12.7.4 and §12.7.5:
 *   1. a joiner by external commit (`joinExternal`, with the chain check of every leaf);
 *   2. LOAD_ROUNDS steady batches. The DS signs one proposal per item (`ds.proposeAdd`,
 *      `ds.proposeRemove`). The committer stores each proposal, checks it (`checkStoredProposal`)
 *      and commits by reference. Takusen runs `ds.checkCommit`, and the observer processes the
 *      proposals and the commit. The first batch also times a joiner by Welcome (`joinFromWelcome`);
 *   3. one full batch of BATCH_MAX_ADDS DS Add proposals;
 *   4. catch-up: the observer state from the start of the checkpoint replays every handshake that
 *      the checkpoint made.
 * Not in the numbers: network, IndexedDB writes, the Worker hop, and key package generation.
 */
import { bench, describe } from "vitest";

import type {
  MlsGroupHandle,
  PendingCommit,
  ProposalPolicy,
  UserId,
} from "../api";
import { fromB64url } from "../codec";
import { BATCH_MAX_ADDS, PUBLIC_SET_MAX_MEMBERS } from "../constants";
import { ds } from "./ds";
import { checkStoredProposal, mls, proposalRefOf } from "./index";
import {
  chainContext,
  dsSigner,
  keyPackage,
  makeDevice,
  makeUser,
  uuid,
  type TestDevice,
  type TestUser,
} from "./test-helpers";

// MARK: - parameters and budgets

interface NodeProcess {
  env: Record<string, string | undefined>;
  memoryUsage(): { rss: number; heapUsed: number };
}
const proc = (globalThis as { process?: NodeProcess }).process;
const env = proc?.env ?? {};
const int = (name: string, dflt: number, min: number): number =>
  Math.max(min, Math.floor(Number(env[name] ?? dflt)));
const SIZES = (env["LOAD_SIZES"] ?? "1000")
  .split(",")
  .map((s) => Math.floor(Number(s.trim())))
  .filter((n) => Number.isFinite(n) && n >= 10)
  .sort((a, b) => a - b);
const ROUNDS = int("LOAD_ROUNDS", 5, 1);
const JOINS = int("LOAD_JOINS", 2, 0);
const LEAVES = int("LOAD_LEAVES", 2, 0);
/** 1: keep the external joiner in the group. With ts-mls 1.6.4 the next join then fails. */
const ADOPT_EXTERNAL = env["LOAD_ADOPT_EXTERNAL"] === "1";
/** join: only grow the group and time the two join paths at each checkpoint, in a small heap. */
const JOIN_ONLY = env["LOAD_MODE"] === "join";

/** Hard limits. A size that breaks one of them cannot work. */
const BUDGET = {
  /** TAKUSEN_MLS_BATCH_TIMEOUT_MS: the committer must store, check and commit a full batch in time. */
  committerMs: 5000,
  /** TAKUSEN_MLS_BATCH_INTERVAL_MS: a member must process one batch before the next one comes. */
  memberMs: 2000,
  /** First open of a public channel. */
  joinMs: 10_000,
  /** The commit route caps ratchetTree at 8 MiB. */
  treeBytes: 8 * 1024 * 1024,
  /** Next.js middleware buffers at most 10 MB of request body (base64url JSON of the commit upload). */
  uploadBytes: 10_000_000,
} as const;

// MARK: - helpers

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const r = await fn();
  return [r, performance.now() - t];
}

let gcFn: (() => void) | null = (globalThis as { gc?: () => void }).gc ?? null;
function gc(): void {
  if (gcFn !== null) gcFn();
}
function heapUsed(): number {
  gc();
  return proc?.memoryUsage().heapUsed ?? 0;
}

const b64len = (bytes: number): number => Math.ceil((bytes * 4) / 3);

interface Device {
  dev: TestDevice;
  kp: Awaited<ReturnType<typeof keyPackage>>;
}

interface BatchRow {
  leaves: number;
  adds: number;
  removes: number;
  proposalBytes: number;
  commitBytes: number;
  welcomeBytes: number;
  groupInfoBytes: number;
  treeBytes: number;
  dsSignMs: number;
  committerProposalsMs: number;
  createMs: number;
  dsCheckMs: number;
  memberProposalsMs: number;
  memberCommitMs: number;
  welcomeJoinMs: number | null;
}

interface Checkpoint {
  target: number;
  leaves: number;
  keyPackageBytes: number;
  treeBytes: number;
  groupInfoBytes: number;
  stateBytes: number;
  stateHeapBytes: number;
  external: {
    joinMs: number;
    commitBytes: number;
    dsCheckMs: number;
    memberMs: number;
  };
  steady: BatchRow[];
  full: BatchRow;
  catchUp: { commits: number; proposals: number; ms: number };
}

async function run(): Promise<void> {
  if (gcFn === null) {
    // Without --expose-gc, V8 can still give gc() to a new context.
    try {
      // A string specifier: the package has no Node types.
      const load = (name: string): Promise<unknown> => import(name);
      const v8 = (await load("node:v8")) as {
        setFlagsFromString(f: string): void;
      };
      const vm = (await load("node:vm")) as {
        runInNewContext(code: string): unknown;
      };
      v8.setFlagsFromString("--expose-gc");
      gcFn = vm.runInNewContext("gc") as () => void;
    } catch {
      gcFn = null;
    }
  }
  const signer = await dsSigner();
  const users = new Map<UserId, TestUser>();
  const readers = new Set<UserId>();
  const revoked = new Set<string>();
  const p: ProposalPolicy = {
    kind: "public_set",
    dsExternalSenderKey: signer.publicKey,
    readers,
    adminReaders: null,
    chainContextFor: (u) => chainContext(users.get(u), revoked),
    canChangeDescriptor: () => false,
    voice: null,
  };
  const masterKeys = (u: UserId): Uint8Array | null =>
    users.get(u)?.master.record.publicKey ?? null;
  async function newDevice(): Promise<Device> {
    const user = makeUser();
    users.set(user.userId, user);
    readers.add(user.userId);
    const dev = makeDevice(user);
    return { dev, kp: await keyPackage(dev) };
  }
  async function newDevices(n: number): Promise<Device[]> {
    const out: Device[] = [];
    for (let i = 0; i < n; i++) out.push(await newDevice());
    return out;
  }
  async function apply(
    h: MlsGroupHandle,
    message: Uint8Array,
  ): Promise<MlsGroupHandle> {
    const r = await mls.processHandshake(h, message, p);
    if (r.result === "rejected")
      throw new Error(`member rejected a handshake: ${r.reason}`);
    return r.handle;
  }

  // Epoch 0 to 1: the committer creates the group and adds the observer.
  const committer = await newDevice();
  const observer = await newDevice();
  const guildId = uuid();
  const created = await mls.createGroup({
    groupId: mls.groupId({ kind: "public_set", scope: guildId, generation: 0 }),
    descriptor: {
      kind: "public_set",
      guildId,
      channelId: null,
      historyVisibility: "shared",
      createdByUserId: committer.dev.user.userId,
    },
    dsExternalSender: signer.externalSender,
    cipherSuite: 1,
    keyPackage: committer.kp,
  });
  const first = await mls.commit(created.handle, {
    adds: [observer.kp.publicPackage],
    removes: [],
    descriptor: null,
    policy: p,
  });
  let ch = first.next;
  let oh = await mls.joinFromWelcome({
    welcome: fromB64url(first.request.welcome!),
    ratchetTree: fromB64url(first.request.ratchetTree),
    keyPackage: observer.kp,
    policy: p,
  });
  let published = {
    groupInfo: fromB64url(first.request.groupInfo),
    ratchetTree: fromB64url(first.request.ratchetTree),
  };
  const adopt = (pc: PendingCommit): void => {
    published = {
      groupInfo: fromB64url(pc.request.groupInfo),
      ratchetTree: fromB64url(pc.request.ratchetTree),
    };
  };
  const dsCheck = async (
    pc: PendingCommit,
    sender: TestDevice,
    proposals: readonly Uint8Array[],
  ): Promise<number> => {
    const [chk, ms] = await timed(() =>
      ds.checkCommit({
        groupId: ch.groupId,
        epoch: pc.request.epoch,
        commit: fromB64url(pc.request.commit),
        groupInfo: fromB64url(pc.request.groupInfo),
        ratchetTree: fromB64url(pc.request.ratchetTree),
        previous: published,
        sender: { userId: sender.user.userId, deviceId: sender.deviceId },
        publishedProposals: proposals,
        masterKeys,
      }),
    );
    if (!chk.ok) throw new Error(`ds.checkCommit: ${chk.reason}`);
    return ms;
  };

  /** One batch of §12.7.5 with DS proposals. Returns the handshakes in stream order. */
  let victimCursor = 2;
  async function batch(
    nAdds: number,
    nRemoves: number,
    welcomeJoin: boolean,
    stream: Uint8Array[],
  ): Promise<BatchRow> {
    const roster = mls.roster(ch).filter((e) => e.leafIndex >= 2);
    const victims = Array.from(
      { length: Math.min(nRemoves, roster.length) },
      () => roster[victimCursor++ % roster.length]!,
    );
    for (const v of victims) readers.delete(v.userId);
    const joiners = await newDevices(nAdds);

    const [proposals, dsSignMs] = await timed(async () => [
      ...(await Promise.all(
        victims.map((v) =>
          ds.proposeRemove(signer, published.groupInfo, v.leafIndex),
        ),
      )),
      ...(await Promise.all(
        joiners.map((j) =>
          ds.proposeAdd(signer, published.groupInfo, j.kp.publicPackage),
        ),
      )),
    ]);
    const [, committerProposalsMs] = await timed(async () => {
      for (const m of proposals) ch = await apply(ch, m);
      for (const m of proposals) {
        const why = checkStoredProposal(
          ch,
          await proposalRefOf(m, ch.cipherSuite),
          p,
        );
        if (why !== null)
          throw new Error(`committer dropped a stored proposal: ${why}`);
      }
    });
    const [pc, createMs] = await timed(() =>
      mls.commit(ch, { adds: [], removes: [], descriptor: null, policy: p }),
    );
    const dsCheckMs = await dsCheck(pc, committer.dev, proposals);
    const commit = fromB64url(pc.request.commit);
    const [, memberProposalsMs] = await timed(async () => {
      for (const m of proposals) oh = await apply(oh, m);
    });
    const [next, memberCommitMs] = await timed(() => apply(oh, commit));
    oh = next;
    ch = pc.next;
    adopt(pc);
    stream.push(...proposals, commit);

    let welcomeJoinMs: number | null = null;
    const j = joiners[0];
    if (welcomeJoin && j !== undefined && pc.request.welcome !== null) {
      [, welcomeJoinMs] = await timed(() =>
        mls.joinFromWelcome({
          welcome: fromB64url(pc.request.welcome!),
          ratchetTree: published.ratchetTree,
          keyPackage: j.kp,
          policy: p,
        }),
      );
    }
    return {
      leaves: mls.roster(ch).length,
      adds: joiners.length,
      removes: victims.length,
      proposalBytes: proposals.reduce((a, m) => a + m.length, 0),
      commitBytes: commit.length,
      welcomeBytes:
        pc.request.welcome === null ? 0 : fromB64url(pc.request.welcome).length,
      groupInfoBytes: published.groupInfo.length,
      treeBytes: published.ratchetTree.length,
      dsSignMs,
      committerProposalsMs,
      createMs,
      dsCheckMs,
      memberProposalsMs,
      memberCommitMs,
      welcomeJoinMs,
    };
  }

  const growth: {
    leaves: number;
    commitBytes: number;
    treeBytes: number;
    createMs: number;
    processMs: number;
  }[] = [];
  const checkpoints: Checkpoint[] = [];
  const joins: {
    leaves: number;
    externalMs: number;
    welcomeMs: number;
    heapMiB: number;
  }[] = [];
  const t0 = performance.now();
  for (const target of SIZES) {
    // Growth by value up to the checkpoint.
    while (mls.roster(ch).length < target) {
      const n = Math.min(BATCH_MAX_ADDS, target - mls.roster(ch).length);
      const kps = await newDevices(n);
      const [pc, createMs] = await timed(() =>
        mls.commit(ch, {
          adds: kps.map((d) => d.kp.publicPackage),
          removes: [],
          descriptor: null,
          policy: p,
        }),
      );
      const [next, processMs] = JOIN_ONLY
        ? [oh, 0]
        : await timed(() => apply(oh, fromB64url(pc.request.commit)));
      ch = pc.next;
      oh = next;
      adopt(pc);
      growth.push({
        leaves: mls.roster(ch).length,
        commitBytes: fromB64url(pc.request.commit).length,
        treeBytes: published.ratchetTree.length,
        createMs,
        processMs,
      });
    }
    const leaves = mls.roster(ch).length;
    if (JOIN_ONLY) {
      // Probes in a small heap. A batch-like commit (1 Add, 1 Remove, so it has a path) that the
      // committer then drops; a joiner by Welcome from it, and an external joiner on its tree.
      const w = await newDevice();
      const victim = mls.roster(ch).at(-1)!;
      readers.delete(victim.userId);
      const pc = await mls.commit(ch, {
        adds: [w.kp.publicPackage],
        removes: [victim.leafIndex],
        descriptor: null,
        policy: p,
      });
      readers.add(victim.userId);
      const tree = fromB64url(pc.request.ratchetTree);
      const [, welcomeMs] = await timed(() =>
        mls.joinFromWelcome({
          welcome: fromB64url(pc.request.welcome!),
          ratchetTree: tree,
          keyPackage: w.kp,
          policy: p,
        }),
      );
      const ext = await newDevice();
      const [, externalMs] = await timed(() =>
        mls.joinExternal({
          groupInfo: fromB64url(pc.request.groupInfo),
          ratchetTree: tree,
          keyPackage: ext.kp,
          resync: false,
          policy: p,
        }),
      );
      joins.push({
        leaves,
        externalMs,
        welcomeMs,
        heapMiB: (proc?.memoryUsage().heapUsed ?? 0) / 2 ** 20,
      });
      console.log(
        `checkpoint ${target}: ${leaves} leaves, external join ${(externalMs / 1000).toFixed(1)} s, Welcome join ${(welcomeMs / 1000).toFixed(1)} s`,
      );
      continue;
    }
    const lagging = oh;
    const stream: Uint8Array[] = [];

    // Memory: the heap that one decoded group state holds.
    const h0 = heapUsed();
    let copy: MlsGroupHandle | null = await mls.restore(oh.state);
    const stateHeapBytes = Math.max(0, heapUsed() - h0);
    if (copy.epoch !== oh.epoch) throw new Error("restore");
    copy = null;

    // 1. A joiner by external commit (no member online, §12.7.5 step 7). By default it is a probe:
    // the members time it and then drop it. ts-mls 1.6.4 rejects every later join into a tree in
    // which a parent lists an unmerged leaf that a parent above it does not list, and the path of
    // this commit makes such a tree (docs/e2ee-load-test.md, "ts-mls join bug").
    const ext = await newDevice();
    const [epc, joinMs] = await timed(() =>
      mls.joinExternal({
        ...published,
        keyPackage: ext.kp,
        resync: false,
        policy: p,
      }),
    );
    const extDsMs = await dsCheck(epc, ext.dev, []);
    const extCommit = fromB64url(epc.request.commit);
    const [nextO, extMemberMs] = await timed(() => apply(oh, extCommit));
    if (ADOPT_EXTERNAL) {
      oh = nextO;
      ch = await apply(ch, extCommit);
      adopt(epc);
      stream.push(extCommit);
    }

    // 2. Steady churn, 3. one full batch.
    const steady: BatchRow[] = [];
    for (let r = 0; r < ROUNDS; r++)
      steady.push(await batch(JOINS, LEAVES, r === 0, stream));
    const full = await batch(BATCH_MAX_ADDS, 0, false, stream);

    // 4. Catch-up of a device that missed every handshake of this checkpoint.
    let lh = lagging;
    const [, catchUpMs] = await timed(async () => {
      for (const m of stream) lh = await apply(lh, m);
    });
    if (lh.epoch !== oh.epoch)
      throw new Error("catch-up did not reach the current epoch");

    checkpoints.push({
      target,
      leaves,
      keyPackageBytes: ext.kp.publicPackage.length,
      treeBytes: fromB64url(epc.request.ratchetTree).length,
      groupInfoBytes: fromB64url(epc.request.groupInfo).length,
      stateBytes: oh.state.length,
      stateHeapBytes,
      external: {
        joinMs,
        commitBytes: extCommit.length,
        dsCheckMs: extDsMs,
        memberMs: extMemberMs,
      },
      steady,
      full,
      catchUp: {
        commits: (ADOPT_EXTERNAL ? 1 : 0) + steady.length + 1,
        proposals: stream.length - steady.length - 1 - (ADOPT_EXTERNAL ? 1 : 0),
        ms: catchUpMs,
      },
    });
    console.log(
      `checkpoint ${target}: ${leaves} leaves, ${((performance.now() - t0) / 1000).toFixed(0)} s since start`,
    );
  }
  if (JOIN_ONLY) {
    const L = [
      "Join-only run (committer state only, no observer):",
      "",
      "| leaves | external commit join | Welcome join | heap in use |",
      "|---|---|---|---|",
    ];
    for (const j of joins)
      L.push(
        `| ${j.leaves} | ${ms(j.externalMs)} | ${ms(j.welcomeMs)} | ${j.heapMiB.toFixed(0)} MiB |`,
      );
    console.log(L.join("\n"));
    console.log(`LOAD_RESULT ${JSON.stringify({ sizes: SIZES, joins })}`);
    return;
  }
  report(growth, checkpoints, (performance.now() - t0) / 1000);
}

// MARK: - report

const avg = (xs: readonly number[]): number =>
  xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const kb = (n: number): string => `${(n / 1024).toFixed(1)} KiB`;
const ms = (n: number): string =>
  n >= 10_000 ? `${(n / 1000).toFixed(1)} s` : `${n.toFixed(0)} ms`;

/** Least squares y = a + b·x. */
function fit(
  xs: readonly number[],
  ys: readonly number[],
): { a: number; b: number } {
  const mx = avg(xs);
  const my = avg(ys);
  let num = 0;
  let den = 0;
  xs.forEach((x, i) => {
    num += (x - mx) * (ys[i]! - my);
    den += (x - mx) ** 2;
  });
  const b = den === 0 ? my / Math.max(1, mx) : num / den;
  return { a: den === 0 ? 0 : my - b * mx, b };
}

function report(
  growth: {
    leaves: number;
    commitBytes: number;
    treeBytes: number;
    createMs: number;
    processMs: number;
  }[],
  cps: Checkpoint[],
  totalSec: number,
): void {
  const L: string[] = [];
  L.push(
    `public_set load test: sizes ${SIZES.join(", ")}, ${ROUNDS} steady batches of ${JOINS} joins + ${LEAVES} leaves, 1 full batch of ${BATCH_MAX_ADDS} Adds; ${totalSec.toFixed(0)} s in total`,
  );
  L.push(
    "",
    "Growth (Adds by value, 100 per commit):",
    "",
    "| leaves | commit | ratchet tree | create | process at member |",
    "|---|---|---|---|---|",
  );
  const step = Math.max(1, Math.floor(growth.length / 12));
  growth.forEach((g, i) => {
    if (i % step === 0 || i === growth.length - 1)
      L.push(
        `| ${g.leaves} | ${kb(g.commitBytes)} | ${kb(g.treeBytes)} | ${ms(g.createMs)} | ${ms(g.processMs)} |`,
      );
  });

  L.push(
    "",
    "Sizes and memory:",
    "",
    "| leaves | key package | GroupInfo | ratchet tree | group state | heap of one state |",
    "|---|---|---|---|---|---|",
  );
  for (const c of cps)
    L.push(
      `| ${c.leaves} | ${kb(c.keyPackageBytes)} | ${kb(c.groupInfoBytes)} | ${kb(c.treeBytes)} | ${kb(c.stateBytes)} | ${c.stateHeapBytes > 0 ? kb(c.stateHeapBytes) : "n/a"} |`,
    );

  L.push(
    "",
    "Joiners:",
    "",
    "| leaves | external commit: join | its size | DS check | member processes it | Welcome join |",
    "|---|---|---|---|---|---|",
  );
  for (const c of cps) {
    const w =
      c.steady.find((s) => s.welcomeJoinMs !== null)?.welcomeJoinMs ?? null;
    L.push(
      `| ${c.leaves} | ${ms(c.external.joinMs)} | ${kb(c.external.commitBytes)} | ${ms(c.external.dsCheckMs)} | ${ms(c.external.memberMs)} | ${w === null ? "n/a" : ms(w)} |`,
    );
  }

  const head =
    "| leaves | items | proposals | commit | welcome | DS sign | committer: store + check | committer: create | DS checkCommit | member: proposals | member: commit | member total |";
  L.push(
    "",
    `Batches at each checkpoint (averages of the ${ROUNDS} steady batches, then the full batch):`,
    "",
    head,
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  const line = (
    r: Omit<
      BatchRow,
      "welcomeJoinMs" | "leaves" | "groupInfoBytes" | "treeBytes"
    > & { leaves: number },
    items: string,
  ): string =>
    `| ${r.leaves} | ${items} | ${kb(r.proposalBytes)} | ${kb(r.commitBytes)} | ${kb(r.welcomeBytes)} | ${ms(r.dsSignMs)} | ${ms(r.committerProposalsMs)} | ${ms(r.createMs)} | ${ms(r.dsCheckMs)} | ${ms(r.memberProposalsMs)} | ${ms(r.memberCommitMs)} | ${ms(r.memberProposalsMs + r.memberCommitMs)} |`;
  const mean = (rows: BatchRow[]) => {
    const k = (key: Exclude<keyof BatchRow, "welcomeJoinMs">): number =>
      avg(rows.map((r) => r[key]));
    return {
      leaves: rows.at(-1)!.leaves,
      adds: k("adds"),
      removes: k("removes"),
      proposalBytes: k("proposalBytes"),
      commitBytes: k("commitBytes"),
      welcomeBytes: k("welcomeBytes"),
      dsSignMs: k("dsSignMs"),
      committerProposalsMs: k("committerProposalsMs"),
      createMs: k("createMs"),
      dsCheckMs: k("dsCheckMs"),
      memberProposalsMs: k("memberProposalsMs"),
      memberCommitMs: k("memberCommitMs"),
    };
  };
  for (const c of cps) {
    L.push(
      line({ ...mean(c.steady), leaves: c.leaves }, `+${JOINS} −${LEAVES}`),
    );
    L.push(line({ ...c.full, leaves: c.leaves }, `+${c.full.adds}`));
  }

  L.push(
    "",
    "Catch-up (replay of every handshake that one checkpoint made):",
    "",
    "| leaves | commits | proposals | replay | per commit |",
    "|---|---|---|---|---|",
  );
  for (const c of cps)
    L.push(
      `| ${c.leaves} | ${c.catchUp.commits} | ${c.catchUp.proposals} | ${ms(c.catchUp.ms)} | ${ms(c.catchUp.ms / c.catchUp.commits)} |`,
    );

  // Commit rate: the committer path (store + check + create + DS check) is serial per group, and
  // every member must process each commit before the next one.
  L.push(
    "",
    "Sustainable rate per group (steady batches):",
    "",
    "| leaves | committer + DS per commit | member per commit | commits/s | churn items/s at 2 s batches |",
    "|---|---|---|---|---|",
  );
  const rows = cps.map((c) => {
    const s = mean(c.steady);
    const serial = s.committerProposalsMs + s.createMs + s.dsCheckMs;
    const member = s.memberProposalsMs + s.memberCommitMs;
    const perCommit = Math.max(serial, member);
    const rate = 1000 / perCommit;
    // At a 2 s interval the scheduler can fill a batch up to BATCH_MAX_ADDS; the limit is whether one batch fits in 2 s.
    return { c, serial, member, rate };
  });
  for (const r of rows)
    L.push(
      `| ${r.c.leaves} | ${ms(r.serial)} | ${ms(r.member)} | ${r.rate.toFixed(2)} | ${r.member <= BUDGET.memberMs ? `${JOINS + LEAVES} per 2 s fits` : "falls behind"} |`,
    );

  // Budgets per checkpoint, then the largest size that passes all of them.
  L.push(
    "",
    `Budgets: committer full batch ≤ ${ms(BUDGET.committerMs)}, member steady batch ≤ ${ms(BUDGET.memberMs)}, join ≤ ${ms(BUDGET.joinMs)}, tree ≤ ${kb(BUDGET.treeBytes)}, upload ≤ ${(BUDGET.uploadBytes / 1e6).toFixed(0)} MB.`,
    "",
  );
  L.push(
    "| leaves | committer full batch | member steady batch | external join | Welcome join | tree | upload (base64) | result |",
    "|---|---|---|---|---|---|---|---|",
  );
  let pass = 0;
  const metrics = cps.map((c) => {
    const s = mean(c.steady);
    const w =
      c.steady.find((x) => x.welcomeJoinMs !== null)?.welcomeJoinMs ?? 0;
    const m = {
      leaves: c.leaves,
      committer: c.full.committerProposalsMs + c.full.createMs,
      member: s.memberProposalsMs + s.memberCommitMs,
      externalJoin: c.external.joinMs,
      welcomeJoin: w,
      tree: c.treeBytes,
      upload: b64len(
        c.full.commitBytes +
          c.full.groupInfoBytes +
          c.full.treeBytes +
          c.full.welcomeBytes,
      ),
    };
    const fails = [
      m.committer > BUDGET.committerMs ? "committer" : null,
      m.member > BUDGET.memberMs ? "member" : null,
      m.externalJoin > BUDGET.joinMs ? "external join" : null,
      m.welcomeJoin > BUDGET.joinMs ? "Welcome join" : null,
      m.tree > BUDGET.treeBytes ? "tree" : null,
      m.upload > BUDGET.uploadBytes ? "upload" : null,
    ].filter((x) => x !== null);
    if (fails.length === 0) pass = Math.max(pass, c.leaves);
    L.push(
      `| ${c.leaves} | ${ms(m.committer)} | ${ms(m.member)} | ${ms(m.externalJoin)} | ${ms(m.welcomeJoin)} | ${kb(m.tree)} | ${(m.upload / 1e6).toFixed(2)} MB | ${fails.length === 0 ? "pass" : `fail: ${fails.join(", ")}`} |`,
    );
    return m;
  });
  if (metrics.length >= 2) {
    const xs = metrics.map((m) => m.leaves);
    const at = (ys: number[], limit: number): number => {
      const f = fit(xs, ys);
      return f.b <= 0 ? Infinity : Math.floor((limit - f.a) / f.b);
    };
    const limits = {
      committer: at(
        metrics.map((m) => m.committer),
        BUDGET.committerMs,
      ),
      member: at(
        metrics.map((m) => m.member),
        BUDGET.memberMs,
      ),
      externalJoin: at(
        metrics.map((m) => m.externalJoin),
        BUDGET.joinMs,
      ),
      welcomeJoin: at(
        metrics.map((m) => m.welcomeJoin),
        BUDGET.joinMs,
      ),
      tree: at(
        metrics.map((m) => m.tree),
        BUDGET.treeBytes,
      ),
      upload: at(
        metrics.map((m) => m.upload),
        BUDGET.uploadBytes,
      ),
    };
    L.push(
      "",
      `Linear fit over the measured sizes, leaves where each budget is reached: ${Object.entries(
        limits,
      )
        .map(([k, v]) => `${k} ${Number.isFinite(v) ? v : "∞"}`)
        .join(", ")}.`,
    );
  }
  L.push(
    `Largest measured size that passes every budget: ${pass === 0 ? "none" : pass} (PUBLIC_SET_MAX_MEMBERS is ${PUBLIC_SET_MAX_MEMBERS}).`,
  );
  L.push(
    `Peak: rss ${proc === undefined ? "n/a" : `${(proc.memoryUsage().rss / 2 ** 20).toFixed(0)} MiB`} at the end of the run.`,
  );
  console.log(L.join("\n"));
  console.log(
    `LOAD_RESULT ${JSON.stringify({ sizes: SIZES, rounds: ROUNDS, joins: JOINS, leaves: LEAVES, checkpoints: cps, growth })}`,
  );
}

describe("public_set load", () => {
  bench(
    `public_set at ${SIZES.join("/")} leaves: churn, joiners, catch-up`,
    run,
    { iterations: 1, warmupIterations: 0, time: 0, warmupTime: 0 },
  );
});
