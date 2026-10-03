// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// §12.13: the IDENTIFY checks run in the order token, client, device.
func TestIdentifyRejections(t *testing.T) {
	h := newHarness(t)
	with := func(edit func(p map[string]any)) map[string]any {
		p := identifyAs(devA)
		edit(p)
		return p
	}
	cases := []struct {
		name string
		d    map[string]any
		code int
	}{
		{"bad token before client check", with(func(p map[string]any) { p["token"] = "bad"; delete(p, "capabilities") }), closeAuthFailed},
		{"bad token before device check", with(func(p map[string]any) { p["token"] = "bad"; p["deviceId"] = devRevoked }), closeAuthFailed},
		{"no capabilities", with(func(p map[string]any) { delete(p, "capabilities") }), closeUnsupported},
		{"other capabilities", with(func(p map[string]any) { p["capabilities"] = []string{"e2ee/2"} }), closeUnsupported},
		{"no version", with(func(p map[string]any) { delete(p, "clientVersion") }), closeUnsupported},
		{"version not semver", with(func(p map[string]any) { p["clientVersion"] = "v1.0" }), closeUnsupported},
		{"version too old", with(func(p map[string]any) { p["clientVersion"] = "0.0.9" }), closeUnsupported},
		{"prerelease below minimum", with(func(p map[string]any) { p["clientVersion"] = "0.1.0-rc.1" }), closeUnsupported},
		{"client check before device check", with(func(p map[string]any) { delete(p, "capabilities"); p["deviceId"] = devRevoked }), closeUnsupported},
		{"no deviceId", with(func(p map[string]any) { delete(p, "deviceId") }), closeDeviceRevoked},
		{"deviceId not a uuid", with(func(p map[string]any) { p["deviceId"] = "phone" }), closeDeviceRevoked},
		{"unknown device", with(func(p map[string]any) { p["deviceId"] = "0f000000-0000-4000-8000-00000000000f" }), closeDeviceRevoked},
		{"device of another user", with(func(p map[string]any) { p["deviceId"] = devOther }), closeDeviceRevoked},
		{"revoked device", with(func(p map[string]any) { p["deviceId"] = devRevoked }), closeDeviceRevoked},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := h.dial()
			c.t = t
			c.send(opIdentify, tc.d)
			c.expectClose(tc.code)
		})
	}
	if keys := h.mr.Keys(); len(keys) != 0 {
		t.Errorf("rejected IDENTIFYs left Redis keys: %v", keys)
	}
}

func TestIdentifyAcceptsPendingDeviceAndMinimumVersion(t *testing.T) {
	h := newHarness(t)
	h.g.minClientVersion, _ = parseSemver("1.0.0")
	sid := h.dial().identifyDevice(devPending)
	if got := h.mr.HGet(kSession(sid), "deviceId"); got != devPending {
		t.Errorf("session deviceId %q", got)
	}
	c := h.dial()
	p := identifyAs(devA)
	p["clientVersion"] = "1.0.0+build.7" // build metadata has no precedence
	c.send(opIdentify, p)
	c.expect("READY")
	c = h.dial()
	p["clientVersion"] = "1.0.0-beta"
	c.send(opIdentify, p)
	c.expectClose(closeUnsupported)
}

// A revocation that commits between the IDENTIFY check and addSession is
// caught by recheckDevice.
func TestIdentifyRecheckCatchesLateRevocation(t *testing.T) {
	h := newHarness(t)
	calls := 0
	inner := h.g.device
	h.g.device = func(ctx context.Context, id string) (deviceRow, error) {
		calls++ // identify and the session goroutine never overlap
		d, err := inner(ctx, id)
		if calls > 1 {
			d.Status = "revoked"
		}
		return d, err
	}
	c := h.dial()
	c.send(opIdentify, identifyAs(devA))
	c.expectClose(closeDeviceRevoked)
	waitFor(t, "session keys removed", func() bool {
		// The device_nonce key of the accepted proof stays until its TTL.
		var left []string
		for _, k := range h.mr.Keys() {
			if !strings.HasPrefix(k, "device_nonce:") {
				left = append(left, k)
			}
		}
		return len(left) == 0 || (len(left) == 1 && h.mr.Exists(kUserSessions(me)))
	})
	if h.mr.Exists(kDeviceOnline(devA)) {
		t.Error("device_online survived the failed recheck")
	}
}

