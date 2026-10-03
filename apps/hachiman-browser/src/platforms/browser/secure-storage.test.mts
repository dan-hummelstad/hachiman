/**
 * Tests for the browser wrap key store (./secure-storage.ts) on fake-indexeddb and
 * the WebCrypto of Node. Run via the package `test` script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { createBrowserSecureStorage } from "./secure-storage.ts";

test(
  "browser secure storage: create, reuse, tabs, bad userId, clear, corrupt records, no backend",
  async () => {
    const U = "0b6f2c4e-8d1a-4f3b-9c2e-5a7d1e0f3b29";
    const V = "7e1d9a03-2b4c-4d5e-8f60-1a2b3c4d5e6f";
    const factory = new IDBFactory();
    const s = createBrowserSecureStorage({
      indexedDB: factory,
      subtle: crypto.subtle,
    });
    assert.equal(s.backend, "browser-indexeddb");
    const k1 = await s.getWrapKey(U);
    assert.equal(k1.extractable, false);
    assert.equal((k1.algorithm as AesKeyAlgorithm).length, 256);
    await assert.rejects(crypto.subtle.exportKey("raw", k1));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      k1,
      new TextEncoder().encode("hi"),
    );
    // A second instance (another tab) gets the stored key.
    const s2 = createBrowserSecureStorage({
      indexedDB: factory,
      subtle: crypto.subtle,
    });
    const k1b = await s2.getWrapKey(U);
    assert.equal(
      new TextDecoder().decode(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv }, k1b, ct),
      ),
      "hi",
    );
    // Concurrent first calls agree.
    const [a, b] = await Promise.all([s.getWrapKey(V), s2.getWrapKey(V)]);
    const ct2 = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      a,
      new Uint8Array(1),
    );
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, b, ct2);
    // Bad ids.
    for (const bad of ["x", U.toUpperCase(), 1 as unknown as string]) {
      await assert.rejects(s.getWrapKey(bad), {
        code: "Malformed",
        name: "Malformed",
      });
      await assert.rejects(s.clear(bad), { code: "Malformed" });
    }
    // Clear makes a new key.
    await s.clear(U);
    const k2 = await s.getWrapKey(U);
    await assert.rejects(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, k2, ct),
    );
    // Corrupt record fails closed and stays.
    const db = await new Promise<IDBDatabase>((r) => {
      const q = factory.open("hachiman-wrap", 1);
      q.onsuccess = () => r(q.result);
    });
    await new Promise<void>((r) => {
      const t = db.transaction("keys", "readwrite");
      t.objectStore("keys").put("junk", U);
      t.oncomplete = () => r();
    });
    await assert.rejects(s.getWrapKey(U), { code: "StoreCorrupt" });
    const ext = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    await new Promise<void>((r) => {
      const t = db.transaction("keys", "readwrite");
      t.objectStore("keys").put(ext, U);
      t.oncomplete = () => r();
    });
    await assert.rejects(s.getWrapKey(U), { code: "StoreCorrupt" });
    db.close();
    // No IndexedDB / no subtle.
    await assert.rejects(createBrowserSecureStorage({}).getWrapKey(U), {
      code: "SecureStorageUnavailable",
    });
    await assert.rejects(
      createBrowserSecureStorage({ indexedDB: new IDBFactory() }).getWrapKey(U),
      { code: "SecureStorageUnavailable" },
    );
  },
);
