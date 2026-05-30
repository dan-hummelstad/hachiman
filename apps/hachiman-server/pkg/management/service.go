// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

// Package management implements the INTERNAL gRPC control surface that lets
// the Oracle control plane create and delete virtual servers at runtime on a
// running Grumble process.
//
// =============================================================================
// SECURITY POSTURE — MVP, READ BEFORE EXPOSING
// =============================================================================
//
// This service has NO authentication and NO authorization. It MUST be bound
// to loopback only (the default config is `ManagementListen=""` = disabled;
// the documented enabling address is `127.0.0.1:50051`). Binding it to
// 0.0.0.0 or any non-loopback interface is a CRITICAL misconfiguration: any
// network reachable to that interface can create/delete vServers on the
// host.
//
// Production exposure (future work, NOT in this MVP):
//   - mTLS: terminate gRPC behind a TLS credentials pair, require client
//     cert verification against a known CA. Wire up via
//     grpc.NewServer(grpc.Creds(creds)).
//   - OR a shared bearer token: a UnaryInterceptor that validates a
//     constant-time-compared token in incoming metadata.
//
// Today's deployment story: this listener stays on 127.0.0.1 and the Oracle
// control plane reaches it either over a unix socket or through k3s
// pod-to-pod traffic on the same node (loopback inside the pod network).
//
// =============================================================================
package management

import (
	"context"
	"errors"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"mumble.info/grumble/pkg/database"
)

// Service implements the GrumbleManagementServer gRPC interface generated
// from management.proto. Construct via NewService.
type Service struct {
	UnimplementedGrumbleManagementServer

	db        *database.GrumbleDb
	lifecycle VServerLifecycle
}

// NewService wires up the management gRPC service. db is the shared
// database handle (must be the same one the running vServers use, so
// transactions land in the same backend). lifecycle bridges into the
// in-process Server/registry — see cmd/grumble/management_lifecycle.go.
func NewService(db *database.GrumbleDb, lifecycle VServerLifecycle) *Service {
	return &Service{
		db:        db,
		lifecycle: lifecycle,
	}
}

// CreateVirtualServer allocates a new vServer row in the database AND boots
// it in-process. The boot reuses the same NewServer + Start flow main()
// uses for the boot-time server list, so a vServer created via this RPC is
// indistinguishable from one loaded at startup.
//
// On any error after ServerAdd, the database tx is rolled back so we don't
// leave an orphaned row pointing at a never-started server.
func (s *Service) CreateVirtualServer(ctx context.Context, _ *CreateVirtualServerRequest) (*CreateVirtualServerResponse, error) {
	tx := s.db.Tx()
	dbServer, err := tx.ServerAdd()
	if err != nil {
		_ = tx.Rollback()
		return nil, status.Errorf(codes.Internal, "ServerAdd: %v", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, status.Errorf(codes.Internal, "commit ServerAdd: %v", err)
	}

	id := int64(dbServer.ServerID)

	// Boot in-process. If this fails, undo the DB allocation so the caller
	// (a control plane) can retry without leaking a row that nothing is
	// serving. Note: a failed start could be transient (port in use) or
	// permanent (config bug) — in both cases the cleanest contract is
	// "Create either fully succeeds or leaves no trace".
	if err := s.lifecycle.CreateAndStart(id); err != nil {
		undoTx := s.db.Tx()
		if delErr := undoTx.ServerDelete(uint64(id)); delErr != nil {
			_ = undoTx.Rollback()
			return nil, status.Errorf(codes.Internal,
				"start failed (%v) AND rollback failed (%v) — server %d orphaned in DB",
				err, delErr, id)
		}
		if commitErr := undoTx.Commit(); commitErr != nil {
			return nil, status.Errorf(codes.Internal,
				"start failed (%v) AND rollback commit failed (%v) — server %d orphaned in DB",
				err, commitErr, id)
		}
		return nil, status.Errorf(codes.Internal, "CreateAndStart: %v", err)
	}

	return &CreateVirtualServerResponse{ServerId: id}, nil
}

// DeleteVirtualServer stops the vServer in-process (if running) and removes
// its database row. Returns NotFound when the id exists in neither the DB
// nor the in-process registry.
//
// Stop-first-then-delete is deliberate: tearing down listeners before
// pulling the DB row out from under the running server avoids a window
// where the server is accepting connections it can no longer authenticate
// (config lookups would 404).
func (s *Service) DeleteVirtualServer(ctx context.Context, req *DeleteVirtualServerRequest) (*DeleteVirtualServerResponse, error) {
	if req.GetServerId() <= 0 {
		return nil, status.Error(codes.InvalidArgument, "server_id must be > 0")
	}
	id := req.GetServerId()

	// Check existence — registry first (fast), then DB. Either side claims
	// existence => proceed; both deny => NotFound.
	existsInRegistry := s.lifecycle.Exists(id)
	existsInDB := false
	if !existsInRegistry {
		tx := s.db.Tx()
		ok, err := tx.ServerExists(uint64(id))
		_ = tx.Rollback() // read-only, no need to commit
		if err != nil {
			return nil, status.Errorf(codes.Internal, "ServerExists: %v", err)
		}
		existsInDB = ok
	}
	if !existsInRegistry && !existsInDB {
		return nil, status.Errorf(codes.NotFound, "virtual server %d does not exist", id)
	}

	// Stop in-process first. StopAndRemove is a no-op if the server isn't
	// in the registry, so it's safe to call unconditionally.
	if err := s.lifecycle.StopAndRemove(id); err != nil {
		return nil, status.Errorf(codes.Internal, "StopAndRemove: %v", err)
	}

	// Now delete the DB row.
	tx := s.db.Tx()
	if err := tx.ServerDelete(uint64(id)); err != nil {
		_ = tx.Rollback()
		return nil, status.Errorf(codes.Internal, "ServerDelete: %v", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, status.Errorf(codes.Internal, "commit ServerDelete: %v", err)
	}

	return &DeleteVirtualServerResponse{}, nil
}

// ErrMissingDB is returned by NewService validation helpers when a nil db
// would lead to a nil pointer panic at first RPC. Exported so callers can
// distinguish wiring bugs from RPC errors at startup.
var ErrMissingDB = errors.New("management.NewService: db must not be nil")
