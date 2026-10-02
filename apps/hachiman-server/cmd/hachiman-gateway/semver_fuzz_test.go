// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"regexp"
	"testing"
)

// The official SemVer 2.0.0 regular expression (semver.org, FAQ).
var semverRE = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$`)

// FuzzSemver: the IDENTIFY clientVersion parser (§12.13) accepts exactly the
// SemVer 2.0.0 grammar (except core numbers above uint64), never panics, and
// its order is reflexive and antisymmetric.
//
//	go test ./cmd/hachiman-gateway -run '^$' -fuzz '^FuzzSemver$' -fuzztime 30s
func FuzzSemver(f *testing.F) {
	for _, s := range []string{"1.2.3", "0.0.0-alpha.1+build.5", "1.0.0-0A.is.legal", "01.2.3", "1.2", "v1.2.3", "1.2.3-", "1.2.3+", "1.2.3-01", "18446744073709551616.0.0"} {
		f.Add(s, "1.0.0-rc.1")
	}
	f.Fuzz(func(t *testing.T, a, b string) {
		va, okA := parseSemver(a)
		if m := semverRE.FindStringSubmatch(a); okA != (m != nil && fitsUint64(m[1:4])) {
			t.Fatalf("%q: parsed %v, SemVer 2.0.0 %v", a, okA, m != nil)
		}
		vb, okB := parseSemver(b)
		if !okA || !okB {
			return
		}
		if va.compare(va) != 0 {
			t.Fatalf("%q != itself", a)
		}
		if va.compare(vb) != -vb.compare(va) {
			t.Fatalf("compare(%q, %q) = %d, reverse %d", a, b, va.compare(vb), vb.compare(va))
		}
	})
}

func fitsUint64(core []string) bool {
	for _, p := range core {
		if _, ok := numericIdent(p); !ok {
			return false
		}
	}
	return true
}