// §12.13: IDENTIFY and RESUME carry a deviceProof by the device MLS key. A
// bearer token alone cannot claim a device.
func TestDeviceProof(t *testing.T) {
	h := newHarness(t)
	h.setDevice(devB, deviceRow{UserID: me, Status: "pending"}) // no key registered
	now := time.Now().UnixMilli()
	thief := testDeviceKey("thief")
	cases := []struct {
		name  string
		proof any
		dev   string
	}{
		{"no proof", nil, devA},
		{"another key", proofAt(thief, devA, "", "good", now), devA},
		{"proof of another device", proofFor(devPending, "", "good"), devA},
		{"proof for a resume", proofFor(devA, "s-1", "good"), devA},
		{"proof of another token", proofFor(devA, "", "other"), devA},
		{"stale ts", proofAt(testDeviceKey(devA), devA, "", "good", now-6*60_000), devA},
		{"future ts", proofAt(testDeviceKey(devA), devA, "", "good", now+6*60_000), devA},
		{"device without a key", proofFor(devB, "", "good"), devB},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := h.dial()
			c.t = t
			p := identifyAs(tc.dev)
			if tc.proof == nil {
				delete(p, "deviceProof")
			} else {
				p["deviceProof"] = tc.proof
			}
			c.send(opIdentify, p)
			c.expectClose(closeAuthFailed)
		})
	}
	if keys := h.mr.Keys(); len(keys) != 0 {
		t.Errorf("rejected proofs left Redis keys: %v", keys)
	}

	// A replayed proof fails, on IDENTIFY and on RESUME.
	p := identifyAs(devA)
	c := h.dial()
	c.send(opIdentify, p)
	f := c.expect("READY")
	var r struct{ SessionID string }
	_ = json.Unmarshal(f.D, &r)
	c2 := h.dial()
	c2.send(opIdentify, p)
	c2.expectClose(closeAuthFailed)
	c.ws.Close()

	rp := resumeAs(map[string]any{"token": "good", "sessionId": r.SessionID, "seq": 1, "deviceId": devA})
	wrong := resumeAs(map[string]any{"token": "good", "sessionId": "other", "seq": 1, "deviceId": devA})
	c3 := h.dial()
	c3.send(opResume, map[string]any{"token": "good", "sessionId": r.SessionID, "seq": 1, "deviceId": devA, "deviceProof": wrong["deviceProof"]})
	c3.expectClose(closeAuthFailed)
	c4 := h.dial()
	c4.send(opResume, rp)
	c4.expect("RESUMED")
	c4.ws.Close()
	c5 := h.dial()
	c5.send(opResume, rp)
	c5.expectClose(closeAuthFailed)
}

func TestResumeDeviceChecks(t *testing.T) {
	h := newHarness(t)
	c := h.dial()
	sid := c.identify()
	c.ws.Close()

	// Another (valid) device of the same user: INVALID_SESSION(false).
	c2 := h.dial()
	c2.send(opResume, resumeAs(map[string]any{"token": "good", "sessionId": sid, "seq": 1, "deviceId": devB}))
	if f := c2.next(); f.Op != opInvalidSession || string(f.D) != "false" {
		t.Fatalf("got op=%d d=%s, want INVALID_SESSION(false)", f.Op, f.D)
	}
	// No deviceId at all is a device failure, not a mismatch.
	c3 := h.dial()
	c3.send(opResume, resumeAs(map[string]any{"token": "good", "sessionId": sid, "seq": 1}))
	c3.expectClose(closeDeviceRevoked)

	// The mismatch did not take the session over: the right device resumes.
	c4 := h.dial()
	c4.send(opResume, resumeAs(map[string]any{"token": "good", "sessionId": sid, "seq": 1, "deviceId": devA}))
	c4.expect("RESUMED")
	c4.ws.Close()

	// The device is revoked while detached and no event arrived: RESUME gives 4013.
	h.setDevice(devA, deviceRow{UserID: me, Status: "revoked"})
	c5 := h.dial()
	c5.send(opResume, resumeAs(map[string]any{"token": "good", "sessionId": sid, "seq": 2, "deviceId": devA}))
	c5.expectClose(closeDeviceRevoked)
}

