package database_test

import (
	"testing"

	"mumble.info/grumble/pkg/database"
)

func TestServerAdd(t *testing.T) {
	db, err := NewTestDB()
	if err != nil {
		t.Fatal(err)
	}

	tx := db.Tx()
	defer tx.Rollback()
	serv, err := tx.ServerAdd()
	if err != nil {
		t.Fatal(err)
	}

	if serv == nil {
		t.Fatal("server is nil")
	}
	if serv.ServerID != 1 {
		t.Fatalf("first server id %d is not 1", serv.ServerID)
	}

	exists, err := tx.ServerExists(serv.ServerID)
	if err != nil {
		t.Fatal(err)
	}
	if !exists {
		t.Fatalf("server %d is not exists", serv.ServerID)
	}
}

func TestServerList(t *testing.T) {
	db, err := NewTestDB()
	if err != nil {
		t.Fatal(err)
	}

	tx := db.Tx()
	defer tx.Rollback()
	serv1, err := tx.ServerAdd()
	if err != nil {
		t.Fatal(err)
	}

	if serv1 == nil {
		t.Fatal("server is nil")
	}

	serv2, err := tx.ServerAdd()
	if err != nil {
		t.Fatal(err)
	}
	if serv2 == nil {
		t.Fatal("server is nil")
	}

	list, err := tx.ServerList(0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("server list count %d is not match", len(list))
	}
	if list[0].ServerID != serv1.ServerID {
		t.Fatalf("server 1 id is not match")
	}
	if list[1].ServerID != serv2.ServerID {
		t.Fatalf("server 2 id is not match")
	}
}

func TestServerDelete(t *testing.T) {
	db, err := NewTestDB()
	if err != nil {
		t.Fatal(err)
	}

	tx := db.Tx()
	defer tx.Rollback()
	serv, err := tx.ServerAdd()
	if err != nil {
		t.Fatal(err)
	}

	if serv == nil {
		t.Fatal("server is nil")
	}

	err = tx.ServerDelete(serv.ServerID)
	if err != nil {
		t.Fatal(err)
	}

	exists, err := tx.ServerExists(serv.ServerID)
	if err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Fatalf("server %d is still exists after delete", serv.ServerID)
	}
}

func NewTestServer(tx database.DbTx) (uint64, error) {
	serv, err := tx.ServerAdd()
	if err != nil {
		return 0, err
	}

	_, err = tx.ServerInit(serv.ServerID, database.UserPasswordHash{
		Hash:          "sha1:1:2",
		KDFIterations: 0,
	}, false)
	if err != nil {
		return 0, err
	}

	return serv.ServerID, nil
}

