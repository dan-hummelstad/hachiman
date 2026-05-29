import dns from "dns";
import net from "net";
import type { RegionProbeTarget } from "@hachiman/hachiman-node";

/**
 * Security guard for the `hachiman:probe-regions` IPC handler.
 *
 * ## Why this exists
 *
 * The renderer runs with `nodeIntegration: true` / `contextIsolation: false`,
 * so any XSS in the renderer can call `ipcRenderer.invoke('hachiman:probe-regions', …)`
 * with attacker-chosen targets. The probe targets themselves originate from the
 * PUBLIC, UNAUTHENTICATED `GET /api/regions` Oracle endpoint, so a hostile or
 * MITM'd Oracle can also pick what gets probed. Without validation the handler
 * is an SSRF / internal-port-scan primitive: arbitrary host + arbitrary port +
 * unbounded count, executed from the main process via raw `net` sockets (the
 * prober's `concurrency` only caps *simultaneous* sockets per chunk, never the
 * total reach).
 *
 * This module validates the untrusted payload AT THE MAIN-PROCESS BOUNDARY
 * before it ever reaches `probeRegionsRtt`:
 *  1. SHAPE — the IPC payload is `unknown` at runtime (the `RegionProbeTarget[]`
 *     type is erased across the IPC boundary); reject anything that isn't an
 *     array of `{ host: string, port?: number, code: string }`.
 *  2. HOST  — DNS-resolve the host and reject if the host *or any resolved IP*
 *     is non-public (loopback / private / link-local / metadata / unspecified,
 *     IPv4 and IPv6, including IPv4-mapped-IPv6 forms). We check the RESOLVED
 *     IPs, not just the literal, to defeat DNS-rebinding: a public-looking name
 *     (`db.internal.example.com`) can resolve to `10.0.0.5`.
 *  3. PORT  — allowlist only the Mumble port (64738) and 443 (the public-HTTPS
 *     dev-placeholder endpoints the Oracle seed ships with). Anything else is a
 *     port-scan attempt.
 *  4. COUNT — cap accepted targets at 64, mirroring the Oracle
 *     `recommend-region` endpoint's `z.array(...).max(64)`.
 *
 * The resolver is INJECTABLE so the host classification is unit-testable without
 * real DNS (see `probe-target-guard.test.mts`).
 */

/** Ports a probe target is allowed to hit. 64738 = Mumble; 443 = dev HTTPS placeholders. */
export const ALLOWED_PROBE_PORTS: ReadonlySet<number> = new Set([64738, 443]);

/** Max number of targets accepted in one probe call (mirrors Oracle's `.max(64)`). */
export const MAX_PROBE_TARGETS = 64;

/**
 * Subset of `dns.promises.lookup(host, { all: true })`'s result we care about.
 * Declared locally so the resolver can be mocked in tests without importing dns.
 */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Injectable host resolver. Production wiring uses {@link defaultResolver}. */
export type HostResolver = (host: string) => Promise<ResolvedAddress[]>;

/**
 * Default resolver backed by node DNS. `{ all: true }` returns every A/AAAA
 * record so we can reject a host that resolves to *any* private IP (not just
 * the first). `verbatim: true` keeps the OS-returned order (irrelevant here —
 * we check them all).
 */
export const defaultResolver: HostResolver = (host) =>
  dns.promises.lookup(host, { all: true, verbatim: true });

/**
 * Parse a dotted-quad IPv4 string into its four octets, or `null` if it isn't a
 * well-formed IPv4 literal. Used both for bare IPv4 literals and the trailing
 * dotted-quad of an IPv4-mapped IPv6 address.
 */
