import dns from "node:dns";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import net from "node:net";
import type { LinkResourceInfo } from "../shared/ipc.ts";
import { isPrivateIp } from "./probe-target-guard.ts";

/**
 * The `hachiman:fetch-link` IPC handler: one GET for a link preview (contract §11
 * `fetchLinkResource`, §12.8.1). Only the sender's own device runs it, for a link in a
 * message that it sends.
 *
 * A renderer XSS reaches this through the preload bridge, so main treats every argument
 * as hostile: https only, no credentials in the URL, no cookies (Node https has no
 * cookie jar), at most MAX_REDIRECTS hops (each checked again), a total timeout, a
 * body cap. The connect-time `lookup` refuses loopback, private and link-local
 * addresses, so a DNS rebind between a check and the connect cannot reach them.
 */

export const MAX_REDIRECTS = 3;
export const TIMEOUT_MS = 8000;
/** The largest body a caller may ask for. */
export const MAX_BYTES_CAP = 8 * 1024 * 1024;
const USER_AGENT = "Mozilla/5.0 (compatible; HachimanLinkPreview/1.0)";

type LookupAll = (
  host: string,
  cb: (err: Error | null, addresses: dns.LookupAddress[]) => void,
) => void;

const systemLookup: LookupAll = (host, cb) =>
  dns.lookup(host, { all: true }, cb);

/**
 * A `net` lookup that fails when the host resolves to any non-public address. It
 * answers both forms: `all` (Happy Eyeballs) and a single address.
 */
export function publicLookup(
  resolve: LookupAll = systemLookup,
): net.LookupFunction {
  return ((
    host: string,
    options: dns.LookupOptions,
    cb: (...args: unknown[]) => void,
  ) => {
    resolve(host, (err, addresses) => {
      if (err) return cb(err);
      if (
        addresses.length === 0 ||
        addresses.some((a) => isPrivateIp(a.address))
      ) {
        return cb(
          Object.assign(new Error(`refused non-public host ${host}`), {
            code: "EREFUSED",
          }),
        );
      }
      if (options.all) return cb(null, addresses);
      cb(null, addresses[0]!.address, addresses[0]!.family);
    });
  }) as net.LookupFunction;
}

export type Get = (url: URL, signal: AbortSignal) => Promise<IncomingMessage>;

const httpsGet =
  (lookup: net.LookupFunction): Get =>
  (url, signal) =>
    new Promise((resolve, reject) => {
      https
        .get(url, {
          lookup,
          signal,
          headers: {
            "user-agent": USER_AGENT,
            accept: "text/html,image/*;q=0.9",
          },
        })
        .on("response", resolve)
        .on("error", reject);
    });

const bareHost = (u: URL): string => u.hostname.replace(/^\[|\]$/g, "");

/** null for any refusal or failure. Never throws. */
export async function fetchLinkResource(
  rawUrl: unknown,
  rawMaxBytes: unknown,
  get: Get = httpsGet(publicLookup()),
): Promise<LinkResourceInfo | null> {
  if (typeof rawUrl !== "string" || typeof rawMaxBytes !== "number")
    return null;
  if (!Number.isInteger(rawMaxBytes) || rawMaxBytes <= 0) return null;
  const maxBytes = Math.min(rawMaxBytes, MAX_BYTES_CAP);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    let url = new URL(rawUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (url.protocol !== "https:" || url.username || url.password)
        return null;
      // An IP literal skips the lookup, so it is checked here.
      if (net.isIP(bareHost(url)) !== 0 && isPrivateIp(bareHost(url)))
        return null;
      const res = await get(url, signal);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.destroy();
        url = new URL(location, url);
        continue;
      }
      if (status !== 200) {
        res.destroy();
        return null;
      }
      const contentType = (res.headers["content-type"] ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();
      const body = await readCapped(res, maxBytes, HTML_TYPES.has(contentType));
      if (!body) return null;
      return { url: url.href, contentType, body };
    }
    return null;
  } catch {
    return null;
  }
}

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const HEAD_END = "</head>";

/**
 * The body, or null past `maxBytes` (the response is destroyed at once). With `untilHeadEnd`
 * (HTML) it stops after `</head>`: a preview needs only the head, and a slow server (Airbnb)
 * streams the rest for seconds.
 */
async function readCapped(
  res: IncomingMessage,
  maxBytes: number,
  untilHeadEnd: boolean,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(res.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.destroy();
    return null;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      res.destroy();
      return null;
    }
    // The marker can straddle two chunks, so the search includes the end of the previous one.
    const seen = Buffer.concat([
      chunks.at(-1)?.subarray(-HEAD_END.length) ?? Buffer.alloc(0),
      chunk,
    ]);
    chunks.push(chunk);
    if (
      untilHeadEnd &&
      seen.toString("latin1").toLowerCase().includes(HEAD_END)
    ) {
      res.destroy();
      break;
    }
  }
  return new Uint8Array(Buffer.concat(chunks));
}
