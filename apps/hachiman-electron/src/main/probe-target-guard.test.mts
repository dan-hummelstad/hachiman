/**
 * Security-critical unit tests for the `hachiman:probe-regions` IPC guard.
 *
 * Run via the package `test` script (node's built-in test runner + native TS
 * type-stripping — zero extra deps). The DNS resolver is injected so host
 * classification is exercised without touching the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateProbeTargets,
  isPrivateIp,
  MAX_PROBE_TARGETS,
  type HostResolver,
  type ResolvedAddress,
} from "./probe-target-guard.ts";

/** Build a mock resolver from a host→addresses map. Unknown hosts NXDOMAIN. */
function mockResolver(map: Record<string, string[]>): HostResolver {
  return async (host) => {
    const addrs = map[host];
    if (!addrs) throw new Error(`ENOTFOUND ${host}`);
    return addrs.map(
      (address): ResolvedAddress => ({
        address,
        family: address.includes(":") ? 6 : 4,
      }),
    );
  };
}

/** A resolver that should never be consulted (asserts if it is). */
const unusedResolver: HostResolver = async (host) => {
  throw new Error(`resolver should not have been called for ${host}`);
};

const t = (
  over: Partial<{ host: string; port: number; region: string }> = {},
): unknown => ({
  region: "r",
  host: "example.com",
  port: 443,
  ...over,
});

// --- isPrivateIp: direct literal classification -----------------------------

test("isPrivateIp: public IPv4 and IPv6 are public", () => {
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("1.1.1.1"), false);
  assert.equal(isPrivateIp("2606:4700:4700::1111"), false);
});