func TestDeviceOnlineLifecycle(t *testing.T) {
	h := newHarness(t)
	h.g.offlineGrace = time.Hour
	c1 := h.dial()
	s1 := c1.identify()
	if got, _ := h.mr.Get(kDeviceOnline(devA)); got != s1 {
		t.Fatalf("device_online = %q, want %q", got, s1)
	}
	if ttl := h.mr.TTL(kDeviceOnline(devA)); ttl != sessionTTL {
		t.Errorf("device_online TTL %v, want %v", ttl, sessionTTL)
	}

	// Heartbeat refreshes the TTL.
	h.mr.SetTTL(kDeviceOnline(devA), 5*time.Second)
	c1.send(opHeartbeat, 1)
	waitFor(t, "TTL refresh", func() bool { return h.mr.TTL(kDeviceOnline(devA)) == sessionTTL })

	// A second session of the same device takes the key over.
	c2 := h.dial()
	s2 := c2.identify()
	if got, _ := h.mr.Get(kDeviceOnline(devA)); got != s2 {
		t.Fatalf("device_online = %q, want the newer session %q", got, s2)
	}
	// The older session ends: the key holds s2, so it stays.
	bye(c1)
	waitFor(t, "s1 end", func() bool { return !h.mr.Exists(kSession(s1)) })
	if got, _ := h.mr.Get(kDeviceOnline(devA)); got != s2 {
		t.Errorf("ending s1 changed device_online to %q", got)
	}
	// s2 ends: its own key goes.
	bye(c2)
	waitFor(t, "device_online delete", func() bool { return !h.mr.Exists(kDeviceOnline(devA)) })

	// A heartbeat re-claims the key after another session of the device deleted it.
	c3, c4 := h.dial(), h.dial()
	s3 := c3.identify()
	c4.identify()
	bye(c4)
	waitFor(t, "device_online delete", func() bool { return !h.mr.Exists(kDeviceOnline(devA)) })
	c3.send(opHeartbeat, 1)
	waitFor(t, "re-claim", func() bool { got, _ := h.mr.Get(kDeviceOnline(devA)); return got == s3 })
}

func TestDeviceScopeDelivery(t *testing.T) {
	h := newHarness(t)
	a1, a2, b := h.dial(), h.dial(), h.dial()
	a1.identify()
	a2.identify()
	b.identifyDevice(devB)

	low := map[string]any{"deviceId": devA, "cipherSuite": 1, "remaining": 3}
	h.pub("device:"+devA, "KEY_PACKAGES_LOW", low, "")
	h.pub("user:"+me, "MARKER", map[string]string{}, "")
	for _, c := range []*client{a1, a2} {
		if f := c.expect("KEY_PACKAGES_LOW"); !strings.Contains(string(f.D), `"remaining":3`) {
			t.Errorf("KEY_PACKAGES_LOW %s", f.D)
		}
		c.expect("MARKER")
	}
	b.expect("MARKER") // devB never saw the devA event
}

// A device event reaches a detached session through the RESUME buffer.
func TestDeviceEventBufferedForResume(t *testing.T) {
	h := newHarness(t)
	c := h.dial()
	sid := c.identify()
	c.ws.Close()
	h.pub("device:"+devA, "DEVICE_INBOX", map[string]any{"id": "i1", "seq": 4, "kind": "welcome"}, "")
	waitFor(t, "buffered DEVICE_INBOX", func() bool {
		return strings.Contains(strings.Join(lrange(h, kEvents(sid)), ""), "DEVICE_INBOX")
	})
	c2 := h.dial()
	c2.send(opResume, resumeAs(map[string]any{"token": "good", "sessionId": sid, "seq": 1, "deviceId": devA}))
	if f := c2.expect("DEVICE_INBOX"); !strings.Contains(string(f.D), `"seq":4`) {
		t.Fatalf("replayed %s", f.D)
	}
	c2.expect("RESUMED")
}

