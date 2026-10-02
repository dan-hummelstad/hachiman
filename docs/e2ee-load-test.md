# E2EE load test: public_set groups

This document gives the results of the Phase 3 load test (`docs/e2ee-plan.md`, "Verification" and open decision 1). It sets the default of `PUBLIC_SET_MAX_MEMBERS` (`TAKUSEN_PUBLIC_SET_MAX_MEMBERS`, §12.7.8 of `docs/gateway-protocol.md`).

Date: 2026-10-02. Library: ts-mls 1.6.4. Machine: Apple M4 (10 cores, 24 GiB), Node 22.14.0. All times are wall-clock times on this machine.

## Result

- **Cap: `PUBLIC_SET_MAX_MEMBERS = 250`.** This value is in `pkgs/hachiman-crypto/src/constants.ts`. It was 10,000.
- A group of 10,000 leaves does not work with the current code. Each budget that the test examines fails at 10,000.
- ts-mls 1.6.4 has two defects that block large groups. Both are fixed in ts-mls 2.0.0-rc.16. See "ts-mls defects".
  - Joins fail in a valid tree after some normal commit sequences. This also affects `channel` and `dm` groups.
  - The library cannot encode a group of more than 2,048 leaves with the default V8 stack.
- The cost that sets the cap is the full batch. When 100 DS Add proposals arrive in one batch (§12.7.5), the committer needs 3.4 s at 250 leaves and 5.1 s at 400 leaves. The batch deadline (`TAKUSEN_MLS_BATCH_TIMEOUT_MS`) is 5 s.

## Method

The benchmark is `pkgs/hachiman-crypto/src/mls/load.bench.ts`. It uses the real `mls` and `ds` modules over ts-mls. It is not part of `vitest run`.

```bash
cd pkgs/hachiman-crypto

# Up to 2048 leaves (default stack)
LOAD_SIZES=250,500,1000 LOAD_ROUNDS=3 node_modules/.bin/vitest bench --run --execArgv=--expose-gc src/mls/load.bench.ts

# Above 2048 leaves: ts-mls 1.6.4 needs a larger stack (see "ts-mls defects")
ulimit -s 65520 && LOAD_SIZES=1000,2000,5000,10000 LOAD_ROUNDS=3 node_modules/.bin/vitest bench --run \
  --execArgv=--expose-gc --execArgv=--stack-size=60000 --execArgv=--max-old-space-size=16384 src/mls/load.bench.ts

# Joins only, in a small heap
LOAD_MODE=join LOAD_SIZES=500,1000,2000 node_modules/.bin/vitest bench --run --execArgv=--expose-gc src/mls/load.bench.ts
```

The file header lists all variables. The run prints Markdown tables and one `LOAD_RESULT` JSON line.

One process holds all leaves:

1. The committer (leaf 0) creates the group and adds the observer (leaf 1). These two devices keep their state for the whole run.
2. The committer grows the group to each checkpoint with Adds by value, 100 per commit. The observer processes each commit. The tree that results has the same shape as a tree from DS Add proposals: each added leaf stays unmerged until it commits.
3. At each checkpoint, the run measures the real paths of §12.7.4 and §12.7.5:
   1. A joiner by external commit (`joinExternal`). This includes the chain check of each leaf. The members time the commit and then drop it (see "ts-mls defects").
   2. Steady batches. Each batch has 2 Adds and 2 Removes, thus 1 join per second and 1 leave per second at the 2 s batch interval. Takusen signs one proposal per item (`ds.proposeAdd`, `ds.proposeRemove`). The committer stores each proposal, checks it with `checkStoredProposal`, and commits by reference. Takusen runs `ds.checkCommit`. The observer processes the proposals and the commit. The first batch also times a joiner by Welcome (`joinFromWelcome`).
   3. One full batch of 100 DS Add proposals.
   4. Catch-up: the observer state from the start of the checkpoint replays all handshakes of the checkpoint.

The numbers do not include the network, IndexedDB writes, the Worker hop, or key package generation. A real client also writes the group state to IndexedDB after each handshake (`saveRow`). The test does not measure this write, but the state sizes below show its cost.

### Two data sets

- **Fresh runs** (250, 400, 500 and 1,000 leaves, default stack). Each run starts a new process. These numbers set the cap.
- **Long run** (1,000, 2,000, 5,000 and 10,000 leaves, large stack, 61 minutes). Its heap grows to 4.5 GiB, and at 1,000 leaves its times are 1.3 to 2.6 times the fresh times. Use it for the trend above 1,000 leaves, not for exact values.

