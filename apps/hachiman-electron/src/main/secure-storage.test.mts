/**
 * Unit tests for the wrap key store (./secure-storage.ts) with a fake safeStorage.
 * Run via the package `test` script (node's test runner + native TS type-stripping).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWrapKeyStore,
  SecureStorageError,
  toIpcResult,
  WRAP_KEY_BYTES,
  type SafeStorageLike,
} from "./secure-storage.ts";

const USER = "0b6f2c4e-8d1a-4f3b-9c2e-5a7d1e0f3b29";
const OTHER = "7e1d9a03-2b4c-4d5e-8f60-1a2b3c4d5e6f";

/** Reversible stand-in for the OS keychain: XOR with a fixed byte, plus a tag. */
function fakeSafeStorage(
  over: Partial<SafeStorageLike> & { backend?: string } = {},
): SafeStorageLike & { encrypted: number; failDecrypt: boolean } {
  const fake = {
    encrypted: 0,
    failDecrypt: false,
    isEncryptionAvailable: () => true,
    encryptString(plain: string): Buffer {
      fake.encrypted++;
      const b = Buffer.from(plain, "utf8");
      return Buffer.concat([Buffer.from("FAKE"), b.map((x) => x ^ 0x5a)]);
    },
    decryptString(enc: Buffer): string {
      if (fake.failDecrypt || enc.subarray(0, 4).toString() !== "FAKE") {
        throw new Error(
          "Error while decrypting the ciphertext provided to safeStorage.decryptString.",
        );
      }
      return Buffer.from(enc.subarray(4).map((x) => x ^ 0x5a)).toString("utf8");
    },
    getSelectedStorageBackend: () => over.backend ?? "gnome_libsecret",
    ...over,
  };
  return fake;
}

async function tempDir(): Promise<string> {
  const base = await fs.mkdtemp(join(tmpdir(), "hachiman-keys-"));
  return join(base, "keys");
}

async function rejectsWith(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof SecureStorageError);
    assert.equal(e.code, code);
    assert.equal(e.name, code);
    return true;
  });
}

test("first call makes a 32-byte key in <dir>/<userId>.bin, encrypted, mode 0600", async () => {
  const dir = await tempDir();
  const safe = fakeSafeStorage();
  const store = createWrapKeyStore({
    dir,
    safeStorage: safe,
    platform: "darwin",
  });
  const key = await store.getWrapKeyBytes(USER);
  assert.equal(key.length, WRAP_KEY_BYTES);
  assert.ok(key.some((b) => b !== 0));
  assert.equal(safe.encrypted, 1);

  const file = join(dir, `${USER}.bin`);
  const st = await fs.stat(file);
  if (process.platform !== "win32") {
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  }
  const onDisk = await fs.readFile(file);
  assert.ok(
    !onDisk.includes(Buffer.from(key)),
    "raw key bytes are not on disk",
  );
  assert.ok(!onDisk.includes(Buffer.from(Buffer.from(key).toString("base64"))));
  // No temp file stays behind.
  assert.deepEqual(await fs.readdir(dir), [`${USER}.bin`]);
});

test("later calls and a new store reuse the same key; users get different keys", async () => {
  const dir = await tempDir();
  const safe = fakeSafeStorage();
  const a = createWrapKeyStore({ dir, safeStorage: safe, platform: "darwin" });
  const first = await a.getWrapKeyBytes(USER);
  const again = await a.getWrapKeyBytes(USER);
  assert.deepEqual(again, first);
  assert.notEqual(
    again,
    first,
    "each call returns a new buffer the caller can zero",
  );

  const b = createWrapKeyStore({ dir, safeStorage: safe, platform: "darwin" });
  assert.deepEqual(await b.getWrapKeyBytes(USER), first);
  assert.equal(safe.encrypted, 1);

  const other = await a.getWrapKeyBytes(OTHER);
  assert.notDeepEqual(other, first);
});

test("concurrent first calls make one key", async () => {
  const dir = await tempDir();
  const safe = fakeSafeStorage();
  const store = createWrapKeyStore({
    dir,
    safeStorage: safe,
    platform: "darwin",
  });
  const keys = await Promise.all(
    Array.from({ length: 8 }, () => store.getWrapKeyBytes(USER)),
  );
  for (const k of keys) assert.deepEqual(k, keys[0]);
  assert.equal(safe.encrypted, 1);
});