// TestServerInit_Idempotent locks in the contract that running ServerInit
// twice (and re-running each step on an already-initialised server) is a safe
// no-op AND leaves the root channel + admin group + admin GroupMember intact.
// The original ServerInit returned isNew=false on the second step as soon as
// ANY single bootstrap row existed and skipped the rest — that caused
// half-initialised servers (e.g. SuperUser row present but root channel
// missing) to Fatalf on the first client connect via Server.RootChannel().
func TestServerInit_Idempotent(t *testing.T) {
	db, err := NewTestDB()
	if err != nil {
		t.Fatal(err)
	}

	tx := db.Tx()
	defer tx.Rollback()

	serv, err := tx.ServerAdd()
	if err != nil {
		t.Fatal(err)
	}

	pw := database.UserPasswordHash{Hash: "sha1:1:2", KDFIterations: 0}

	isNew1, err := tx.ServerInit(serv.ServerID, pw, false)
	if err != nil {
		t.Fatal(err)
	}
	if !isNew1 {
		t.Fatalf("first ServerInit: isNew=%v, want true", isNew1)
	}

	// Second call: SuperUser already exists, expect isNew=false BUT all of
	// the bootstrap rows must still be present afterwards.
	isNew2, err := tx.ServerInit(serv.ServerID, pw, false)
	if err != nil {
		t.Fatalf("second ServerInit: %v", err)
	}
	if isNew2 {
		t.Fatalf("second ServerInit: isNew=%v, want false", isNew2)
	}

	// Root channel must exist.
	ch, err := tx.ChannelGet(serv.ServerID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if ch == nil {
		t.Fatal("root channel missing after ServerInit")
	}

	// "admin" group on root channel must exist.
	groups, err := tx.GroupGetByChannel(serv.ServerID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var adminGroup *database.Group
	for i := range groups {
		if groups[i].Name == "admin" {
			adminGroup = &groups[i]
			break
		}
	}
	if adminGroup == nil {
		t.Fatalf("admin group missing after ServerInit, got groups=%v", groups)
	}

	// SuperUser (UserID=0) must be a member of admin.
	members, err := tx.GroupMemberList(serv.ServerID, adminGroup.GroupID)
	if err != nil {
		t.Fatal(err)
	}
	foundSU := false
	for _, m := range members {
		if m.UserID == 0 && m.Addit {
			foundSU = true
			break
		}
	}
	if !foundSU {
		t.Fatalf("SuperUser not a member of admin group: members=%v", members)
	}
}

// TestServerInit_ManagedSkipsSuperUserRow locks in the managed-mode contract:
// when ServerInit is called with isManaged=true (the path the management
// gRPC CreateVirtualServer takes after stamping AdminOracleUserID), no
// SuperUser user row is created and no SuperUser admin-group membership is
// written. The root channel + admin group MUST still exist so future
// registered-user admin promotions have something to attach to.
//
// Why this matters: managed vServers authenticate exclusively via Oracle
// introspection; the owner is granted SuperUser-equivalent privileges
// through the side-channel `client.superUser` flag in handleAuthenticate,
// not through a UserID=0 row. Leaving a SuperUser row in the table is both
// a confusing dangling entity and a soft footgun if OracleOnly is ever
// flipped off.
func TestServerInit_ManagedSkipsSuperUserRow(t *testing.T) {
	db, err := NewTestDB()
	if err != nil {
		t.Fatal(err)
	}

	tx := db.Tx()
	defer tx.Rollback()

	serv, err := tx.ServerAdd()
	if err != nil {
		t.Fatal(err)
	}

	pw := database.UserPasswordHash{Hash: "sha1:1:2", KDFIterations: 0}
	isNew, err := tx.ServerInit(serv.ServerID, pw, true)
	if err != nil {
		t.Fatalf("managed ServerInit: %v", err)
	}
	if isNew {
		t.Fatalf("managed ServerInit: isNew=%v, want false (no SuperUser created)", isNew)
	}

	// SuperUser (UserID=0) MUST NOT exist on a managed vServer.
	suExists, err := tx.UserExists(serv.ServerID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if suExists {
		t.Fatalf("SuperUser row present on managed vServer (UserID=0); want absent")
	}

	// Root channel MUST exist.
	ch, err := tx.ChannelGet(serv.ServerID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if ch == nil {
		t.Fatal("root channel missing after managed ServerInit")
	}

	// Admin group MUST exist on root (future "promote registered user to
	// admin" hangs ACLs off it).
	groups, err := tx.GroupGetByChannel(serv.ServerID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var adminGroup *database.Group
	for i := range groups {
		if groups[i].Name == "admin" {
			adminGroup = &groups[i]
			break
		}
	}
	if adminGroup == nil {
		t.Fatalf("admin group missing after managed ServerInit, got groups=%v", groups)
	}

	// Admin group MUST have zero members — specifically, no UserID=0 row
	// pointing at the non-existent SuperUser.
	members, err := tx.GroupMemberList(serv.ServerID, adminGroup.GroupID)
	if err != nil {
		t.Fatal(err)
	}
	if len(members) != 0 {
		t.Fatalf("admin group has %d members on managed vServer, want 0: %v", len(members), members)
	}
}

// TestServerInit_RecoversFromMissingChannel covers the exact failure mode the
// crash log shows: SuperUser row was persisted by an earlier (partial) run
// but the root channel was rolled back. A subsequent ServerInit must finish
// the bootstrap rather than short-circuit on isNew=false.
func TestServerInit_RecoversFromMissingChannel(t *testing.T) {
	db, err := NewTestDB()
	if err != nil {
		t.Fatal(err)
	}

	tx := db.Tx()
	defer tx.Rollback()

	serv, err := tx.ServerAdd()
	if err != nil {
		t.Fatal(err)
	}

	// Simulate the half-initialised state: insert SuperUser directly, leave
	// the channel/group rows absent.
	pw := database.UserPasswordHash{Hash: "sha1:1:2", KDFIterations: 0}
	if _, err := tx.ServerInit(serv.ServerID, pw, false); err != nil {
		t.Fatal(err)
	}
	if err := tx.ChannelRemove(serv.ServerID, 0); err != nil {
		t.Fatal(err)
	}

	// Recovery call.
	if _, err := tx.ServerInit(serv.ServerID, pw, false); err != nil {
		t.Fatalf("recovery ServerInit: %v", err)
	}

	ch, err := tx.ChannelGet(serv.ServerID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if ch == nil {
		t.Fatal("root channel still missing after recovery ServerInit")
	}
}
