// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.


package main

import "testing"

func TestChannelSetGroup(t *testing.T) {
	shared := "shared"
	text := Channel{Type: "text"}
	text.setGroup([]byte{1, 1, 0xff}, &shared)
	if text.MlsGroupID == nil || *text.MlsGroupID != "AQH_" || *text.HistoryVisibility != "shared" {
		t.Fatalf("text: %v %v", text.MlsGroupID, text.HistoryVisibility)
	}
	pending := Channel{Type: "pages"}
	pending.setGroup(nil, nil)
	if pending.MlsGroupID != nil || *pending.HistoryVisibility != "joined" {
		t.Fatalf("no group yet: %v %v", pending.MlsGroupID, pending.HistoryVisibility)
	}
	for _, typ := range []string{"voice", "category", "thread"} {
		c := Channel{Type: typ}
		c.setGroup([]byte{1}, &shared)
		if c.MlsGroupID != nil || c.HistoryVisibility != nil {
			t.Fatalf("%s: want nulls", typ)
		}
	}
}