test("two processes racing: the second link loses and reads the first key", async () => {
  const dir = await tempDir();
  const safe = fakeSafeStorage();
  const a = createWrapKeyStore({ dir, safeStorage: safe, platform: "darwin" });
  const b = createWrapKeyStore({ dir, safeStorage: safe, platform: "darwin" });
  const [ka, kb] = await Promise.all([
    a.getWrapKeyBytes(USER),
    b.getWrapKeyBytes(USER),
  ]);
  assert.deepEqual(ka, kb);
  assert.deepEqual(await fs.readdir(dir), [`${USER}.bin`]);
});

test("refuses when safeStorage encryption is not available", async () => {
  const dir = await tempDir();
  const store = createWrapKeyStore({
    dir,
    safeStorage: fakeSafeStorage({ isEncryptionAvailable: () => false }),
    platform: "darwin",
  });
  await rejectsWith(store.getWrapKeyBytes(USER), "SecureStorageUnavailable");
  await assert.rejects(fs.readdir(dir), { code: "ENOENT" });
});

test("Linux: refuses the basic_text and unknown backends, accepts a keyring", async () => {
  for (const backend of ["basic_text", "unknown"]) {
    const dir = await tempDir();
    const store = createWrapKeyStore({
      dir,
      safeStorage: fakeSafeStorage({ backend }),
      platform: "linux",
    });
    await rejectsWith(store.getWrapKeyBytes(USER), "SecureStorageUnavailable");
    await assert.rejects(fs.readdir(dir), { code: "ENOENT" });
  }
  const noBackendFn = fakeSafeStorage();
  delete (noBackendFn as Partial<SafeStorageLike>).getSelectedStorageBackend;
  await rejectsWith(
    createWrapKeyStore({
      dir: await tempDir(),
      safeStorage: noBackendFn,
      platform: "linux",
    }).getWrapKeyBytes(USER),
    "SecureStorageUnavailable",
  );
  for (const backend of ["gnome_libsecret", "kwallet5", "kwallet6"]) {
    const store = createWrapKeyStore({
      dir: await tempDir(),
      safeStorage: fakeSafeStorage({ backend }),
      platform: "linux",
    });
    assert.equal((await store.getWrapKeyBytes(USER)).length, 32);
  }
  // basic_text on another OS name is not a Linux backend; the check is Linux only.
  const mac = createWrapKeyStore({
    dir: await tempDir(),
    safeStorage: fakeSafeStorage({ backend: "basic_text" }),
    platform: "darwin",
  });
  assert.equal((await mac.getWrapKeyBytes(USER)).length, 32);
});

test("bad userId is Malformed and touches no file", async () => {
  const dir = await tempDir();
  const store = createWrapKeyStore({
    dir,
    safeStorage: fakeSafeStorage(),
    platform: "darwin",
  });
  for (const bad of [
    "",
    "../../etc/passwd",
    `${USER}/../x`,
    USER.toUpperCase(),
    `${USER} `,
    `${USER}\n`,
    "0b6f2c4e8d1a4f3b9c2e5a7d1e0f3b29",
    42,
    null,
    undefined,
    { toString: () => USER },
  ]) {
    await rejectsWith(store.getWrapKeyBytes(bad), "Malformed");
    await rejectsWith(store.clear(bad), "Malformed");
  }
  await assert.rejects(fs.readdir(dir), { code: "ENOENT" });
});

test("clear deletes the file; the next call makes a new key; clear without a file is fine", async () => {
  const dir = await tempDir();
  const store = createWrapKeyStore({
    dir,
    safeStorage: fakeSafeStorage(),
    platform: "darwin",
  });
  const first = await store.getWrapKeyBytes(USER);
  const other = await store.getWrapKeyBytes(OTHER);
  await store.clear(USER);
  assert.deepEqual(await fs.readdir(dir), [`${OTHER}.bin`]);
  await store.clear(USER);
  const second = await store.getWrapKeyBytes(USER);
  assert.notDeepEqual(second, first);
  assert.deepEqual(await store.getWrapKeyBytes(OTHER), other);
});

