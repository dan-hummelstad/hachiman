// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package management

import (
	"context"
	"runtime"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"mumble.info/grumble/pkg/database"
)

// fakeLifecycle is a test double for VServerLifecycle. It records the calls
// the service makes against it without spinning up a real Server (which
// would need TLS cert files, sockets, etc. — out of scope for unit tests).
type fakeLifecycle struct {
	mu          sync.Mutex
	created     []int64
	stopped     []int64
	failStart   bool  // when set, CreateAndStart returns an error
	failStop    bool  // when set, StopAndRemove returns an error
	portBase    int32 // when non-zero, CreateAndStart reports (portBase+id-1, 0). Defaults to 64738.
	webPortBase int32 // when non-zero, CreateAndStart reports webPortBase+id-1 as the web port.
}

func (f *fakeLifecycle) CreateAndStart(id int64) (int32, int32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failStart {
		return 0, 0, testErr("simulated start failure")
	}
	f.created = append(f.created, id)
	base := f.portBase
	if base == 0 {
		base = 64738
	}
	port := base + int32(id) - 1
	var webPort int32
	if f.webPortBase != 0 {
		webPort = f.webPortBase + int32(id) - 1
	}
	return port, webPort, nil
}

func (f *fakeLifecycle) StopAndRemove(id int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failStop {
		return testErr("simulated stop failure")
	}
	f.stopped = append(f.stopped, id)
	return nil
}

func (f *fakeLifecycle) Exists(id int64) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.created {
		if c == id {
			// also check we haven't already stopped it
			for _, s := range f.stopped {
				if s == id {
					return false
				}
			}
			return true
		}
	}
	return false
}

type testErr string

func (e testErr) Error() string { return string(e) }

func newTestDB(t *testing.T) *database.GrumbleDb {
	t.Helper()
	db, err := database.NewDB(&database.DbConfig{
		Type: "sqlite",
		Conn: ":memory:",
	})
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	if err := db.Init(); err != nil {
		t.Fatalf("db.Init: %v", err)
	}
	return db
}

func TestCreateVirtualServer_AllocatesIdAndBootsInProcess(t *testing.T) {
	db := newTestDB(t)
	lc := &fakeLifecycle{}
	svc := NewService(db, lc)

	resp, err := svc.CreateVirtualServer(context.Background(), &CreateVirtualServerRequest{})
	if err != nil {
		t.Fatalf("CreateVirtualServer: %v", err)
	}
	if resp.ServerId <= 0 {
		t.Fatalf("got server_id %d, want > 0", resp.ServerId)
	}

	// DB row exists.
	tx := db.Tx()
	exists, err := tx.ServerExists(uint64(resp.ServerId))
	_ = tx.Rollback()
	if err != nil {
		t.Fatalf("ServerExists: %v", err)
	}
	if !exists {
		t.Fatalf("server %d not in DB after Create", resp.ServerId)
	}

	// Lifecycle was invoked.
	if got := len(lc.created); got != 1 || lc.created[0] != resp.ServerId {
		t.Fatalf("lifecycle.created = %v, want [%d]", lc.created, resp.ServerId)
	}

	// The response surfaces the port the freshly-booted vServer is listening
	// on so Oracle can persist it without having to recompute Grumble's
	// auto-derivation. The fakeLifecycle returns 64738 + id - 1 by default.
	wantPort := int32(64738) + int32(resp.ServerId) - 1
	if resp.Port != wantPort {
		t.Fatalf("resp.Port = %d, want %d", resp.Port, wantPort)
	}
	// WebPort is 0 when web listening is disabled (fakeLifecycle defaults).
	if resp.WebPort != 0 {
		t.Fatalf("resp.WebPort = %d, want 0 (no web listener configured)", resp.WebPort)
	}

	// Without admin_oracle_user_id the config row MUST NOT be written —
	// self-host vServers stay in their existing zero-config state and the
	// Authenticate-time owner grant never fires.
	tx = db.Tx()
	val, err := tx.ConfigGet(uint64(resp.ServerId), AdminOracleUserIDConfigKey)
	_ = tx.Rollback()
	if err != nil {
		t.Fatalf("ConfigGet AdminOracleUserID: %v", err)
	}
	if val != "" {
		t.Fatalf("AdminOracleUserID = %q, want empty (no admin_oracle_user_id in request)", val)
	}
}

