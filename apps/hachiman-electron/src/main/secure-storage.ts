/**
 * Wrap key store for `IPlatformService.secureStorage` (docs/gateway-protocol.md §11, §12.17).
 *
 * Each user gets 32 random bytes in `<dir>/<userId>.bin`, encrypted with Electron
 * `safeStorage` (the OS keychain). The renderer imports the bytes as a
 * non-extractable AES-GCM key and overwrites its copy. This module has no Electron
 * imports, so `node --test` can load it with a fake `safeStorage`.
 *
 * Fail closed: without a real OS keystore, every call rejects. A key file that does
 * not decrypt or decode is never replaced, because a new key would make the
 * user's crypto store unreadable without a message.
 */
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
  SecureStorageFailureCode,
  SecureStorageResult,
} from "../shared/ipc";

/** The part of Electron `safeStorage` that this module uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only in Electron. */
  getSelectedStorageBackend?(): string;
}

export interface WrapKeyStoreOptions {
  /** `userData/keys`. */
  dir: string;
  safeStorage: SafeStorageLike;
  platform: NodeJS.Platform;
  randomBytes?: (n: number) => Buffer;
}

// No parameter properties: `node --test` strips types and cannot run them.
export class SecureStorageError extends Error {
  readonly code: SecureStorageFailureCode;
  constructor(code: SecureStorageFailureCode, message: string) {
    super(message);
    this.code = code;
    this.name = code;
  }
}

export interface WrapKeyStore {
  /** The wrap key bytes of `userId`. Makes and stores them on the first call. */
  getWrapKeyBytes(userId: unknown): Promise<Uint8Array<ArrayBuffer>>;
  /** Deletes the key file. No error when there is no file. */
  clear(userId: unknown): Promise<void>;
}

export const WRAP_KEY_BYTES = 32;
/** Version tag inside the safeStorage plaintext. */
const PAYLOAD_PREFIX = "hachiman-wrap-key-v1:";
/** Canonical lowercase UUID text (UserId in @hachiman/crypto). Also keeps the file name inside `dir`. */
const USER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * Linux backends that do not use an OS keystore. `basic_text` is a hardcoded
 * password. `unknown` is the value before `app.whenReady` or when Electron cannot
 * tell; refuse it too.
 */
const LINUX_REFUSED_BACKENDS = new Set(["basic_text", "unknown"]);

function errCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null
    ? (e as { code?: string }).code
    : undefined;
}

export function createWrapKeyStore(opts: WrapKeyStoreOptions): WrapKeyStore {
  const { dir, safeStorage, platform } = opts;
  const randomBytes = opts.randomBytes ?? nodeRandomBytes;
  // Calls for one user run one after another, so two first calls cannot make two keys.
  const queues = new Map<string, Promise<unknown>>();

  function serial<T>(userId: string, run: () => Promise<T>): Promise<T> {
    const prev = queues.get(userId) ?? Promise.resolve();
    const next = prev.then(run, run);
    const tail = next.catch(() => undefined);
    queues.set(userId, tail);
    void tail.then(() => {
      if (queues.get(userId) === tail) queues.delete(userId);
    });
    return next;
  }

  function checkUserId(userId: unknown): string {
    if (typeof userId !== "string" || !USER_ID_RE.test(userId)) {
      throw new SecureStorageError(
        "Malformed",
        "userId is not a lowercase UUID",
      );
    }
    return userId;
  }

  function checkAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new SecureStorageError(
        "SecureStorageUnavailable",
        "the OS keystore is not available",
      );
    }
    if (platform === "linux") {
      const backend = safeStorage.getSelectedStorageBackend?.() ?? "unknown";
      if (LINUX_REFUSED_BACKENDS.has(backend)) {
        throw new SecureStorageError(
          "SecureStorageUnavailable",
          `safeStorage backend "${backend}" is not an OS keystore`,
        );
      }
    }
  }

  function decode(file: Buffer): Uint8Array<ArrayBuffer> {
    let text: string;
    try {
      text = safeStorage.decryptString(file);
    } catch {
      // For example, a denied keychain prompt or a changed keyring password.
      throw new SecureStorageError(
        "SecureStorageUnavailable",
        "the OS keystore cannot decrypt the wrap key",
      );
    }
    const b64 = text.startsWith(PAYLOAD_PREFIX)
      ? text.slice(PAYLOAD_PREFIX.length)
      : null;
    const raw = b64 !== null ? Buffer.from(b64, "base64") : null;
    if (
      !raw ||
      raw.length !== WRAP_KEY_BYTES ||
      raw.toString("base64") !== b64
    ) {
      raw?.fill(0);
      throw new SecureStorageError(
        "StoreCorrupt",
        "the wrap key file is corrupt",
      );
    }
    const out = new Uint8Array(WRAP_KEY_BYTES);
    out.set(raw);
    raw.fill(0);
    return out;
  }

  async function readExisting(
    path: string,
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    let st;
    try {
      st = await fs.lstat(path);
    } catch (e) {
      if (errCode(e) === "ENOENT") return null;
      throw e;
    }
    if (!st.isFile()) {
      throw new SecureStorageError(
        "StoreCorrupt",
        "the wrap key path is not a file",
      );
    }
    return decode(await fs.readFile(path));
  }

  /** Writes a temp file, then hard-links it to `path`. The link fails when `path` exists, so it never replaces a key. */
  async function create(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const raw = randomBytes(WRAP_KEY_BYTES);
    if (raw.length !== WRAP_KEY_BYTES)
      throw new Error("randomBytes returned a short buffer");
    const encrypted = safeStorage.encryptString(
      PAYLOAD_PREFIX + raw.toString("base64"),
    );
    const tmp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
    const handle = await fs.open(tmp, "wx", 0o600);
    try {
      try {
        await handle.writeFile(encrypted);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.link(tmp, path);
      } catch (e) {
        if (errCode(e) === "EEXIST") {
          raw.fill(0);
          return null;
        }
        throw e;
      }
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
    await syncDir();
    const out = new Uint8Array(WRAP_KEY_BYTES);
    out.set(raw);
    raw.fill(0);
    return out;
  }

  async function syncDir(): Promise<void> {
    if (platform === "win32") return;
    const h = await fs.open(dir, "r").catch(() => null);
    if (!h) return;
    await h.sync().catch(() => undefined);
    await h.close();
  }

  return {
    async getWrapKeyBytes(input) {
      const userId = checkUserId(input);
      return serial(userId, async () => {
        checkAvailable();
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const path = join(dir, `${userId}.bin`);
        const existing = await readExisting(path);
        if (existing) return existing;
        // Another process made the file between the read and the link: use its key.
        const made = (await create(path)) ?? (await readExisting(path));
        if (!made) throw new Error("the wrap key file disappeared");
        return made;
      });
    },
    async clear(input) {
      const userId = checkUserId(input);
      return serial(userId, async () => {
        try {
          await fs.unlink(join(dir, `${userId}.bin`));
        } catch (e) {
          if (errCode(e) !== "ENOENT") throw e;
        }
      });
    },
  };
}

/** Runs one IPC call and gives the result as data. Other errors become SecureStorageUnavailable. */
export async function toIpcResult<T>(
  run: () => Promise<T>,
): Promise<SecureStorageResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    if (e instanceof SecureStorageError) {
      return { ok: false, code: e.code, message: e.message };
    }
    console.warn("[hachiman] secure storage failed", e);
    return {
      ok: false,
      code: "SecureStorageUnavailable",
      message: "the wrap key store failed",
    };
  }
}