func TestDeviceRevokedClosesSessions(t *testing.T) {
	h := newHarness(t)
	h.g.offlineGrace = time.Hour
	live, detached, other := h.dial(), h.dial(), h.dial()
	sLive := live.identify()
	sDetached := detached.identify()
	other.identifyDevice(devB)
	detached.ws.Close()
	time.Sleep(50 * time.Millisecond) // let the detach land

	h.pub("device:"+devA, "DEVICE_REVOKED", map[string]string{"deviceId": devA}, "")
	live.expectClose(closeDeviceRevoked)
	waitFor(t, "revoked sessions end", func() bool {
		return !h.mr.Exists(kSession(sLive)) && !h.mr.Exists(kSession(sDetached)) && !h.mr.Exists(kDeviceOnline(devA))
	})
	// The detached session is gone, so it cannot RESUME (the device check
	// passes here because the fake row is still active).
	c := h.dial()
	c.send(opResume, resumeAs(map[string]any{"token": "good", "sessionId": sDetached, "seq": 1, "deviceId": devA}))
	if f := c.next(); f.Op != opInvalidSession {
		t.Fatalf("got op=%d, want INVALID_SESSION", f.Op)
	}
	// Not forwarded, and other devices are unaffected.
	h.pub("user:"+me, "MARKER", map[string]string{}, "")
	other.expect("MARKER")
}

func TestMlsEventsForwardedWithChannelFilter(t *testing.T) {
	h := newHarness(t)
	c := h.dial()
	c.identify()
	hs := func(group string) map[string]any {
		return map[string]any{"groupId": group, "seq": 1, "epoch": 0, "kind": "proposal", "senderDevice": nil, "message": "AAEC", "next": nil}
	}
	h.pub("guild:"+gid, "MLS_HANDSHAKE", hs("hidden-group"), "secret")
	h.pub("guild:"+gid, "MLS_GROUP_UPDATE", map[string]string{"groupId": "hidden-group"}, "secret")
	h.pub("guild:"+gid, "MLS_HANDSHAKE", hs("text-group"), "text")
	if f := c.expect("MLS_HANDSHAKE"); !strings.Contains(string(f.D), "text-group") || !strings.Contains(string(f.D), `"kind":"proposal"`) {
		t.Fatalf("MLS_HANDSHAKE %s, want the visible channel only", f.D)
	}
	h.pub("guild:"+gid, "MLS_GROUP_UPDATE", map[string]string{"groupId": "public-group"}, "") // public_set: no channelId
	if f := c.expect("MLS_GROUP_UPDATE"); !strings.Contains(string(f.D), "public-group") {
		t.Fatalf("MLS_GROUP_UPDATE %s", f.D)
	}

	// User-scoped events pass through unparsed, byte for byte.
	for _, ev := range []struct{ t, d string }{
		{"KT_TREE_HEAD", `{"size":7,"root":"q83v","sig":"AAAA"}`},
		{"USER_KEYS_UPDATE", `{"userId":"u1","kind":"device_added","deviceId":"` + devB + `"}`},
		{"DEVICE_LINK", `{"sessionId":"ls","seq":1,"fromDevice":"` + devB + `"}`},
	} {
		h.pub("user:"+me, ev.t, json.RawMessage(ev.d), "")
		if f := c.expect(ev.t); string(f.D) != ev.d {
			t.Errorf("%s payload %s, want %s", ev.t, f.D, ev.d)
		}
	}
}

func TestSemver(t *testing.T) {
	bad := []string{"", "1", "1.0", "v1.0.0", "01.0.0", "1.0.0-", "1.0.0-01", "1.0.0+", "1.0.0-a..b", "1.0.0-é", "1.-1.0"}
	for _, s := range bad {
		if _, ok := parseSemver(s); ok {
			t.Errorf("parseSemver(%q) accepted", s)
		}
	}
	// SemVer 2.0.0 §11 example order.
	order := []string{"1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0", "10.0.0"}
	for i := 1; i < len(order); i++ {
		a, okA := parseSemver(order[i-1])
		b, okB := parseSemver(order[i])
		if !okA || !okB || !a.less(b) || b.less(a) {
			t.Errorf("want %s < %s", order[i-1], order[i])
		}
	}
	a, _ := parseSemver("1.0.0+x")
	b, _ := parseSemver("1.0.0")
	if a.compare(b) != 0 {
		t.Error("build metadata changed precedence")
	}
}

// bye closes cleanly (1000), which ends the session at once.
func bye(c *client) {
	_ = c.ws.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "bye"))
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
