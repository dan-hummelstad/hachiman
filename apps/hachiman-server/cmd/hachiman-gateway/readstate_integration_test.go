// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

//go:build integration

// The READY read-state query (readStatesSQL) on a real Postgres with the
// Takusen schema. Needs only DATABASE_URL. Each run makes its own rows with
// random ids and does not delete them.
//
//	go test -tags integration -run IntegrationReadStates ./cmd/hachiman-gateway/
package main

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIntegrationReadStates(t *testing.T) {
	ctx := context.Background()
	db, err := pgxpool.New(ctx, envOrSkip(t, "DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	me, other := uuid.NewString(), uuid.NewString()
	guild, text, voice, dm := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	group := []byte(uuid.NewString())
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	exec(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'me'), ($3, $4, 'other')`, me, me+"@rs.test", other, other+"@rs.test")
	exec(`INSERT INTO guilds (id, owner_id, name) VALUES ($1, $2, 'rs')`, guild, other)
	exec(`INSERT INTO guild_members (guild_id, user_id) VALUES ($1, $2)`, guild, me)
	exec(`INSERT INTO channels (id, guild_id, type, name) VALUES ($1, $3, 'text', 't'), ($2, $3, 'voice', 'v')`, text, voice, guild)
	exec(`INSERT INTO channels (id, type) VALUES ($1, 'dm')`, dm)
	exec(`INSERT INTO dm_participants (channel_id, user_id) VALUES ($1, $2), ($1, $3)`, dm, me, other)
	exec(`INSERT INTO mls_groups (group_id, kind, scope_id, generation, cipher_suite, status, history_visibility) VALUES ($1, 'dm', $2, 0, 1, 'active', 'joined')`, group, dm)
	// text: m1 (other), m2 (other, read), m3 (me), m4 (other), m5 (other) → 2 unread. dm: d1 (other), no read state.
	ids := map[string]string{}
	for i, m := range []struct{ name, ch, author string }{
		{"m1", text, other}, {"m2", text, other}, {"m3", text, me}, {"m4", text, other}, {"m5", text, other}, {"d1", dm, other},
	} {
		ids[m.name] = uuid.NewString()
		exec(`INSERT INTO messages (id, channel_id, author_id, group_id, epoch, client_msg_id, envelope, franking_tag, size, created_at)
			VALUES ($1, $2, $3, $4, 0, $5, '\x00', '\x00', 1, now() + make_interval(secs => $6))`,
			ids[m.name], m.ch, m.author, group, []byte(m.name), i)
	}
	exec(`INSERT INTO read_states (user_id, channel_id, last_read_message_id, last_read_created_at)
		SELECT $1, channel_id, id, created_at FROM messages WHERE id = $2`, me, ids["m2"])

	data, err := pgLoader(db)(ctx, me, "")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]ReadState{}
	for _, r := range data.ReadStates {
		got[r.ChannelID] = r
	}
	if _, ok := got[voice]; ok || len(got) != 2 {
		t.Fatalf("read states %+v, want text and dm only", data.ReadStates)
	}
	if r := got[text]; r.LastReadMessageID == nil || *r.LastReadMessageID != ids["m2"] || r.UnreadCount != 2 ||
		r.LastMessageID == nil || *r.LastMessageID != ids["m5"] || r.guildID == nil || *r.guildID != guild {
		t.Errorf("text read state %+v", r)
	}
	if r := got[dm]; r.LastReadMessageID != nil || r.UnreadCount != 0 || r.LastMessageID == nil || *r.LastMessageID != ids["d1"] || r.LastMessageAt == nil || r.guildID != nil {
		t.Errorf("dm read state %+v", r)
	}
}
