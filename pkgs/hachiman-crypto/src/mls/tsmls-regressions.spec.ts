// Regression tests for two ts-mls 1.6.4 defects (docs/e2ee-load-test.md, "ts-mls defects").
// These tests FAIL on unpatched ts-mls 1.6.4. They pass only when the repo applies the ts-mls
// patch (pnpm patchedDependencies) that fixes:
//   1. validateRatchetTree (dist/src/clientState.js) rejects valid trees with "non-blank
//      intermediate node must list leaf node in its unmerged_leaves".
//   2. varLenTypeEncoder (dist/src/codec/variableLength.js) recurses once per vector element and
//      overflows the default stack for vectors of about 8,000 elements (groups above 2,048 leaves).
// Do not skip these tests. If they fail, the patch is missing or a ts-mls upgrade lost the fix.
import { describe, expect, it } from "vitest";
import {
  type CiphersuiteImpl,
  type ClientState,
  type Credential,
  type KeyPackage,
  type MLSMessage,
  type PrivateKeyPackage,
  acceptAll,
  createCommit,
  createGroup,
  createGroupInfoWithExternalPubAndRatchetTree,
  decodeMlsMessage,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  encodeMlsMessage,
  generateKeyPackage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  joinGroupExternal,
  processMessage,
} from "ts-mls";
import { decodeRatchetTree, encodeRatchetTree } from "ts-mls/ratchetTree.js";
import type { RatchetTree } from "ts-mls/ratchetTree.js";

const te = new TextEncoder();

interface Member {
  kp: { publicPackage: KeyPackage; privatePackage: PrivateKeyPackage };
  state?: ClientState;
}

async function member(cs: CiphersuiteImpl, name: string): Promise<Member> {
  const credential: Credential = {
    credentialType: "basic",
    identity: te.encode(name),
  };
  return {
    kp: await generateKeyPackage(
      credential,
      defaultCapabilities(),
      defaultLifetime,
      [],
      cs,
    ),
  };
}

function handshake(
  m: MLSMessage,
): MLSMessage & { wireformat: "mls_public_message" | "mls_private_message" } {
  const decoded = decodeMlsMessage(encodeMlsMessage(m), 0);
  if (decoded === undefined) throw new Error("decode failed");
  const msg = decoded[0];
  if (
    msg.wireformat !== "mls_public_message" &&
    msg.wireformat !== "mls_private_message"
  ) {
    throw new Error(`unexpected wireformat ${msg.wireformat}`);
  }
  return msg;
}

/** Applies a commit to every member except the committer, and stores the committer state. */
async function fanOut(
  members: Member[],
  committer: number,
  newState: ClientState,
  commit: MLSMessage,
  cs: CiphersuiteImpl,
): Promise<void> {
  for (const [i, m] of members.entries()) {
    if (i === committer || m.state === undefined) continue;
    m.state = (
      await processMessage(
        handshake(commit),
        m.state,
        emptyPskIndex,
        acceptAll,
        cs,
      )
    ).newState;
  }
  members[committer]!.state = newState;
}

async function add(
  members: Member[],
  committer: number,
  joiners: Member[],
  cs: CiphersuiteImpl,
): Promise<void> {
  const r = await createCommit(
    { state: members[committer]!.state!, cipherSuite: cs },
    {
      wireAsPublicMessage: true,
      extraProposals: joiners.map((j) => ({
        proposalType: "add",
        add: { keyPackage: j.kp.publicPackage },
      })),
    },
  );
  await fanOut(members, committer, r.newState, r.commit, cs);
  for (const j of joiners) {
    j.state = await joinGroup(
      r.welcome!,
      j.kp.publicPackage,
      j.kp.privatePackage,
      emptyPskIndex,
      cs,
      r.newState.ratchetTree,
    );
    members.push(j);
  }
}

async function pathCommit(
  members: Member[],
  committer: number,
  cs: CiphersuiteImpl,
): Promise<void> {
  const r = await createCommit(
    { state: members[committer]!.state!, cipherSuite: cs },
    { wireAsPublicMessage: true },
  );
  await fanOut(members, committer, r.newState, r.commit, cs);
}

function unmergedLeaves(state: ClientState, nodeIndex: number): number[] {
  const n = state.ratchetTree[nodeIndex];
  return n?.nodeType === "parent" ? n.parent.unmergedLeaves.map(Number) : [];
}

describe("ts-mls 1.6.4 regressions (need the ts-mls patch)", () => {
  it("joins a tree where an unmerged leaf is listed below the parent but not above it", async () => {
    const cs = await getCiphersuiteImpl(
      getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
    );
    const creator = await member(cs, "m0");
    creator.state = await createGroup(
      te.encode("regression-unmerged"),
      creator.kp.publicPackage,
      creator.kp.privatePackage,
      [],
      cs,
    );
    const members: Member[] = [creator];

    // 1. Leaf 0 adds 6 devices (leaves 1 to 6).
    await add(
      members,
      0,
      await Promise.all([1, 2, 3, 4, 5, 6].map((i) => member(cs, `m${i}`))),
      cs,
    );
    // 2. Leaf 4 commits with a path: nodes 9, 11 and the root (7) get keys.
    await pathCommit(members, 4, cs);
    // 3. Leaf 0 adds a device into leaf 7: node 11 and the root list leaf 7 as unmerged.
    await add(members, 0, [await member(cs, "m7")], cs);
    // 4. Leaf 0 commits with a path: the root lists no unmerged leaves, node 11 still lists leaf 7.
    await pathCommit(members, 0, cs);
    const tree = members[0]!.state!;
    expect(unmergedLeaves(tree, 7)).toEqual([]);
    expect(unmergedLeaves(tree, 11)).toEqual([7]);

    // 5a. A Welcome join of a ninth device must succeed (RFC 9420 §7.9.1, §12.4.3.1).
    await add(members, 0, [await member(cs, "m8")], cs);
    expect(members[8]!.state!.groupContext.epoch).toBe(
      members[0]!.state!.groupContext.epoch,
    );

    // 5b. An external join on the tree of step 4 must also succeed.
    const gi = await createGroupInfoWithExternalPubAndRatchetTree(tree, [], cs);
    const ext = await member(cs, "ext");
    const joined = await joinGroupExternal(
      gi,
      ext.kp.publicPackage,
      ext.kp.privatePackage,
      false,
      cs,
    );
    expect(joined.newState.groupContext.epoch).toBe(
      tree.groupContext.epoch + 1n,
    );
  }, 60_000);

  it("encodes and decodes a ratchet tree of 8,192 leaves with the default stack", async () => {
    const cs = await getCiphersuiteImpl(
      getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
    );
    const m = await member(cs, "big");
    const state = await createGroup(
      te.encode("regression-stack"),
      m.kp.publicPackage,
      m.kp.privatePackage,
      [],
      cs,
    );
    const leaf = state.ratchetTree[0]!;
    // 16,383 nodes. The codec does not validate the tree, so one leaf node is reused at each leaf.
    const tree: RatchetTree = Array.from({ length: 2 * 8192 - 1 }, (_, i) =>
      i % 2 === 0 ? leaf : undefined,
    );
    const bytes = encodeRatchetTree(tree);
    const decoded = decodeRatchetTree(bytes, 0);
    expect(decoded?.[0].length).toBe(tree.length);
    expect(decoded?.[0][2 * 8191]).toEqual(leaf);
  }, 60_000);
});
