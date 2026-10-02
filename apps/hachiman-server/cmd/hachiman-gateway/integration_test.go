// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

//go:build integration

// End-to-end against real Postgres + Redis + Takusen (docker/docker-compose.yml
// + `pnpm -F @hachiman/takusen dev`). Needs:
//
//	DATABASE_URL, REDIS_URL, TAKUSEN_URL   same values Takusen runs with
//	HACHIMAN_TEST_TOKEN                   a Takusen access token for any user
//
// The test registers a pending device with a fresh MLS key (POST /devices
// with its device proof) and signs IDENTIFY and RESUME with it (§12.13).
//
//	go test -tags integration -run Integration ./cmd/hachiman-gateway/
package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"hachiman/server/pkg/voicetoken"
)

func envOrSkip(t *testing.T, k string) string {
	v := os.Getenv(k)
	if v == "" {
		t.Skipf("%s not set", k)
	}
	return v
}

// startGateway runs one gateway node on its own port, sharing Postgres/Redis.
func startGateway(t *testing.T, db *pgxpool.Pool, rdb *redis.Client, takusenURL string) *harness {
	signer, err := voicetoken.NewSigner(filepath.Join(t.TempDir(), "voice.key"))
	if err != nil {
		t.Fatal(err)
	}
	g := newGateway(rdb, takusenURL, nil, signer)
	g.load, g.nodeURL, g.device = pgLoader(db), pgNodeURL(db), pgDevice(db)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go g.runBus(ctx)
	<-g.busReady
	srv := httptest.NewServer(g.routes())
	t.Cleanup(srv.Close)
	return &harness{t: t, rdb: rdb, g: g, url: "ws" + strings.TrimPrefix(srv.URL, "http") + "/gateway"}
}

func TestIntegrationMessageFlowAndCrossNodeResume(t *testing.T) {
	dbURL, redisURL, takusenURL := envOrSkip(t, "DATABASE_URL"), envOrSkip(t, "REDIS_URL"), envOrSkip(t, "TAKUSEN_URL")
	token := envOrSkip(t, "HACHIMAN_TEST_TOKEN")
	ctx := context.Background()
	db, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ropts, err := redis.ParseURL(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	rdb := redis.NewClient(ropts)
	defer rdb.Close()

	rest := func(method, path string, body any, out any) {
		t.Helper()
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req, _ := http.NewRequest(method, takusenURL+"/api/v1"+path, rd)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode >= 300 {
			b, _ := io.ReadAll(res.Body)
			t.Fatalf("%s %s: %d %s", method, path, res.StatusCode, b)
		}
		if out != nil {
			if err := json.NewDecoder(res.Body).Decode(out); err != nil {
				t.Fatal(err)
			}
		}
	}

	nodeA := startGateway(t, db, rdb, takusenURL)
	nodeB := startGateway(t, db, rdb, takusenURL)

	c := nodeA.dial()
	// A pending device passes the IDENTIFY device check (§12.13).
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	deviceID := registerDevice(t, takusenURL, token, pub, key)
	ident := map[string]any{"token": token, "deviceId": deviceID, "capabilities": []string{"e2ee/1"}, "clientVersion": "1.0.0", "deviceProof": proofAt(key, deviceID, "", token, time.Now().UnixMilli())}

	// The checks run against the real devices table.
	bad := nodeA.dial()
	bad.send(opIdentify, map[string]any{"token": token, "deviceId": deviceID, "capabilities": []string{}, "clientVersion": "1.0.0"})
	bad.expectClose(closeUnsupported)
	bad = nodeA.dial()
	bad.send(opIdentify, map[string]any{"token": token, "deviceId": "00000000-0000-4000-8000-000000000000", "capabilities": []string{"e2ee/1"}, "clientVersion": "1.0.0"})
	bad.expectClose(closeDeviceRevoked)

	c.send(opIdentify, ident)
	ready := c.expect("READY")
	var r struct{ SessionID, DeviceID string }
	_ = json.Unmarshal(ready.D, &r)
	if r.DeviceID != deviceID {
		t.Fatalf("READY deviceId %q, want %q", r.DeviceID, deviceID)
	}

	// A fresh guild keeps the test independent of existing data.
	var guild GuildFull
	rest("POST", "/guilds", map[string]string{"name": fmt.Sprintf("it-%d", time.Now().UnixNano())}, &guild)
	defer rest("DELETE", "/guilds/"+guild.ID, nil, nil)
	c.expect("GUILD_CREATE")
	var channelID string
	for _, ch := range guild.Channels {
		if ch.Type == "text" {
			channelID = ch.ID
			break
		}
	}
	if channelID == "" {
		var ch Channel
		rest("POST", "/guilds/"+guild.ID+"/channels", map[string]string{"name": "general", "type": "text"}, &ch)
		channelID = ch.ID
		c.expect("CHANNEL_CREATE")
	}

	// Messages need an MLS envelope (§12.8), so a channel topic change is the
	// dispatched event: CHANNEL_UPDATE goes to every member, the author too.
	setTopic := func(topic string) {
		rest("PATCH", "/channels/"+channelID, map[string]string{"topic": topic}, nil)
	}
	setTopic("n-1")
	msg := c.expect("CHANNEL_UPDATE")
	if !strings.Contains(string(msg.D), `"topic":"n-1"`) {
		t.Fatalf("CHANNEL_UPDATE %s lacks the topic", msg.D)
	}

	// Drop the socket without a clean close, send while detached, RESUME on node B.
	c.ws.Close()
	setTopic("n-2")
	time.Sleep(200 * time.Millisecond) // let node A buffer it
	c2 := nodeB.dial()
	c2.send(opResume, map[string]any{"token": token, "sessionId": r.SessionID, "seq": msg.S, "deviceId": deviceID, "deviceProof": proofAt(key, deviceID, r.SessionID, token, time.Now().UnixMilli())})
	if f := c2.expect("CHANNEL_UPDATE"); !strings.Contains(string(f.D), "n-2") {
		t.Fatalf("replayed %s, want the n-2 message", f.D)
	}
	c2.expect("RESUMED")
	setTopic("n-3")
	if f := c2.expect("CHANNEL_UPDATE"); !strings.Contains(string(f.D), "n-3") {
		t.Fatalf("live on node B: %s", f.D)
	}
}

// registerDevice is POST /devices with the device proof of the presented key
// (§12.12: kind "ds", device id "").
func registerDevice(t *testing.T, takusenURL, token string, pub ed25519.PublicKey, key ed25519.PrivateKey) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"name": "gateway-it", "platform": "browser", "clientVersion": "1.0.0", "mlsSignatureKey": base64.RawURLEncoding.EncodeToString(pub)})
	req, _ := http.NewRequest(http.MethodPost, takusenURL+"/api/v1/devices", bytes.NewReader(body))
	var n [16]byte
	_, _ = rand.Read(n[:])
	nonce := base64.RawURLEncoding.EncodeToString(n[:])
	ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
	h := sha256.Sum256(body)
	msg := strings.Join([]string{deviceProofVersion, "ds", "", "POST", req.URL.Path, ts, nonce, base64.RawURLEncoding.EncodeToString(h[:])}, "\n")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Hachiman-Device-Ts", ts)
	req.Header.Set("X-Hachiman-Device-Nonce", nonce)
	req.Header.Set("X-Hachiman-Device-Sig", base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(msg))))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var dev struct{ ID string }
	if res.StatusCode != http.StatusCreated || json.NewDecoder(res.Body).Decode(&dev) != nil {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("POST /devices: %d %s", res.StatusCode, b)
	}
	return dev.ID
}