## Results

### Sizes and memory

| Leaves | Key package | GroupInfo | Ratchet tree | Group state (encoded) | Heap of one decoded state |
|---|---|---|---|---|---|
| 250 | 0.8 KiB | 0.3 KiB | 182 KiB | 1.2 MiB | 1.1 MiB |
| 1,000 | 0.8 KiB | 0.3 KiB | 724 KiB | 4.5 MiB | 11 MiB |
| 2,000 | 0.8 KiB | 0.3 KiB | 1.4 MiB | 8.9 MiB | 25 MiB |
| 5,000 | 0.8 KiB | 0.3 KiB | 3.5 MiB | 23.7 MiB | 80 MiB |
| 10,000 | 0.8 KiB | 0.3 KiB | 7.1 MiB | 47.2 MiB | 162 MiB |

- The ratchet tree is about 740 bytes per leaf. At 10,000 leaves it is 7.1 MiB. This is below the 8 MiB cap of the commit route. The base64url commit upload is 9.99 MB, which is at the 10 MB limit of the Next.js middleware.
- The encoded group state is about 6.5 times the tree. ts-mls keeps the ratchet tree and the secret tree of the last 4 epochs (`keyRetentionConfig.retainKeysForEpochs = 4`) in the state. Hachiman sends handshakes as PublicMessage and does not use MLS application messages, so it does not need this data.
- The client writes this state after each handshake. At 10,000 leaves, that is 47 MiB per proposal and per commit.

### Batches

Fresh runs. The steady values are the averages of 3 batches.

| Leaves | Batch | Commit size | Committer: store and check proposals | Committer: create commit | Takusen: `checkCommit` | Member: proposals + commit |
|---|---|---|---|---|---|---|
| 250 | +2 −2 | 21 KiB | 78 ms | 100 ms | 36 ms | 143 ms |
| 250 | +100 | 3.5 KiB | 3.3 s | 118 ms | 297 ms | 3.4 s |
| 400 | +2 −2 | 33 KiB | 140 ms | 172 ms | 53 ms | 254 ms |
| 400 | +100 | 3.5 KiB | 4.9 s | 144 ms | 304 ms | 5.2 s |
| 500 | +2 −2 | 41 KiB | 192 ms | 210 ms | 63 ms | 332 ms |
| 500 | +100 | 3.5 KiB | 5.9 s | 222 ms | 344 ms | 6.1 s |
| 1,000 | +2 −2 | 81 KiB | 408 ms | 439 ms | 126 ms | 692 ms |
| 1,000 | +100 | 3.5 KiB | 11.1 s | 445 ms | 401 ms | 11.3 s |

Long run:

| Leaves | Batch | Commit size | Committer: store and check proposals | Committer: create commit | Takusen: `checkCommit` | Member: proposals + commit |
|---|---|---|---|---|---|---|
| 2,000 | +2 −2 | 161 KiB | 1.7 s | 1.6 s | 544 ms | 2.6 s |
| 2,000 | +100 | 3.5 KiB | 22.5 s | 842 ms | 536 ms | 22.0 s |
| 5,000 | +2 −2 | 402 KiB | 2.7 s | 3.1 s | 674 ms | 4.6 s |
| 5,000 | +100 | 3.5 KiB | 70.6 s | 2.1 s | 970 ms | 69.2 s |
| 10,000 | +2 −2 | 802 KiB | 6.6 s | 6.4 s | 1.4 s | 10.7 s |
| 10,000 | +100 | 3.5 KiB | 158.3 s | 5.0 s | 1.7 s | 167.2 s |

- A DS proposal is about 1 KiB (0.95 KiB for an Add, which carries the key package). Takusen signs one in less than 1 ms.
- A commit with a Remove has an update path. Its size is about 82 bytes per leaf, because the path encrypts to each unmerged leaf. Only the committer commits in this test, so all other leaves stay unmerged. In a real public_set group, the committer is the online device with the lowest leaf index (§12.7.5), so the tree has this shape too. The server sends each commit to each member. At 10,000 leaves, one 802 KiB commit is about 8 GB of traffic.
- A commit with only Adds by reference has no path. It is 3.5 KiB, and its Welcome is 11.8 KiB for 100 joiners.
- The time per proposal increases with the group size: about 33 ms at 250 leaves, 110 ms at 1,000 and 1.6 s at 10,000. See "Where the time goes".

### Sustainable commit rate

