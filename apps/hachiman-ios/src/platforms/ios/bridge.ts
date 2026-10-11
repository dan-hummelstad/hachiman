/**
 * JS → native calls of the iOS host (docs/ios-app-plan.md Phase 2, "Bridge").
 * One message handler, `hachiman`, registered as a WKScriptMessageHandlerWithReply
 * (Hachiman/Bridge.swift): `postMessage({ op, ...args })` resolves with the reply
 * value, or rejects with the text "Code: message". Native accepts a message only
 * from the main frame on `hachiman://app`.
 *
 * Pure apart from the `window.webkit` lookup at call time, so `node --test` can
 * load it with a fake handler.
 */
import type { Appearance, HapticKind, ShareContent } from "@hachiman/hachiman";

/** The error codes of a native rejection. */
export type BridgeErrorCode =
  | "SecureStorageUnavailable"
  | "StoreCorrupt"
  | "Malformed"
  | "Unsupported"
  | "Cancelled"
  | "Internal";

const CODES: readonly BridgeErrorCode[] = [
  "SecureStorageUnavailable",
  "StoreCorrupt",
  "Malformed",
  "Unsupported",
  "Cancelled",
  "Internal",
];

/** Each op: [arguments, reply value]. */
export interface BridgeOps {
  ready: [Record<string, never>, null];
  /** Base64 of the 32 wrap key bytes (Keychain, created on the first call). */
  "wrapKey.get": [{ userId: string }, string];
  "wrapKey.clear": [{ userId: string }, null];
  /** ASWebAuthenticationSession; the callback arrives as the `oauth-callback` event. */
  "oauth.begin": [{ url: string }, null];
  haptic: [{ kind: HapticKind }, null];
  /** False when the user closed the share sheet. */
  share: [ShareContent, boolean];
  /** The text of the scanned QR code, or null when the user closed the scanner. */
  scanQr: [Record<string, never>, string | null];
  /** The Files export sheet (Hachiman/Native.swift). False when the user closed it. */
  saveTextFile: [{ name: string; text: string }, boolean];
  /** `background`: a hex color (`#rrggbb` or `#rrggbbaa`) behind the safe areas. */
  setAppearance: [Appearance, null];
}

export type BridgeOp = keyof BridgeOps;

/** The part of `window.webkit.messageHandlers.hachiman` that the bridge uses. */
export interface MessageHandler {
  postMessage(message: unknown): Promise<unknown>;
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { hachiman?: MessageHandler } };
  }
}

/** A native rejection: `name` and `code` are the bridge error code. */
export type BridgeError = Error & { code: BridgeErrorCode };

export function bridgeError(
  code: BridgeErrorCode,
  message: string,
): BridgeError {
  const e = Object.assign(new Error(message), { code });
  e.name = code;
  return e;
}

/** "Code: message" (a string, or the message of the Error WebKit makes from it) → BridgeError. */
export function toBridgeError(reason: unknown): BridgeError {
  const text =
    typeof reason === "string"
      ? reason
      : reason instanceof Error
        ? reason.message
        : String(reason);
  const m = /^([A-Za-z]+): ?([\s\S]*)$/.exec(text);
  if (m && (CODES as readonly string[]).includes(m[1])) {
    return bridgeError(m[1] as BridgeErrorCode, m[2]);
  }
  return bridgeError("Internal", text);
}

export type BridgeCall = <K extends BridgeOp>(
  op: K,
  args: BridgeOps[K][0],
) => Promise<BridgeOps[K][1]>;

/** A `call` over `handler()`; with no handler (a plain browser, `vite` dev) every op rejects Unsupported. */
export function createBridge(
  handler: () => MessageHandler | undefined,
): BridgeCall {
  return async (op, args) => {
    const h = handler();
    if (!h) throw bridgeError("Unsupported", "no native bridge");
    try {
      return (await h.postMessage({ ...args, op })) as never;
    } catch (e) {
      throw toBridgeError(e);
    }
  };
}

export const call: BridgeCall = createBridge(
  () => globalThis.window?.webkit?.messageHandlers?.hachiman,
);
