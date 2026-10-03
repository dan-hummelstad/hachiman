// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"strconv"
	"strings"
)

// semver is a SemVer 2.0.0 version for the IDENTIFY clientVersion check
// (§12.13). Build metadata is parsed and then ignored, as the spec says.
type semver struct {
	major, minor, patch uint64
	pre                 []string // nil = release
}

// parseSemver accepts MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD] with no "v"
// prefix and no leading zeros in numeric parts.
func parseSemver(s string) (semver, bool) {
	var v semver
	s, build, hasBuild := strings.Cut(s, "+")
	if hasBuild && !validIdents(build, false) {
		return v, false
	}
	core, pre, hasPre := strings.Cut(s, "-")
	if hasPre {
		if !validIdents(pre, true) {
			return v, false
		}
		v.pre = strings.Split(pre, ".")
	}
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return v, false
	}
	nums := [3]*uint64{&v.major, &v.minor, &v.patch}
	for i, p := range parts {
		n, ok := numericIdent(p)
		if !ok {
			return v, false
		}
		*nums[i] = n
	}
	return v, true
}

func numericIdent(p string) (uint64, bool) {
	if p == "" || (len(p) > 1 && p[0] == '0') || strings.TrimLeft(p, "0123456789") != "" {
		return 0, false
	}
	n, err := strconv.ParseUint(p, 10, 64)
	return n, err == nil
}

// validIdents checks dot-separated [0-9A-Za-z-]+ identifiers. Numeric
// prerelease identifiers must not have leading zeros.
func validIdents(s string, pre bool) bool {
	for _, id := range strings.Split(s, ".") {
		if id == "" {
			return false
		}
		for _, r := range id {
			if !(r == '-' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
				return false
			}
		}
		if pre && strings.TrimLeft(id, "0123456789") == "" && len(id) > 1 && id[0] == '0' {
			return false
		}
	}
	return true
}

func cmpUint(a, b uint64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// compare follows SemVer 2.0.0 §11 precedence.
func (a semver) compare(b semver) int {
	for _, c := range []int{cmpUint(a.major, b.major), cmpUint(a.minor, b.minor), cmpUint(a.patch, b.patch)} {
		if c != 0 {
			return c
		}
	}
	switch {
	case a.pre == nil && b.pre == nil:
		return 0
	case a.pre == nil:
		return 1
	case b.pre == nil:
		return -1
	}
	for i := 0; i < len(a.pre) && i < len(b.pre); i++ {
		x, y := a.pre[i], b.pre[i]
		xn, xNum := numericIdent(x)
		yn, yNum := numericIdent(y)
		var c int
		switch {
		case xNum && yNum:
			c = cmpUint(xn, yn)
		case xNum:
			c = -1
		case yNum:
			c = 1
		default:
			c = strings.Compare(x, y)
		}
		if c != 0 {
			return c
		}
	}
	return cmpUint(uint64(len(a.pre)), uint64(len(b.pre)))
}

func (a semver) less(b semver) bool { return a.compare(b) < 0 }
