import {
  buildServerBrowserPing,
  parseServerBrowserPong,
} from './region-rtt-probe';

/**
 * These cover the PURE wire-format helpers for the Mumble connectionless
 * server-browser ping/pong. They assert the exact byte layout the Go server
 * speaks (`cmd/grumble/server.go` udpListenLoop): 12-byte request
 * [uint32 ident, uint64 nonce]; 24-byte reply [uint32 version, uint64 nonce,
 * uint32 userCount, uint32 maxUsers, uint32 maxBandwidth], all big-endian.
 *
 * The socket-based TCP prober (`probeRegionRtt`) is not unit-tested here — it
 * needs a live listener; it is exercised by the Oracle endpoint integration in
 * practice and documented in PLACEMENT-DESIGN.md.
 */
describe('buildServerBrowserPing', () => {
  it('produces a 12-byte datagram: zero ident + big-endian nonce', () => {
    const ping = buildServerBrowserPing(0x0102030405060708n);
    expect(ping.length).toBe(12);
    expect(ping.readUInt32BE(0)).toBe(0);
    expect(ping.readBigUInt64BE(4)).toBe(0x0102030405060708n);
  });

  it('truncates a nonce wider than 64 bits into the low 64 bits', () => {
    const ping = buildServerBrowserPing((1n << 64n) | 0xdeadbeefn);
    expect(ping.readBigUInt64BE(4)).toBe(0xdeadbeefn);
  });
});

describe('parseServerBrowserPong', () => {
  it('decodes the 24-byte reply the Go server emits', () => {
    // Mirror the server's writes: version (1<<16)|(2<<8)|2, nonce echo, counts.
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE((1 << 16) | (2 << 8) | 2, 0);
    buf.writeBigUInt64BE(0xcafef00dn, 4);
    buf.writeUInt32BE(7, 12); // userCount
    buf.writeUInt32BE(100, 16); // maxUsers
    buf.writeUInt32BE(128000, 20); // maxBandwidth

    const pong = parseServerBrowserPong(buf);
    expect(pong.version).toBe((1 << 16) | (2 << 8) | 2);
    expect(pong.nonce).toBe(0xcafef00dn);
    expect(pong.userCount).toBe(7);
    expect(pong.maxUsers).toBe(100);
    expect(pong.maxBandwidth).toBe(128000);
  });

  it('round-trips the nonce from build → parse so RTT correlation works', () => {
    const nonce = 0x1122334455667788n;
    const ping = buildServerBrowserPing(nonce);
    // Server echoes the ping's nonce (bytes 4..12) into the reply's nonce slot.
    const reply = Buffer.alloc(24);
    ping.copy(reply, 4, 4, 12);
    expect(parseServerBrowserPong(reply).nonce).toBe(nonce);
  });

  it('throws on a short buffer', () => {
    expect(() => parseServerBrowserPong(Buffer.alloc(23))).toThrow();
  });
});
