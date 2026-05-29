import net from 'net';

/**
 * Region RTT prober — measures client→region latency so a server can be homed
 * (or re-homed) near its actual users rather than near its owner.
 *
 * ## What this measures, and why
 *
 * The *ideal* probe is Mumble's connectionless server-browser ping: a 12-byte
 * UDP datagram the Go server answers at `cmd/grumble/server.go`
 * (`udpListenLoop`, the `nread == 12` branch) with a 24-byte reply
 * `[version, echoed-nonce, userCount, maxUsers, maxBandwidth]`, no auth. It is
 * the lowest-overhead, most representative latency signal because Mumble voice
 * itself rides UDP. See `buildServerBrowserPing` / `parseServerBrowserPong`
 * below — those encode/decode that exact wire format and are ready for when raw
 * UDP lands in this client.
 *
 * BUT today this client has no raw UDP transport (`TODO.md`: "Add Node UDP
 * Socket support"), and browsers cannot open raw UDP sockets at all. So the
 * **buildable** probe here measures **TCP connect-time RTT**: the time from
 * `socket.connect()` to the `connect` event (the TCP three-way handshake
 * completing). The Mumble server listens for TLS/TCP on the *same* port it
 * answers UDP pings on, so connect-time RTT is a sound, well-understood proxy
 * for network distance — it is one network round-trip (SYN → SYN/ACK), exactly
 * like the UDP ping, just over TCP. It is available right now via node `net`
 * (the same primitive the TLS transport is built on) without touching the
 * protobuf wire or adding deps.
 *
 * Limitations (documented in PLACEMENT-DESIGN.md):
 *  - TCP connect adds nothing over UDP for the *first* RTT, but a dropped SYN
 *    is retransmitted on a coarse timer, so a single sample can over-report on
 *    a lossy path. We default to several samples and take the **min** (the
 *    cleanest round-trip observed), which is the standard ping-style estimator.
 *  - This is Node-only. In the browser, raw TCP is also unavailable; the
 *    browser host should measure via a WebSocket/HTTP handshake to a per-region
 *    endpoint instead (out of scope here — noted in the design doc).
 */

/** A region endpoint to probe. `port` defaults to the Mumble default (64738). */
export interface RegionProbeTarget {
  /** Region machine code, e.g. "us-east" — echoed back in the result. */
  code: string;
  host: string;
  port?: number;
}

/** Result of probing one region. */
export interface RegionProbeResult {
  code: string;
  host: string;
  port: number;
  /**
   * Best (minimum) measured connect-time RTT in milliseconds, or `null` if
   * every attempt failed (host unreachable / refused / timed out). `null`
   * feeds the placement scorer as "unrankable".
   */
  rttMs: number | null;
  /** Per-sample RTTs that succeeded (length ≤ `samples`). */
  samplesMs: number[];
  /** Populated when `rttMs` is null: the last error message seen. */
  error?: string;
}

export interface ProbeOptions {
  /** Per-attempt connect timeout in ms. Default 2000. */
  timeoutMs?: number;
  /** Number of connect samples per region; min is kept. Default 3. */
  samples?: number;
  /** Default port when a target omits one. Default 64738 (Mumble). */
  defaultPort?: number;
}

const DEFAULT_PORT = 64738;
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_SAMPLES = 3;

/**
 * One TCP connect, timed. Resolves the elapsed ms from `connect()` call to the
 * `connect` event; rejects on error/timeout. The socket is destroyed
 * immediately — we only want the handshake RTT, never to send data.
 *
 * @internal
 */
export const tcpConnectRtt = (
  host: string,
  port: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const start = performanceNow();
    let settled = false;
    const socket = new net.Socket();

    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      fn();
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      const rtt = performanceNow() - start;
      done(() => resolve(rtt));
    });
    socket.once('timeout', () => {
      done(() => reject(new Error(`connect timed out after ${timeoutMs}ms`)));
    });
    socket.once('error', (err: Error) => {
      done(() => reject(err));
    });

    socket.connect(port, host);
  });

