// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"testing"

	"mumble.info/grumble/pkg/acl"
)

// TestOracleAdminSuperUser_BypassesCertGuard locks in the channel-create
// permission contract for an Oracle-admin SuperUser.
//
// The bug class: a managed-mode owner authenticated via Oracle SSO has
// client.user == nil (no registered local account) and no client cert, so a
// "must be registered OR have a cert" guard wrongly rejects them — even
// though acl.HasPermission(MakeChannelPermission) already grants on the
// strength of UserId() == 0 (the SuperUser short-circuit).
//
// This test asserts the three properties the guard at message.go:258 (and
// any future sibling guard) must respect:
//
//   1. client.superUser = true implies IsSuperUser() == true even with
//      user == nil.
//   2. IsSuperUser() implies UserId() == 0 (which is what makes
//      acl.HasPermission short-circuit).
//   3. The exact predicate used at the create-channel guard
//      (IsSuperUser || IsRegistered || HasCertificate) admits such a client.
func TestOracleAdminSuperUser_BypassesCertGuard(t *testing.T) {
	// Oracle-admin profile: SuperUser flag set, no user record, no cert.
	c := &Client{superUser: true}

	if !c.IsSuperUser() {
		t.Fatalf("IsSuperUser() = false; want true when superUser flag is set with user == nil")
	}
	if c.IsRegistered() {
		t.Fatalf("IsRegistered() = true; want false when user == nil")
	}
	if c.HasCertificate() {
		t.Fatalf("HasCertificate() = true; want false when certHash is empty")
	}
	if got := c.UserId(); got != 0 {
		t.Fatalf("UserId() = %d; want 0 (so acl.HasPermission short-circuits)", got)
	}

	// Mirror the exact guard the fix uses at message.go:258 — if this
	// predicate ever regresses to !IsRegistered && !HasCertificate without
	// the SuperUser arm, the Oracle-admin path breaks again.
	if !c.IsSuperUser() && !c.IsRegistered() && !c.HasCertificate() {
		t.Fatalf("channel-create guard rejected Oracle-admin SuperUser; bug class regressed")
	}

	// acl.HasPermission must independently grant MakeChannelPermission via
	// the UserId() == 0 short-circuit — guards downstream of the ACL check
	// only matter if the ACL check itself grants.
	ctx := &acl.Context{Groups: map[string]acl.Group{}}
	if !acl.HasPermission(ctx, c, acl.MakeChannelPermission) {
		t.Fatalf("acl.HasPermission(MakeChannelPermission) = false; SuperUser short-circuit broken")
	}
}

// TestAnonymousNonSuperUser_RejectedByCertGuard is the negative control:
// the SuperUser bypass added at message.go:258 must NOT relax the guard for
// ordinary anonymous clients (no user, no cert, no SuperUser flag). They
// still need to be rejected — otherwise any guest could create channels.
func TestAnonymousNonSuperUser_RejectedByCertGuard(t *testing.T) {
	c := &Client{}

	if c.IsSuperUser() {
		t.Fatalf("IsSuperUser() = true on zero-value Client; want false")
	}

	// Same predicate as the fix — should reject.
	if !(!c.IsSuperUser() && !c.IsRegistered() && !c.HasCertificate()) {
		t.Fatalf("channel-create guard admitted anonymous non-SuperUser client; bypass too broad")
	}
}