A group commits one batch at a time. One commit takes the committer path (store and check the proposals, create the commit, Takusen check). Each member must process each commit before the next one arrives.

| Leaves | Committer + Takusen per steady batch | Member per steady batch | Commits per second | 1 join/s + 1 leave/s |
|---|---|---|---|---|
| 250 | 215 ms | 143 ms | 4.7 | fits |
| 500 | 465 ms | 332 ms | 2.2 | fits |
| 1,000 | 973 ms | 692 ms | 1.0 | fits |
| 2,000 (long run) | 3.9 s | 2.6 s | 0.26 | falls behind |
| 10,000 (long run) | 14.4 s | 10.7 s | 0.07 | falls behind |

### Joins

The fresh runs and the join-only probes give these times. The join-only probe uses a tree after a commit with a path, as a real batch commit makes.

| Leaves | External commit join | Welcome join | Source |
|---|---|---|---|
| 250 | 0.7 s | 1.3 s | fresh run |
| 400 | 1.2 s | 2.6 s | fresh run |
| 500 | 3.7 s | 3.6 s | join-only probe |
| 1,000 | 5.8 to 11.9 s | 11.9 s | fresh run, join-only probe |
| 2,000 | 41.7 s | 41.8 s | join-only probe |
| 5,000 | 76.6 s | 263.8 s | long run |
| 10,000 | 670 s | 1,008 s | long run |

- In a tree without parent nodes (only Adds by value, no path), a join takes about 3 ms per leaf: 2.9 s at 1,000 leaves and 29.5 s at 10,000. This is the lower bound. It is the chain check of each leaf (3 Ed25519 signatures per leaf, `precheckTree`) and the ts-mls leaf checks.
- In a real tree, the join time increases faster than the group size: 3.6 s at 500 leaves, 11.9 s at 1,000, and 41.8 s at 2,000. ts-mls makes sure of the parent hash of each parent node. For each one, it calculates a subtree hash with one asynchronous SHA-256 call per node.
- Takusen checks an external commit in 116 ms at 1,000 leaves and 1.4 s at 10,000.

### Catch-up

A device that missed handshakes replays each one. Each steady batch adds 4 proposals and 1 commit, and a full batch adds 100 proposals and 1 commit.

| Leaves | Handshakes | Replay | Per commit, with its proposals |
|---|---|---|---|
| 250 | 4 commits, 112 proposals | 3.8 s | 0.9 s |
| 1,000 | 4 commits, 112 proposals | 13.2 s | 3.3 s |
| 10,000 (long run) | 4 commits, 112 proposals | 191.5 s | 47.9 s |

The replay time is linear in the number of handshakes. At 1,000 leaves, a device that was offline for one minute of steady churn (30 batches) needs about 30 × 0.69 s = 21 s to catch up. This value is calculated from the measured batch time, not measured.

## Budgets and the cap

The test uses these hard limits. A group size that breaks one of them does not work.

| Budget | Limit | Source |
|---|---|---|
| Committer, full batch | 5 s | `TAKUSEN_MLS_BATCH_TIMEOUT_MS` |
| Member, steady batch | 2 s | `TAKUSEN_MLS_BATCH_INTERVAL_MS` |
| Join (external commit or Welcome) | 10 s | first open of a public channel |
| Ratchet tree | 8 MiB | commit route |
| Commit upload, base64url | 10 MB | Next.js middleware |

| Leaves | Committer, full batch | Member, steady batch | External join | Welcome join | Result |
|---|---|---|---|---|---|
| 250 | 3.4 s | 143 ms | 0.7 s | 1.3 s | pass |
| 400 | 5.1 s | 254 ms | 1.2 s | 2.6 s | fail: committer |
| 500 | 6.1 s | 332 ms | 2.0 s | 3.6 s | fail: committer |
| 1,000 | 11.5 s | 692 ms | 5.8 s | 11.9 s | fail: committer, Welcome join |
| 10,000 (long run) | 163.3 s | 10.7 s | 670 s | 1,008 s | fail: all time budgets |

A linear fit over the fresh runs gives the group size at which each budget fails: committer about 400 leaves, Welcome join about 890, member about 2,800. The tree and upload budgets fail at about 10,000.

Thus the cap is 250. It is the largest measured size that passes each budget. It has a margin of 32% on the committer budget. The committer can be any member device, and a phone or an old laptop can be 2 to 4 times slower than the M4. At 400 leaves, the committer budget fails on the M4.