function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // Reject empty / non-numeric / out-of-range / leading-zero-padded weirdness.
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/** True if a dotted-quad IPv4 is in a non-public range. */
function isPrivateIpv4(ip: string): boolean {
  const octets = parseIpv4Octets(ip);
  if (!octets) return false; // not an IPv4 literal — caller handles other forms
  const [a, b] = octets;
  // 0.0.0.0/8 — "this host on this network" / unspecified.
  if (a === 0) return true;
  // 127.0.0.0/8 — loopback.
  if (a === 127) return true;
  // 10.0.0.0/8 — private.
  if (a === 10) return true;
  // 172.16.0.0/12 — private (172.16 – 172.31).
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private.
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local (includes 169.254.169.254 cloud metadata).
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * True if an IPv6 literal is in a non-public range, INCLUDING IPv4-mapped
 * (`::ffff:a.b.c.d` / `::ffff:7f00:1`) and IPv4-compatible (`::a.b.c.d`) forms
 * whose embedded IPv4 is private.
 */
function isPrivateIpv6(ipRaw: string): boolean {
  // Strip a zone id (`fe80::1%eth0`) before classifying.
  const ip = ipRaw.split("%")[0]!.toLowerCase();

  // Unspecified `::` and loopback `::1`.
  if (ip === "::" || ip === "::1") return true;

  // IPv4-mapped / IPv4-compatible: a trailing dotted-quad — classify the embedded v4.
  const lastColon = ip.lastIndexOf(":");
  if (lastColon !== -1) {
    const tail = ip.slice(lastColon + 1);
    if (tail.includes(".") && isPrivateIpv4(tail)) return true;
  }
  // IPv4-mapped in pure-hex form, e.g. ::ffff:7f00:1 == 127.0.0.1.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16);
    const lo = parseInt(hexMapped[2]!, 16);
    const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    if (isPrivateIpv4(dotted)) return true;
  }

  // fc00::/7 — Unique Local Addresses (first byte 0xfc or 0xfd).
  if (/^f[cd][0-9a-f]{0,2}:/.test(ip)) return true;
  // fe80::/10 — link-local (first 10 bits 1111111010 → fe8 / fe9 / fea / feb).
  if (/^fe[89ab][0-9a-f]?:/.test(ip)) return true;

  return false;
}

/**
 * Classify an IP literal (v4 or v6) as non-public. Exported for tests.
 * Returns `false` for strings that aren't IP literals at all.
 */
export function isPrivateIp(ip: string): boolean {
  switch (net.isIP(ip)) {
    case 4:
      return isPrivateIpv4(ip);
    case 6:
      return isPrivateIpv6(ip);
    default:
      return false;
  }
}

/** Narrowing type guard for a single raw target object off the IPC wire. */
function isWellShapedTarget(value: unknown): value is RegionProbeTarget {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  if (typeof t.host !== "string" || t.host.length === 0) return false;
  if (typeof t.code !== "string" || t.code.length === 0) return false;
  if (t.port !== undefined) {
    if (typeof t.port !== "number" || !Number.isInteger(t.port)) return false;
  }
  return true;
}

/**
 * Resolve `host` and decide whether it is safe to probe. A host is rejected if:
 *  - it is an IP literal in a non-public range, OR
 *  - it is a name that resolves to *zero* addresses, OR
 *  - it resolves to *any* non-public address (DNS-rebinding / SSRF defense).
 *
 * Resolution failures (NXDOMAIN, etc.) reject the target — fail closed.
 */
async function isHostSafe(
  host: string,
  resolver: HostResolver,
): Promise<boolean> {
  // If the host is already an IP literal, classify it directly — no DNS needed.
  if (net.isIP(host) !== 0) {
    return !isPrivateIp(host);
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(host);
  } catch {
    return false; // unresolvable → reject (fail closed)
  }
  if (addresses.length === 0) return false;
  // Every resolved address must be public.
  return addresses.every((a) => !isPrivateIp(a.address));
}

/**
 * Validate and filter an untrusted IPC probe payload. Returns the subset of
 * targets that are safe to hand to `probeRegionsRtt`:
 *  - drops malformed entries,
 *  - drops disallowed ports,
 *  - drops hosts that are / resolve to non-public IPs,
 *  - caps the result at {@link MAX_PROBE_TARGETS}.
 *
 * Never throws on bad input — a non-array payload yields `[]`.
 */
export async function validateProbeTargets(
  input: unknown,
  resolver: HostResolver = defaultResolver,
): Promise<RegionProbeTarget[]> {
  if (!Array.isArray(input)) return [];

  // Cap BEFORE doing any DNS/socket work so an oversized payload can't force
  // 64+ DNS lookups; we only ever consider the first MAX_PROBE_TARGETS.
  const candidates = input.slice(0, MAX_PROBE_TARGETS);

  const checks = await Promise.all(
    candidates.map(async (raw): Promise<RegionProbeTarget | null> => {
      if (!isWellShapedTarget(raw)) return null;
      // Port allowlist. `undefined` → prober uses the Mumble default (64738),
      // which is allow-listed, so an omitted port is fine.
      if (raw.port !== undefined && !ALLOWED_PROBE_PORTS.has(raw.port)) {
        return null;
      }
      if (!(await isHostSafe(raw.host, resolver))) return null;
      return raw;
    }),
  );

  return checks.filter((t): t is RegionProbeTarget => t !== null);
}
