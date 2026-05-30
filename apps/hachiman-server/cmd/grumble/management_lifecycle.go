// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"mumble.info/grumble/pkg/database"
	"mumble.info/grumble/pkg/management"
)

// vserverLifecycle implements management.VServerLifecycle by bridging the
// management gRPC service into the cmd/grumble world (Server, ServerRegistry,
// NewServer/Start/Stop). The management package can't import cmd/grumble
// (main package), so the wiring lives here instead and is passed across the
// management.VServerLifecycle interface boundary.
type vserverLifecycle struct {
	registry *ServerRegistry
	db       *database.GrumbleDb
	dataDir  string
}

func newVServerLifecycle(registry *ServerRegistry, db *database.GrumbleDb, dataDir string) *vserverLifecycle {
	return &vserverLifecycle{
		registry: registry,
		db:       db,
		dataDir:  dataDir,
	}
}

// CreateAndStart spins up a freshly-created vServer (the id was just allocated
// by ServerAdd on the caller's tx). Mirrors the per-server boot the existing
// main() loop does: NewServer -> Start -> Register.
func (l *vserverLifecycle) CreateAndStart(id int64) error {
	srv, err := NewServer(id, l.dataDir, l.db)
	if err != nil {
		return err
	}
	if err := srv.Start(); err != nil {
		return err
	}
	l.registry.Register(srv)
	return nil
}

// StopAndRemove tears down a running vServer cleanly. The management service
// is responsible for the database-side delete; this hook only handles the
// in-process listeners/goroutines.
func (l *vserverLifecycle) StopAndRemove(id int64) error {
	srv, ok := l.registry.Get(id)
	if !ok {
		// Nothing to tear down in this process. Caller still proceeds with
		// the DB delete (the row may exist without an in-process server,
		// e.g. after a crash).
		return nil
	}
	// Unregister first so a concurrent List() can't hand the stopping
	// server out as live.
	l.registry.Unregister(id)
	if err := srv.Stop(); err != nil {
		// Re-register so we don't lose the handle to a server we failed to
		// stop — caller can retry. Unlikely path; Stop() in practice only
		// returns errors from listener.Close which we've already attempted.
		l.registry.Register(srv)
		return err
	}
	return nil
}

// Exists reports whether a vServer is currently running in this process.
func (l *vserverLifecycle) Exists(id int64) bool {
	return l.registry.Exists(id)
}

// Compile-time check that vserverLifecycle satisfies the interface contract.
var _ management.VServerLifecycle = (*vserverLifecycle)(nil)
