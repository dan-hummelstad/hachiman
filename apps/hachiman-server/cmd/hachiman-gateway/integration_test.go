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
//	go test -tags integration -run Integration ./cmd/hachiman-gateway/
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
	g.load, g.nodeURL = pgLoader(db), pgNodeURL(db)
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
	c.send(opIdentify, map[string]string{"token": token})
	ready := c.expect("READY")
	var r struct{ SessionID string }
	_ = json.Unmarshal(ready.D, &r)

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

	rest("POST", "/channels/"+channelID+"/messages", map[string]string{"content": "hello", "nonce": "n-1"}, nil)
	msg := c.expect("MESSAGE_CREATE")
	if !strings.Contains(string(msg.D), `"nonce":"n-1"`) {
		t.Fatalf("MESSAGE_CREATE %s lacks the nonce", msg.D)
	}

	// Drop the socket without a clean close, send while detached, RESUME on node B.
	c.ws.Close()
	rest("POST", "/channels/"+channelID+"/messages", map[string]string{"content": "while-away", "nonce": "n-2"}, nil)
	time.Sleep(200 * time.Millisecond) // let node A buffer it
	c2 := nodeB.dial()
	c2.send(opResume, map[string]any{"token": token, "sessionId": r.SessionID, "seq": msg.S})
	if f := c2.expect("MESSAGE_CREATE"); !strings.Contains(string(f.D), "n-2") {
		t.Fatalf("replayed %s, want the n-2 message", f.D)
	}
	c2.expect("RESUMED")
	rest("POST", "/channels/"+channelID+"/messages", map[string]string{"content": "after-resume", "nonce": "n-3"}, nil)
	if f := c2.expect("MESSAGE_CREATE"); !strings.Contains(string(f.D), "n-3") {
		t.Fatalf("live on node B: %s", f.D)
	}
}