// TestCreateVirtualServer_PersistsAdminOracleUserID locks in the contract
// that an admin_oracle_user_id supplied on Create is written to the
// per-server config under AdminOracleUserIDConfigKey. The Authenticate-time
// grant in cmd/grumble reads that exact key. Defense in depth: the grant
// also requires a SUCCESSFUL Oracle introspection — this RPC just stores the
// expected `sub`, it cannot grant on its own.
func TestCreateVirtualServer_PersistsAdminOracleUserID(t *testing.T) {
	db := newTestDB(t)
	lc := &fakeLifecycle{}
	svc := NewService(db, lc)

	const adminID = "550e8400-e29b-41d4-a716-446655440000"
	resp, err := svc.CreateVirtualServer(context.Background(),
		&CreateVirtualServerRequest{AdminOracleUserId: adminID})
	if err != nil {
		t.Fatalf("CreateVirtualServer: %v", err)
	}

	tx := db.Tx()
	val, err := tx.ConfigGet(uint64(resp.ServerId), AdminOracleUserIDConfigKey)
	_ = tx.Rollback()
	if err != nil {
		t.Fatalf("ConfigGet: %v", err)
	}
	if val != adminID {
		t.Fatalf("AdminOracleUserID = %q, want %q", val, adminID)
	}
}

// TestCreateVirtualServer_PersistsOracleSSOConfig locks in the contract that
// the Oracle introspection URL, client_id, client_secret AND OracleOnly=true
// are all stamped on the new vServer's config alongside AdminOracleUserID.
// Without these four, the handleAuthenticate Oracle-grant path is a silent
// no-op (introspectOracleToken's Enabled() check requires URL+ID+secret),
// which would defeat the whole point of "managed" servers.
func TestCreateVirtualServer_PersistsOracleSSOConfig(t *testing.T) {
	db := newTestDB(t)
	lc := &fakeLifecycle{}
	svc := NewService(db, lc)

	const (
		adminID = "550e8400-e29b-41d4-a716-446655440000"
		url     = "https://oracle.example/api/oidc/token/introspection"
		clntID  = "grumble-management"
		secret  = "do-not-log-this"
	)
	resp, err := svc.CreateVirtualServer(context.Background(),
		&CreateVirtualServerRequest{
			AdminOracleUserId:      adminID,
			OracleIntrospectionUrl: url,
			OracleClientId:         clntID,
			OracleClientSecret:     secret,
		})
	if err != nil {
		t.Fatalf("CreateVirtualServer: %v", err)
	}

	tx := db.Tx()
	defer func() { _ = tx.Rollback() }()
	want := map[string]string{
		AdminOracleUserIDConfigKey:      adminID,
		OracleIntrospectionURLConfigKey: url,
		OracleClientIDConfigKey:         clntID,
		OracleClientSecretConfigKey:     secret,
		OracleOnlyConfigKey:             "true",
	}
	for key, expected := range want {
		got, err := tx.ConfigGet(uint64(resp.ServerId), key)
		if err != nil {
			t.Fatalf("ConfigGet %s: %v", key, err)
		}
		if got != expected {
			t.Fatalf("%s = %q, want %q", key, got, expected)
		}
	}
}

// TestCreateVirtualServer_SkipsOracleSSOConfigForBareCreate ensures the
// Oracle/SSO stamping is gated on admin_oracle_user_id — a bare
// CreateVirtualServer (no admin id supplied, e.g. self-host parity tests
// and the existing TestCreateVirtualServer_AllocatesIdAndBootsInProcess
// flow) does NOT silently flip OracleOnly=true or stash blank credentials.
func TestCreateVirtualServer_SkipsOracleSSOConfigForBareCreate(t *testing.T) {
	db := newTestDB(t)
	lc := &fakeLifecycle{}
	svc := NewService(db, lc)

	resp, err := svc.CreateVirtualServer(context.Background(), &CreateVirtualServerRequest{})
	if err != nil {
		t.Fatalf("CreateVirtualServer: %v", err)
	}

	tx := db.Tx()
	defer func() { _ = tx.Rollback() }()
	for _, key := range []string{
		OracleIntrospectionURLConfigKey,
		OracleClientIDConfigKey,
		OracleClientSecretConfigKey,
		OracleOnlyConfigKey,
	} {
		val, err := tx.ConfigGet(uint64(resp.ServerId), key)
		if err != nil {
			t.Fatalf("ConfigGet %s: %v", key, err)
		}
		if val != "" {
			t.Fatalf("%s = %q, want empty (no admin_oracle_user_id supplied)", key, val)
		}
	}
}