test("a file that does not decrypt is never replaced", async () => {
  const dir = await tempDir();
  const safe = fakeSafeStorage();
  const store = createWrapKeyStore({
    dir,
    safeStorage: safe,
    platform: "darwin",
  });
  await store.getWrapKeyBytes(USER);
  const file = join(dir, `${USER}.bin`);
  const before = await fs.readFile(file);
  safe.failDecrypt = true;
  await rejectsWith(store.getWrapKeyBytes(USER), "SecureStorageUnavailable");
  assert.deepEqual(await fs.readFile(file), before);
});

test("a corrupt payload is StoreCorrupt and is never replaced", async () => {
  const safe = fakeSafeStorage();
  const raw32 = Buffer.alloc(32, 7).toString("base64");
  for (const plain of [
    "garbage",
    `hachiman-wrap-key-v1:${Buffer.alloc(31, 7).toString("base64")}`,
    `hachiman-wrap-key-v1:${Buffer.alloc(33, 7).toString("base64")}`,
    `hachiman-wrap-key-v1:${raw32}!!`,
    `hachiman-wrap-key-v2:${raw32}`,
  ]) {
    const dir = await tempDir();
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, `${USER}.bin`);
    const bad = safe.encryptString(plain);
    await fs.writeFile(file, bad);
    const store = createWrapKeyStore({
      dir,
      safeStorage: safe,
      platform: "darwin",
    });
    await rejectsWith(store.getWrapKeyBytes(USER), "StoreCorrupt");
    assert.deepEqual(await fs.readFile(file), bad);
  }
  // A well-formed payload written by hand decodes to its bytes.
  const dir = await tempDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, `${USER}.bin`),
    safe.encryptString(`hachiman-wrap-key-v1:${raw32}`),
  );
  const key = await createWrapKeyStore({
    dir,
    safeStorage: safe,
    platform: "darwin",
  }).getWrapKeyBytes(USER);
  assert.deepEqual(Buffer.from(key), Buffer.alloc(32, 7));
});

test("a directory or symlink at the key path is StoreCorrupt", async () => {
  if (process.platform === "win32") return;
  const dir = await tempDir();
  await fs.mkdir(join(dir, `${USER}.bin`), { recursive: true });
  const store = createWrapKeyStore({
    dir,
    safeStorage: fakeSafeStorage(),
    platform: "darwin",
  });
  await rejectsWith(store.getWrapKeyBytes(USER), "StoreCorrupt");

  const dir2 = await tempDir();
  await fs.mkdir(dir2, { recursive: true });
  await fs.writeFile(join(dir2, "target"), "x");
  await fs.symlink(join(dir2, "target"), join(dir2, `${OTHER}.bin`));
  const store2 = createWrapKeyStore({
    dir: dir2,
    safeStorage: fakeSafeStorage(),
    platform: "darwin",
  });
  await rejectsWith(store2.getWrapKeyBytes(OTHER), "StoreCorrupt");
});

test("a failed call does not block later calls for the same user", async () => {
  const dir = await tempDir();
  let available = false;
  const store = createWrapKeyStore({
    dir,
    safeStorage: fakeSafeStorage({ isEncryptionAvailable: () => available }),
    platform: "darwin",
  });
  await rejectsWith(store.getWrapKeyBytes(USER), "SecureStorageUnavailable");
  available = true;
  assert.equal((await store.getWrapKeyBytes(USER)).length, 32);
});

test("toIpcResult: codes travel as data, other errors become SecureStorageUnavailable", async () => {
  assert.deepEqual(await toIpcResult(async () => 1), { ok: true, value: 1 });
  assert.deepEqual(
    await toIpcResult(async () => {
      throw new SecureStorageError("Malformed", "bad");
    }),
    { ok: false, code: "Malformed", message: "bad" },
  );
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const r = await toIpcResult(async () => {
      throw new Error("EACCES /secret/path");
    });
    assert.deepEqual(r, {
      ok: false,
      code: "SecureStorageUnavailable",
      message: "the wrap key store failed",
    });
  } finally {
    console.warn = warn;
  }
});