test("isPrivateIp: loopback / private / link-local / metadata / unspecified IPv4 rejected", () => {
  for (const ip of [
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.0.1",
    "169.254.169.254", // cloud metadata
    "0.0.0.0",
    "0.1.2.3",
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
});

test("isPrivateIp: 172.x outside 16-31 is public", () => {
  assert.equal(isPrivateIp("172.15.0.1"), false);
  assert.equal(isPrivateIp("172.32.0.1"), false);
});

test("isPrivateIp: loopback / ULA / link-local / unspecified IPv6 rejected", () => {
  for (const ip of [
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0", // with zone id
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
});

test("isPrivateIp: IPv4-mapped-IPv6 forms of private addrs rejected", () => {
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIp("::ffff:10.0.0.1"), true);
  assert.equal(isPrivateIp("::ffff:169.254.169.254"), true);
  assert.equal(isPrivateIp("::ffff:7f00:1"), true); // hex form of 127.0.0.1
  // mapped public address stays public
  assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);
});

test("isPrivateIp: non-IP strings are not flagged", () => {
  assert.equal(isPrivateIp("example.com"), false);
  assert.equal(isPrivateIp("not-an-ip"), false);
});

// --- validateProbeTargets: HOST rules ---------------------------------------

test("public host (resolves to public IP) is allowed", async () => {
  const out = await validateProbeTargets(
    [t({ host: "us-east-1.amazonaws.com", port: 443 })],
    mockResolver({ "us-east-1.amazonaws.com": ["52.1.2.3"] }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.host, "us-east-1.amazonaws.com");
});

test("IP-literal loopback/private/link-local/metadata/0.0.0.0/::1/ULA rejected (no DNS)", async () => {
  const hostiles = [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.5.5",
    "192.168.0.1",
    "169.254.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ];
  for (const host of hostiles) {
    const out = await validateProbeTargets(
      [t({ host })],
      unusedResolver,
    );
    assert.equal(out.length, 0, `${host} must be rejected`);
  }
});

test("DNS-rebinding: public NAME resolving to a private IP is rejected", async () => {
  const out = await validateProbeTargets(
    [t({ host: "sneaky.example.com", port: 443 })],
    mockResolver({ "sneaky.example.com": ["10.0.0.5"] }),
  );
  assert.equal(out.length, 0);
});

test("host resolving to a MIX of public+private is rejected (any private fails)", async () => {
  const out = await validateProbeTargets(
    [t({ host: "mixed.example.com", port: 443 })],
    mockResolver({ "mixed.example.com": ["52.1.2.3", "127.0.0.1"] }),
  );
  assert.equal(out.length, 0);
});

test("unresolvable host is rejected (fail closed)", async () => {
  const out = await validateProbeTargets(
    [t({ host: "nxdomain.invalid", port: 443 })],
    mockResolver({}),
  );
  assert.equal(out.length, 0);
});

test("host resolving to zero addresses is rejected", async () => {
  const resolver: HostResolver = async () => [];
  const out = await validateProbeTargets(
    [t({ host: "empty.example.com", port: 443 })],
    resolver,
  );
  assert.equal(out.length, 0);
});

// --- validateProbeTargets: PORT rules ---------------------------------------

test("port 443 allowed; omitted port rejected", async () => {
  const resolver = mockResolver({ "ok.example.com": ["52.1.2.3"] });
  const out = await validateProbeTargets([t({ host: "ok.example.com" })], resolver);
  assert.equal(out.length, 1, "port 443 should be allowed");
  const omitted = await validateProbeTargets(
    [{ region: "r", host: "ok.example.com" }],
    resolver,
  );
  assert.equal(omitted.length, 0, "omitted port should be rejected");
});

test("disallowed port rejected (port scan)", async () => {
  const resolver = mockResolver({ "ok.example.com": ["52.1.2.3"] });
  for (const port of [22, 80, 3306, 6379, 8080, 64738, 0, 65535]) {
    const out = await validateProbeTargets(
      [t({ host: "ok.example.com", port })],
      resolver,
    );
    assert.equal(out.length, 0, `port ${port} should be rejected`);
  }
});

// --- validateProbeTargets: COUNT cap ----------------------------------------

test(`count cap enforced at ${MAX_PROBE_TARGETS}`, async () => {
  const resolver = mockResolver({ "ok.example.com": ["52.1.2.3"] });
  const many = Array.from({ length: MAX_PROBE_TARGETS + 50 }, (_, i) => ({
    region: `r${i}`,
    host: "ok.example.com",
    port: 443,
  }));
  const out = await validateProbeTargets(many, resolver);
  assert.equal(out.length, MAX_PROBE_TARGETS);
});

test("count cap is applied BEFORE resolution (oversized payload can't force N lookups)", async () => {
  let calls = 0;
  const counting: HostResolver = async () => {
    calls += 1;
    return [{ address: "52.1.2.3", family: 4 }];
  };
  const many = Array.from({ length: MAX_PROBE_TARGETS + 100 }, () => ({
    region: "r",
    host: "ok.example.com",
    port: 443,
  }));
  await validateProbeTargets(many, counting);
  assert.ok(
    calls <= MAX_PROBE_TARGETS,
    `resolver called ${calls} times, expected <= ${MAX_PROBE_TARGETS}`,
  );
});

// --- validateProbeTargets: SHAPE / malformed payloads -----------------------

test("malformed payloads handled without throwing", async () => {
  assert.deepEqual(await validateProbeTargets(null, unusedResolver), []);
  assert.deepEqual(await validateProbeTargets(undefined, unusedResolver), []);
  assert.deepEqual(await validateProbeTargets("nope", unusedResolver), []);
  assert.deepEqual(await validateProbeTargets(42, unusedResolver), []);
  assert.deepEqual(
    await validateProbeTargets({ host: "x" }, unusedResolver),
    [],
  );
});

test("malformed entries within an array are dropped, good ones kept", async () => {
  const resolver = mockResolver({ "ok.example.com": ["52.1.2.3"] });
  const out = await validateProbeTargets(
    [
      { region: "good", host: "ok.example.com", port: 443 },
      null,
      42,
      { host: "ok.example.com", port: 443 }, // missing region
      { region: "c", port: 443 }, // missing host
      { region: "c", host: "ok.example.com", port: "443" }, // non-numeric port
      { region: "c", host: "", port: 443 }, // empty host
      { region: "c", host: "ok.example.com", port: 1.5 }, // non-integer port
    ],
    resolver,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.region, "good");
});

test("a valid target alongside a hostile one keeps only the valid one", async () => {
  const resolver = mockResolver({ "ok.example.com": ["52.1.2.3"] });
  const out = await validateProbeTargets(
    [
      { region: "evil", host: "127.0.0.1", port: 443 },
      { region: "ok", host: "ok.example.com", port: 443 },
    ],
    resolver,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.region, "ok");
});
