// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Custom status (contract §1 Presence, §5 custom_status:{userId}, §6 op 3).
const maxCustomStatusRunes = 64

type CustomStatus struct {
	Text      string  `json:"text"`
	ExpiresAt *string `json:"expiresAt"`
}

func kCustomStatus(uid string) string { return "custom_status:" + uid }

var errBadCustomStatus = errors.New("bad custom status")

// sanitizeCustomStatus validates the op 3 `customStatus` field. It returns nil
// to clear: JSON null, a text that is empty after the control characters are
// removed and the ends are trimmed, or an expiresAt that is not in the future.
// A text over 64 characters or an expiresAt that is not RFC 3339 is an error.
func sanitizeCustomStatus(raw json.RawMessage, now time.Time) (*CustomStatus, error) {
	var in *struct {
		Text      string  `json:"text"`
		ExpiresAt *string `json:"expiresAt"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, errBadCustomStatus
	}
	if in == nil {
		return nil, nil
	}
	text := strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || isBidiControl(r) {
			return -1
		}
		return r
	}, in.Text))
	if utf8.RuneCountInString(text) > maxCustomStatusRunes {
		return nil, errBadCustomStatus
	}
	out := &CustomStatus{Text: text}
	if in.ExpiresAt != nil {
		t, err := time.Parse(time.RFC3339Nano, *in.ExpiresAt)
		if err != nil {
			return nil, errBadCustomStatus
		}
		if !t.After(now) {
			return nil, nil
		}
		s := iso(t)
		out.ExpiresAt = &s
	}
	if text == "" {
		return nil, nil
	}
	return out, nil
}

// isBidiControl reports the explicit bidi embedding, override and isolate
// characters, which can reorder the text around the status in a row.
func isBidiControl(r rune) bool {
	return (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069)
}

// parseCustomStatus decodes a stored value and drops an expired one.
func parseCustomStatus(v string, now time.Time) *CustomStatus {
	var cs CustomStatus
	if v == "" || json.Unmarshal([]byte(v), &cs) != nil || cs.Text == "" {
		return nil
	}
	if cs.ExpiresAt != nil {
		t, err := time.Parse(time.RFC3339Nano, *cs.ExpiresAt)
		if err != nil || !t.After(now) {
			return nil
		}
	}
	return &cs
}

// setCustomStatus stores cs (nil deletes). The key has no TTL without an
// expiry, so the status survives sign-out; with one, Redis drops it then.
func (g *Gateway) setCustomStatus(ctx context.Context, uid string, cs *CustomStatus) error {
	k := kCustomStatus(uid)
	if cs == nil {
		return g.rdb.Del(ctx, k).Err()
	}
	var ttl time.Duration // 0: no expiry
	if cs.ExpiresAt != nil {
		t, _ := time.Parse(time.RFC3339Nano, *cs.ExpiresAt)
		ttl = max(t.Sub(time.Now()), time.Millisecond)
	}
	return g.rdb.Set(ctx, k, string(mustJSON(cs)), ttl).Err()
}

func (g *Gateway) customStatus(ctx context.Context, uid string) *CustomStatus {
	v, _ := g.rdb.Get(ctx, kCustomStatus(uid)).Result()
	return parseCustomStatus(v, time.Now())
}