If a full batch misses the deadline, the scheduler moves the batch to the next device (§12.7.5 step 6). That device has the same cost, so the queued Adds do not commit. A full batch occurs only when 100 or more joins queue in one interval, for example at a guild launch.

## ts-mls defects

### Joins fail in a valid tree

`validateRatchetTree` in ts-mls 1.6.4 (`dist/src/clientState.js`) rejects valid trees with "non-blank intermediate node must list leaf node in its unmerged_leaves". For each unmerged leaf L of a parent P, it examines each non-blank node on the full direct path of L, also the nodes above P. It also requires that their `unmerged_leaves` lists are equal to the list of P. RFC 9420 requires only that each non-blank node between L and P lists L. ts-mls 2.0.0-rc.16 (`dist/src/validation.js`) has the correct check.

`joinFromWelcome` and `joinExternal` both run this check. Each later join fails, in each group kind. A minimal sequence with 9 devices:

1. Leaf 0 creates the group and adds 6 devices (leaves 1 to 6).
2. Leaf 4 commits with a path. Nodes 9 and 11 and the root get keys.
3. Leaf 0 adds a device into leaf 7. Node 11 and the root list leaf 7 as unmerged.
4. Leaf 0 commits with a path. The root lists no unmerged leaves. Node 11 still lists leaf 7.
5. Leaf 0 adds a ninth device. Its `joinFromWelcome` fails. A `joinExternal` on the tree of step 4 also fails.

Any commit with a path from a device other than the usual committer can start this sequence: an external commit, a resync, or a batch that moves to another device. The load test drops its external joiner for this reason. With `LOAD_ADOPT_EXTERNAL=1`, the members keep the external joiner, and the next join fails.

### Groups above 2,048 leaves cannot be encoded

The vector encoder of ts-mls 1.6.4 (`varLenTypeEncoder` in `dist/src/codec/variableLength.js`) makes one nested closure per element. The write call recurses once per element. The secret tree has 2 × width − 1 nodes, and the width is the next power of 2. At 2,049 leaves, the width is 4,096 and the vector has 8,191 elements. The encoder then throws "Maximum call stack size exceeded" with the default stack of Node 22. A commit from 2,048 to 2,049 leaves fails. ts-mls 2.0.0-rc.16 writes the elements in a loop.

The long run uses `--stack-size=60000` to measure above this limit. A browser Worker cannot change its stack size, so 2,048 leaves is a hard limit for clients on ts-mls 1.6.4.

## Where the time goes

CPU profiles of the runs at 1,000 leaves show these costs. All of them are in the client, not in Takusen.

- **The full group state is encoded after each handshake.** `makeHandle` in `src/mls/index.ts` calls `encodeGroupState` for each new handle. Each stored proposal thus encodes 4.5 MiB at 1,000 leaves and 47 MiB at 10,000. This is the main cause of the per-proposal cost, and it also causes much garbage collection. Garbage collection was 24.8 s of a 65.8 s profile.
- **Each chain is checked many times.** A member checks the chain of an Add key package in `precheck`, again in `evaluateProposal`, and again for the commit that references it. The committer also checks it in `checkStoredProposal`. Each check verifies 3 Ed25519 signatures with `@noble/curves` in JavaScript. Chain checks were 12.8 s of the same profile.
- **ts-mls recalculates the tree hash** for each commit and for each parent-hash check in a join.
- **ts-mls keeps 4 old epochs** in the state, so the state is about 6.5 times the tree.

## How to increase the cap

These changes are not part of this test. The order is the order of their effect on the cap.

1. Use ts-mls with the two fixes: a patch of 1.6.4 (`pnpm patch`) with the two functions of 2.0.0-rc.16, or an upgrade to 2.0. Without them, joins fail in real groups, and 2,048 leaves is a hard limit.
2. Encode the group state only when the store needs it, and write it once per batch, not once per proposal.
3. Keep the result of a chain check for a key package, so that each chain is checked once per device.
4. Set `keyRetentionConfig.retainKeysForEpochs` in `clientConfig` to the smallest value that ts-mls accepts. Hachiman does not use MLS application messages.
5. Make fewer Adds per `public_set` batch than `BATCH_MAX_ADDS` (100). At 1,000 leaves, about 40 Adds fit in the 5 s deadline. This is a contract change (§12.7.5).
6. Make the commit size smaller. A new member can send an empty commit with a path after it joins, so that fewer leaves stay unmerged. This is a contract change.

After steps 1 to 4, run the load test again and set a new cap. The join time (parent-hash checks) and the 82 bytes per leaf of each path commit then become the limits.
