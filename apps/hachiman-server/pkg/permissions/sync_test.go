// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package permissions

import (
	"os"
	"regexp"
	"strconv"
	"testing"
)

// The TS file is the other half of the contract; drift here means the client
// greys out buttons the server would allow (or vice versa).
func TestSyncWithTypeScript(t *testing.T) {
	src, err := os.ReadFile("../../../../pkgs/hachiman-client/src/permissions.ts")
	if err != nil {
		t.Fatalf("read TS permissions: %v", err)
	}
	re := regexp.MustCompile(`(?m)^\s*([A-Z_]+): 1 << (\d+),`)
	ts := map[string]int64{}
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		n, _ := strconv.Atoi(m[2])
		ts[m[1]] = 1 << n
	}
	if len(ts) == 0 {
		t.Fatal("no constants parsed from permissions.ts; did its format change?")
	}
	for name, v := range ts {
		if got, ok := ByName[name]; !ok {
			t.Errorf("%s defined in TS but not in Go", name)
		} else if got != v {
			t.Errorf("%s: Go %d, TS %d", name, got, v)
		}
	}
	for name := range ByName {
		if _, ok := ts[name]; !ok {
			t.Errorf("%s defined in Go but not in TS", name)
		}
	}
}