// TestCreateVirtualServer_AdminOracleUserID_RollsBackOnStartFailure ensures
// the persistence is tied to the in-process boot succeeding: if
// CreateAndStart fails, the parent server row is deleted, which cascades the
// config rows too — no stranded owner-id row pointing at a deleted server.
func TestCreateVirtualServer_AdminOracleUserID_RollsBackOnStartFailure(t *testing.T) {
	db := newTestDB(t)
	lc := &fakeLifecycle{failStart: true}
	svc := NewService(db, lc)

	const adminID = "00000000-0000-0000-0000-000000000001"
	_, err := svc.CreateVirtualServer(context.Background(),
		&CreateVirtualServerRequest{AdminOracleUserId: adminID})
	if err == nil {
		t.Fatal("expected error when CreateAndStart fails")
	}

	// No server rows.
	tx := db.Tx()
	list, err := tx.ServerList(0, 100)
	_ = tx.Rollback()
	if err != nil {
		t.Fatalf("ServerList: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("expected 0 servers after rollback, got %d", len(list))
	}
}

func TestCreateVirtualServer_RollsBackOnStartFailure(t *testing.T) {
	db := newTestDB(t)
	lc := &fakeLifecycle{failStart: true}
	svc := NewService(db, lc)

	_, err := svc.CreateVirtualServer(context.Background(), &CreateVirtualServerRequest{})
	if err == nil {
		t.Fatal("expected error when CreateAndStart fails, got nil")
	}
	if st, _ := status.FromError(err); st.Code() != codes.Internal {
		t.Fatalf("err code = %v, want Internal", st.Code())
	}

	// Confirm no orphaned row remains in the DB. A failed boot must
	// undo its ServerAdd so the control plane can retry without
	// leaking ids.
	tx := db.Tx()
	list, err := tx.ServerList(0, 100)
	_ = tx.Rollback()
	if err != nil {
		t.Fatalf("ServerList: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("expected 0 servers after rollback, got %d: %v", len(list), list)
	}
}

func TestDeleteVirtualServer_RemovesFromDBAndRegistry(t *testing.T) {
	db := newTestDB(t)
	lc := &fakeLifecycle{}
	svc := NewService(db, lc)

	createResp, err := svc.CreateVirtualServer(context.Background(), &CreateVirtualServerRequest{})
	if err != nil {
		t.Fatalf("CreateVirtualServer: %v", err)
	}
	id := createResp.ServerId

	_, err = svc.DeleteVirtualServer(context.Background(), &DeleteVirtualServerRequest{ServerId: id})
	if err != nil {
		t.Fatalf("DeleteVirtualServer: %v", err)
	}

	// DB row is gone.
	tx := db.Tx()
	exists, err := tx.ServerExists(uint64(id))
	_ = tx.Rollback()
	if err != nil {
		t.Fatalf("ServerExists: %v", err)
	}
	if exists {
		t.Fatalf("server %d still in DB after Delete", id)
	}

	// Lifecycle saw the stop call.
	if got := len(lc.stopped); got != 1 || lc.stopped[0] != id {
		t.Fatalf("lifecycle.stopped = %v, want [%d]", lc.stopped, id)
	}
}

func TestDeleteVirtualServer_NotFound(t *testing.T) {
	db := newTestDB(t)
	lc := &fakeLifecycle{}
	svc := NewService(db, lc)

	// Delete on a never-created id.
	_, err := svc.DeleteVirtualServer(context.Background(), &DeleteVirtualServerRequest{ServerId: 999})
	if err == nil {
		t.Fatal("expected NotFound, got nil")
	}
	st, ok := status.FromError(err)
	if !ok {
		t.Fatalf("err is not a status error: %v", err)
	}
	if st.Code() != codes.NotFound {
		t.Fatalf("err code = %v, want NotFound", st.Code())
	}
}

func TestDeleteVirtualServer_SecondDeleteReturnsNotFound(t *testing.T) {
	db := newTestDB(t)
	lc := &fakeLifecycle{}
	svc := NewService(db, lc)

	createResp, err := svc.CreateVirtualServer(context.Background(), &CreateVirtualServerRequest{})
	if err != nil {
		t.Fatalf("CreateVirtualServer: %v", err)
	}
	id := createResp.ServerId

	// First delete succeeds.
	if _, err := svc.DeleteVirtualServer(context.Background(), &DeleteVirtualServerRequest{ServerId: id}); err != nil {
		t.Fatalf("first DeleteVirtualServer: %v", err)
	}

	// Second delete must return NotFound.
	_, err = svc.DeleteVirtualServer(context.Background(), &DeleteVirtualServerRequest{ServerId: id})
	if err == nil {
		t.Fatal("expected NotFound on second delete, got nil")
	}
	st, _ := status.FromError(err)
	if st.Code() != codes.NotFound {
		t.Fatalf("second delete err code = %v, want NotFound", st.Code())
	}
}

func TestDeleteVirtualServer_InvalidArgument(t *testing.T) {
	db := newTestDB(t)
	lc := &fakeLifecycle{}
	svc := NewService(db, lc)

	for _, badID := range []int64{0, -1, -42} {
		_, err := svc.DeleteVirtualServer(context.Background(), &DeleteVirtualServerRequest{ServerId: badID})
		if err == nil {
			t.Errorf("server_id=%d: expected error, got nil", badID)
			continue
		}
		st, _ := status.FromError(err)
		if st.Code() != codes.InvalidArgument {
			t.Errorf("server_id=%d: code = %v, want InvalidArgument", badID, st.Code())
		}
	}
}

// TestCreateDelete_NoGoroutineLeak verifies the fake-lifecycle Create+Delete
// cycle doesn't strand goroutines. We can't test the real Server.Stop() leak
// behaviour here without standing up TLS listeners (out of scope for unit
// tests — covered manually via the managed-smoke test), but we CAN catch
// any goroutine leak introduced inside the service itself.
func TestCreateDelete_NoGoroutineLeak(t *testing.T) {
	db := newTestDB(t)
	lc := &fakeLifecycle{}
	svc := NewService(db, lc)

	// Settle existing goroutines (GC, the SQLite driver's bookkeeping).
	runtime.GC()
	time.Sleep(50 * time.Millisecond)
	before := runtime.NumGoroutine()

	for i := 0; i < 5; i++ {
		createResp, err := svc.CreateVirtualServer(context.Background(), &CreateVirtualServerRequest{})
		if err != nil {
			t.Fatalf("iter %d Create: %v", i, err)
		}
		_, err = svc.DeleteVirtualServer(context.Background(), &DeleteVirtualServerRequest{ServerId: createResp.ServerId})
		if err != nil {
			t.Fatalf("iter %d Delete: %v", i, err)
		}
	}

	runtime.GC()
	time.Sleep(50 * time.Millisecond)
	after := runtime.NumGoroutine()

	// Allow a small tolerance for scheduler noise — what we care about is
	// that the count is bounded, not strictly equal.
	if after-before > 2 {
		t.Fatalf("goroutine leak: before=%d after=%d (delta=%d)", before, after, after-before)
	}
}

func TestListen_RejectsNonLoopback(t *testing.T) {
	db := newTestDB(t)
	svc := NewService(db, &fakeLifecycle{})

	for _, addr := range []string{
		"0.0.0.0:50051",
		"192.168.1.1:50051",
		":50051", // omitted host = all interfaces
		"example.com:50051",
	} {
		_, err := Listen(addr, svc)
		if err == nil {
			t.Errorf("addr=%q: expected error, got nil", addr)
		}
	}
}

func TestListen_AcceptsLoopback(t *testing.T) {
	db := newTestDB(t)
	svc := NewService(db, &fakeLifecycle{})

	// Bind to 127.0.0.1:0 to let the OS pick a free port.
	lis, err := Listen("127.0.0.1:0", svc)
	if err != nil {
		t.Fatalf("Listen on loopback: %v", err)
	}
	defer lis.Stop()

	if lis.Addr() == "" {
		t.Fatal("Listener.Addr() is empty after successful Listen")
	}
}