/**
 * Probe a single region `samples` times and keep the best (min) RTT. Never
 * throws — failures are captured in the result's `rttMs: null` + `error`.
 */
export async function probeRegionRtt(
  target: RegionProbeTarget,
  options: ProbeOptions = {},
): Promise<RegionProbeResult> {
  const port = target.port ?? options.defaultPort ?? DEFAULT_PORT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const samples = Math.max(1, options.samples ?? DEFAULT_SAMPLES);

  const samplesMs: number[] = [];
  let lastError: string | undefined;

  for (let i = 0; i < samples; i++) {
    try {
      const rtt = await tcpConnectRtt(target.host, port, timeoutMs);
      samplesMs.push(rtt);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  const rttMs = samplesMs.length > 0 ? Math.min(...samplesMs) : null;
  const result: RegionProbeResult = {
    code: target.code,
    host: target.host,
    port,
    rttMs,
    samplesMs,
  };
  if (rttMs === null && lastError !== undefined) result.error = lastError;
  return result;
}

/**
 * Probe many regions concurrently. The returned array is in the same order as
 * `targets`. Feed `{ region: code, rttMs }` straight to the Oracle
 * `recommend-region` endpoint / the `scorePlacement` scorer.
 */
export async function probeRegionsRtt(
  targets: RegionProbeTarget[],
  options: ProbeOptions = {},
): Promise<RegionProbeResult[]> {
  return Promise.all(targets.map(t => probeRegionRtt(t, options)));
}

// ---------------------------------------------------------------------------
// IDEAL (future) prober: Mumble connectionless server-browser ping over UDP.
//
// Encode/decode helpers for the exact wire format the Go server already speaks.
// These are pure (Buffer in / out) and unit-tested; the actual datagram
// send/receive is intentionally NOT implemented here because this client has no
// UDP transport yet (TODO.md). When it lands, a UDP prober sends
// `buildServerBrowserPing()`, awaits the 24-byte reply, and computes
// `Date.now()/perf - sentAt` after `parseServerBrowserPong()` confirms the
// nonce echo. See PLACEMENT-DESIGN.md.
// ---------------------------------------------------------------------------

/** Decoded fields of the 24-byte server-browser pong. */
export interface ServerBrowserPong {
  /** Encoded Mumble version (the server sends (1<<16)|(2<<8)|2). */
  version: number;
  /** The 64-bit nonce the client put in the ping, echoed back (as BigInt). */
  nonce: bigint;
  userCount: number;
  maxUsers: number;
  maxBandwidth: number;
}

/**
 * Build the 12-byte connectionless ping datagram: a 32-bit request identifier
 * (0 — the server ignores it) followed by a 64-bit client nonce to correlate
 * the reply. Mirrors Mumble's ConnectDialog ping.
 *
 * @param nonce 64-bit value to echo; generate randomly per ping to match replies.
 */
export function buildServerBrowserPing(nonce: bigint): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(0, 0);
  buf.writeBigUInt64BE(BigInt.asUintN(64, nonce), 4);
  return buf;
}

/**
 * Parse the 24-byte server-browser pong. Throws on a short/oversized buffer.
 * Validate `nonce` against the one you sent before trusting the RTT.
 */
export function parseServerBrowserPong(buf: Buffer): ServerBrowserPong {
  if (buf.length < 24) {
    throw new Error(
      `server-browser pong too short: ${buf.length} bytes (need 24)`,
    );
  }
  return {
    version: buf.readUInt32BE(0),
    nonce: buf.readBigUInt64BE(4),
    userCount: buf.readUInt32BE(12),
    maxUsers: buf.readUInt32BE(16),
    maxBandwidth: buf.readUInt32BE(20),
  };
}

/**
 * Monotonic clock in ms. `performance.now()` is available on modern Node and in
 * browsers; fall back to `Date.now()` if it's somehow absent.
 *
 * @internal
 */
function performanceNow(): number {
  return typeof performance !== 'undefined' &&
    typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
