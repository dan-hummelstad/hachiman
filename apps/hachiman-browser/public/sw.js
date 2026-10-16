// The service worker of the browser host: end-to-end encrypted Web Push (contract §4 Push,
// §12.22). The sender seals the sender name and the text to the push key of this browser.
// Takusen relays the sealed preview inside an RFC 8291 payload, and this worker opens it.
//
// The push key is a non-extractable ECDH P-256 key. This worker makes it (op "push-key" from the
// page) and keeps it in IndexedDB, so no page script ever holds it. It keeps the key before the
// current one too: a push that was sealed before a rotation still opens.

const DB = "hachiman-push";
const STORE = "keys";

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, run) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(out.result);
    t.onerror = () => reject(t.error);
  });
}

const b64u = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const unb64u = (s) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );

async function rotateKey(deviceId) {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const pub = new Uint8Array(
    await crypto.subtle.exportKey("raw", kp.publicKey),
  );
  // One transaction: two rotations at once cannot both move the same key to "previous".
  await tx("readwrite", (s) => {
    const current = s.get("current");
    current.onsuccess = () => {
      if (current.result) s.put(current.result, "previous");
      s.put({ priv: kp.privateKey, pub, deviceId }, "current");
    };
    return current;
  });
  return b64u(pub);
}

// MARK: - HPKE (RFC 9180), base mode, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM

const enc = (s) => new TextEncoder().encode(s);
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};
const u16 = (n) => new Uint8Array([n >> 8, n & 255]);
const KEM_ID = cat(enc("KEM"), u16(0x10));
const SUITE_ID = cat(enc("HPKE"), u16(0x10), u16(1), u16(2));

async function hmac(key, data) {
  const k = await crypto.subtle.importKey(
    "raw",
    key.length > 0 ? key : new Uint8Array(32),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
const extract = (suite, salt, label, ikm) =>
  hmac(salt, cat(enc("HPKE-v1"), suite, enc(label), ikm));
// One HMAC block: every length here is 32 or less.
const expand = async (suite, prk, label, info, len) =>
  (
    await hmac(
      prk,
      cat(
        u16(len),
        enc("HPKE-v1"),
        suite,
        enc(label),
        info,
        new Uint8Array([1]),
      ),
    )
  ).slice(0, len);

/** Opens a sealed preview (base64url enc ‖ ct) with one stored key. Throws when it does not fit. */
async function openPreview(key, sealed) {
  const bytes = unb64u(sealed);
  const pkE = bytes.slice(0, 65);
  const ct = bytes.slice(65);
  const pub = await crypto.subtle.importKey(
    "raw",
    pkE,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const dh = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: pub },
      key.priv,
      256,
    ),
  );
  const eae = await extract(KEM_ID, new Uint8Array(), "eae_prk", dh);
  const shared = await expand(
    KEM_ID,
    eae,
    "shared_secret",
    cat(pkE, key.pub),
    32,
  );
  const pskIdHash = await extract(
    SUITE_ID,
    new Uint8Array(),
    "psk_id_hash",
    new Uint8Array(),
  );
  const infoHash = await extract(
    SUITE_ID,
    new Uint8Array(),
    "info_hash",
    enc("hachiman push preview v1"),
  );
  const context = cat(new Uint8Array([0]), pskIdHash, infoHash);
  const secret = await extract(SUITE_ID, shared, "secret", new Uint8Array());
  const k = await expand(SUITE_ID, secret, "key", context, 32);
  const nonce = await expand(SUITE_ID, secret, "base_nonce", context, 12);
  const aes = await crypto.subtle.importKey("raw", k, "AES-GCM", false, [
    "decrypt",
  ]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: enc(key.deviceId) },
    aes,
    ct,
  );
  return JSON.parse(new TextDecoder().decode(pt));
}
self.hachimanOpenPreview = openPreview;

/** The sender and text of a push, or "New message" when it has none or none opens. */
async function previewOf(data) {
  if (data && typeof data.e === "string") {
    for (const name of ["current", "previous"]) {
      const key = await tx("readonly", (s) => s.get(name));
      if (!key) continue;
      try {
        const p = await openPreview(key, data.e);
        if (typeof p.t === "string" && typeof p.b === "string") return p;
      } catch {
        // Another key, or a forged preview: try the next one, then the fallback.
      }
    }
  }
  return { t: "Hachiman", b: "New message" };
}

self.addEventListener("message", (event) => {
  const port = event.ports[0];
  if (event.data?.op !== "push-key" || !port) return;
  event.waitUntil(
    rotateKey(String(event.data.deviceId)).then(
      (pushKey) => port.postMessage({ pushKey }),
      (e) => port.postMessage({ error: String(e) }),
    ),
  );
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window" });
      // A focused tab shows the message itself. Browsers want a notification for each push,
      // but allow one now and then without.
      if (windows.some((w) => w.focused)) return;
      let data = null;
      try {
        data = event.data ? event.data.json() : null;
      } catch {
        data = null;
      }
      const p = await previewOf(data);
      await self.registration.showNotification(p.t, {
        body: p.b,
        // A preview is one message; "New message" replaces the one before of its channel.
        ...(p.c ? {} : { tag: data?.c ?? "message" }),
        icon: "/favicon.png",
        // The channel to open on a click. From Takusen's outer layer: the click opens a chat
        // that this account can open, or nothing (PushService checks the channel).
        data: { c: typeof data?.c === "string" ? data.c : null },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const channelId = event.notification.data?.c ?? null;
      const [open] = await self.clients.matchAll({ type: "window" });
      if (open) {
        await open.focus();
        if (channelId) open.postMessage({ op: "open-channel", channelId });
      } else {
        await self.clients.openWindow(
          channelId ? `/?channel=${encodeURIComponent(channelId)}` : "/",
        );
      }
    })(),
  );
});
