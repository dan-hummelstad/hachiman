import type { IPlatformService } from "@hachiman/hachiman";

type ISecureStorage = IPlatformService["secureStorage"];
type FailureCode = "SecureStorageUnavailable" | "StoreCorrupt" | "Malformed";

/**
 * Browser `secureStorage` (docs/gateway-protocol.md §11, §12.17): a non-extractable
 * AES-GCM 256 `CryptoKey` per user, kept as a key object in the IndexedDB database
 * `hachiman-wrap`. The raw bytes never exist in JavaScript. Script on this origin can
 * still use the key, which is why the browser host "trusts the server's code".
 */
export const WRAP_DB_NAME = "hachiman-wrap";
const STORE = "keys";
const DB_VERSION = 1;
const USER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface BrowserSecureStorageDeps {
  indexedDB?: IDBFactory | undefined;
  subtle?: SubtleCrypto | undefined;
}

function fail(code: FailureCode, message: string): Error {
  const e = Object.assign(new Error(message), { code });
  e.name = code;
  return e;
}

function isWrapKey(v: unknown): v is CryptoKey {
  if (typeof CryptoKey === "undefined" || !(v instanceof CryptoKey))
    return false;
  const alg = v.algorithm as Partial<AesKeyAlgorithm>;
  return (
    v.type === "secret" &&
    !v.extractable &&
    alg.name === "AES-GCM" &&
    alg.length === 256 &&
    v.usages.includes("encrypt") &&
    v.usages.includes("decrypt")
  );
}

export function createBrowserSecureStorage(
  deps: BrowserSecureStorageDeps = {
    indexedDB: globalThis.indexedDB,
    subtle: globalThis.crypto?.subtle,
  },
): ISecureStorage {
  let dbPromise: Promise<IDBDatabase> | null = null;

  function checkUserId(userId: unknown): string {
    if (typeof userId !== "string" || !USER_ID_RE.test(userId)) {
      throw fail("Malformed", "userId is not a lowercase UUID");
    }
    return userId;
  }

  function idb(): IDBFactory {
    if (!deps.indexedDB) {
      throw fail("SecureStorageUnavailable", "IndexedDB is not available");
    }
    return deps.indexedDB;
  }

  function open(): Promise<IDBDatabase> {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb().open(WRAP_DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Let a later schema version (another tab) upgrade; open again on the next call.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () =>
        reject(new Error("another tab blocks the wrap key database"));
    }).catch((e: unknown) => {
      dbPromise = null;
      throw fail(
        "SecureStorageUnavailable",
        `cannot open ${WRAP_DB_NAME}: ${String(e)}`,
      );
    });
    return dbPromise;
  }

  /** One transaction. `body` queues requests synchronously; resolves on commit. */
  async function tx<T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore, done: (v: T) => void) => void,
  ): Promise<T> {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      let value: T | undefined;
      let t: IDBTransaction;
      try {
        t = db.transaction(STORE, mode);
        body(t.objectStore(STORE), (v) => (value = v));
      } catch (e) {
        reject(fail("SecureStorageUnavailable", String(e)));
        return;
      }
      t.oncomplete = () => resolve(value as T);
      t.onabort = t.onerror = () =>
        reject(fail("SecureStorageUnavailable", String(t.error)));
    });
  }

  function read(userId: string): Promise<unknown> {
    return tx<unknown>("readonly", (store, done) => {
      const r = store.get(userId);
      r.onsuccess = () => done(r.result);
    });
  }

  function checked(v: unknown): CryptoKey {
    if (!isWrapKey(v))
      throw fail(
        "StoreCorrupt",
        "the stored wrap key is not a non-extractable AES-GCM 256 key",
      );
    return v;
  }

  return {
    backend: "browser-indexeddb",
    async getWrapKey(input) {
      const userId = checkUserId(input);
      const existing = await read(userId);
      if (existing !== undefined) return checked(existing);

      if (!deps.subtle)
        throw fail("SecureStorageUnavailable", "WebCrypto is not available");
      let fresh: CryptoKey;
      try {
        fresh = await deps.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
      } catch (e) {
        throw fail(
          "SecureStorageUnavailable",
          `cannot make a wrap key: ${String(e)}`,
        );
      }
      // Another tab can write first: read again in the write transaction and keep
      // the stored key. `add` never replaces a key.
      const stored = await tx<unknown>("readwrite", (store, done) => {
        const r = store.get(userId);
        r.onsuccess = () => {
          if (r.result !== undefined) {
            done(r.result);
          } else {
            store.add(fresh, userId);
            done(fresh);
          }
        };
      });
      return checked(stored);
    },
    async clear(input) {
      const userId = checkUserId(input);
      await tx<void>("readwrite", (store) => {
        store.delete(userId);
      });
    },
  };
}
