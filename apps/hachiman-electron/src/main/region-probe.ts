import net from "net";

/** Contract §11 shapes (`IPlatformService.probeRegions`). */
export interface RegionProbeTarget {
  region: string;
  host: string;
  port: number;
}
export interface RegionProbeResult {
  region: string;
  rttMs: number | null;
}

const TIMEOUT_MS = 2000;
const SAMPLES = 3;
const CONCURRENCY = 8;

/**
 * One timed TCP connect (SYN → SYN/ACK = one network round-trip). The socket is
 * destroyed as soon as the handshake completes; no data is ever sent.
 */
function tcpConnectRtt(host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const socket = new net.Socket();
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      fn();
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.once("connect", () =>
      done(() => resolve(performance.now() - start)),
    );
    socket.once("timeout", () => done(() => reject(new Error("timeout"))));
    socket.once("error", (err) => done(() => reject(err)));
    socket.connect(port, host);
  });
}

/**
 * Min of several samples: a dropped SYN is retransmitted on a coarse timer, so
 * a single sample can over-report on a lossy path. Never throws; total failure
 * is `rttMs: null` ("unrankable" to the placement scorer).
 */
async function probeOne(t: RegionProbeTarget): Promise<RegionProbeResult> {
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    try {
      samples.push(await tcpConnectRtt(t.host, t.port));
    } catch {
      /* counted as a missing sample */
    }
  }
  return {
    region: t.region,
    rttMs: samples.length ? Math.min(...samples) : null,
  };
}

/** Probe in ordered chunks so at most CONCURRENCY sockets are open at once. */
export async function probeRegions(
  targets: RegionProbeTarget[],
): Promise<RegionProbeResult[]> {
  const out: RegionProbeResult[] = [];
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    out.push(
      ...(await Promise.all(targets.slice(i, i + CONCURRENCY).map(probeOne))),
    );
  }
  return out;
}
