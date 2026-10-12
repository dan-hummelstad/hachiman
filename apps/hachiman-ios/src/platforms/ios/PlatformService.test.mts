/**
 * Tests for the iOS PlatformService (./PlatformService.ts) with a fake bridge:
 * OAuth and invite forwarding from the native events, the bridge ops, and the
 * wrap key. The invite grammar has its own tests in @hachiman/client. Run via
 * the package `test` script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { InviteLink } from "@hachiman/hachiman/invite-link";
import { createIosPlatformService } from "./PlatformService.ts";
import type { IPlatformService } from "@hachiman/hachiman";
import { createNativeEvents, type NativeEvents } from "./native-events.ts";
import {
  bridgeError,
  createBridge,
  toBridgeError,
  type BridgeCall,
} from "./bridge.ts";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const USER = "0b8f7a7e-3c1d-4e2f-9a6b-5c4d3e2f1a0b";

interface Sent {
  op: string;
  args: unknown;
}

function fakeBridge(reply: (op: string, args: unknown) => unknown): {
  call: BridgeCall;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const call = (async (op: string, args: unknown) => {
    sent.push({ op, args });
    return reply(op, args);
  }) as BridgeCall;
  return { call, sent };
}

interface Setup {
  ps: IPlatformService;
  events: NativeEvents;
  call: BridgeCall;
  sent: Sent[];
}

function setup(
  reply: (op: string, args: unknown) => unknown = () => null,
): Setup {
  const events = createNativeEvents();
  const bridge = fakeBridge(reply);
  return {
    ps: createIosPlatformService(bridge.call, events),
    events,
    ...bridge,
  };
}

test("seam constants", () => {
  const { ps } = setup();
  assert.equal(ps.platform, "ios");
  assert.equal(ps.oauthRedirectUri, "app.hachiman://oauth-callback");
  assert.equal(ps.insetTitleBar, false);
  assert.equal(ps.secureStorage.backend, "os-keychain");
  assert.equal(ps.closeToTray, null);
});

test("beginOAuth sends oauth.begin with the url", async () => {
  const { ps, sent } = setup();
  ps.beginOAuth("https://id.example/auth?x=1");
  await Promise.resolve();
  assert.deepEqual(sent, [
    { op: "oauth.begin", args: { url: "https://id.example/auth?x=1" } },
  ]);
});

test("an oauth-callback event before the UI subscribes reaches onOAuthCallback", () => {
  const { ps, events } = setup();
  events.emit("oauth-callback", {
    url: "app.hachiman://oauth-callback?code=c&state=s",
  });
  const got: string[] = [];
  const off = ps.onOAuthCallback((u) => got.push(u));
  events.emit("oauth-callback", {
    url: "app.hachiman://oauth-callback?error=x",
  });
  off();
  events.emit("oauth-callback", { url: "later" });
  assert.deepEqual(got, [
    "app.hachiman://oauth-callback?code=c&state=s",
    "app.hachiman://oauth-callback?error=x",
  ]);
});

test("invite-link events are parsed, and a link that does not parse opens nothing", () => {
  const { ps, events } = setup();
  events.emit("invite-link", { url: `takusen://invite/nt0wl5x#k=${KEY}` });
  events.emit("invite-link", { url: "takusen://invite/nt0wl5x#k=" });
  const got: InviteLink[] = [];
  ps.onInviteLink((l) => got.push(l));
  events.emit("invite-link", { url: "takusen://invite/abc123" });
  assert.deepEqual(got, [
    { code: "nt0wl5x", key: KEY },
    { code: "abc123", key: null },
  ]);
});

test("haptic, share, scanQr and setAppearance use their bridge ops", async () => {
  const { ps, sent } = setup((op) =>
    op === "share" ? false : op === "scanQr" ? "qr-text" : null,
  );
  ps.haptic("success");
  assert.equal(await ps.share!({ url: "https://x/invite/a" }), false);
  assert.equal(await ps.scanQr!(), "qr-text");
  ps.setAppearance({ theme: "light", background: "#ffffff" });
  await Promise.resolve();
  assert.deepEqual(sent, [
    { op: "haptic", args: { kind: "success" } },
    { op: "share", args: { url: "https://x/invite/a" } },
    { op: "scanQr", args: {} },
    { op: "setAppearance", args: { theme: "light", background: "#ffffff" } },
  ]);
});

test("saveTextFile sends its bridge op, and a bridge rejection passes through", async () => {
  const { ps, sent } = setup(() => true);
  assert.equal(
    await ps.saveTextFile!("hachiman-recovery-key.txt", "abc\n"),
    true,
  );
  assert.deepEqual(sent, [
    {
      op: "saveTextFile",
      args: { name: "hachiman-recovery-key.txt", text: "abc\n" },
    },
  ]);
  const failing = setup(() => {
    throw bridgeError("Malformed", "no");
  });
  await assert.rejects(failing.ps.saveTextFile!("../x", "y"), {
    code: "Malformed",
  });
});

test("getWrapKey imports the bytes as a non-extractable AES-GCM key", async () => {
  const bytes = new Uint8Array(32).map((_, i) => i);
  const b64 = Buffer.from(bytes).toString("base64");
  const { ps, sent } = setup(() => b64);
  const key = await ps.secureStorage.getWrapKey(USER);
  assert.deepEqual(sent, [{ op: "wrapKey.get", args: { userId: USER } }]);
  assert.equal(key.extractable, false);
  assert.equal((key.algorithm as AesKeyAlgorithm).name, "AES-GCM");
  assert.equal((key.algorithm as AesKeyAlgorithm).length, 256);
  assert.deepEqual([...key.usages].sort(), ["decrypt", "encrypt"]);
});

test("getWrapKey rejects a wrong length as StoreCorrupt", async () => {
  const { ps } = setup(() => Buffer.alloc(16).toString("base64"));
  await assert.rejects(ps.secureStorage.getWrapKey(USER), {
    name: "StoreCorrupt",
    code: "StoreCorrupt",
  });
});

test("bridge errors map to the secure storage codes", async () => {
  for (const [code, want] of [
    ["SecureStorageUnavailable", "SecureStorageUnavailable"],
    ["StoreCorrupt", "StoreCorrupt"],
    ["Malformed", "Malformed"],
    ["Internal", "SecureStorageUnavailable"],
    ["Unsupported", "SecureStorageUnavailable"],
  ] as const) {
    const { ps } = setup(() => {
      throw bridgeError(code, "no");
    });
    await assert.rejects(ps.secureStorage.getWrapKey(USER), {
      name: want,
      code: want,
    });
    await assert.rejects(ps.secureStorage.clear(USER), { code: want });
  }
});

test("the bridge sends {op, ...args} and parses 'Code: message' rejections", async () => {
  const posted: unknown[] = [];
  const call = createBridge(() => ({
    postMessage: async (m: unknown) => {
      posted.push(m);
      if ((m as { op: string }).op === "wrapKey.get")
        throw new Error("SecureStorageUnavailable: no keychain");
      return true;
    },
  }));
  assert.equal(await call("share", { url: "u", text: "t" }), true);
  assert.deepEqual(posted, [{ url: "u", text: "t", op: "share" }]);
  await assert.rejects(call("wrapKey.get", { userId: USER }), {
    name: "SecureStorageUnavailable",
    code: "SecureStorageUnavailable",
    message: "no keychain",
  });
  await assert.rejects(createBridge(() => undefined)("ready", {}), {
    code: "Unsupported",
  });
});

test("toBridgeError: a string reason, and an unknown code is Internal", () => {
  assert.equal(toBridgeError("Malformed: bad url").code, "Malformed");
  assert.equal(toBridgeError("Malformed: bad url").message, "bad url");
  const e = toBridgeError("Weird: thing");
  assert.equal(e.code, "Internal");
  assert.equal(e.message, "Weird: thing");
});
