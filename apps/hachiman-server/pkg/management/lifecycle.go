// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package management

// VServerLifecycle is the narrow surface the management gRPC service needs
// from cmd/grumble to drive a vServer's in-process lifecycle. The concrete
// implementation lives in cmd/grumble (it can hold a *Server and call
// NewServer/Start/Stop directly) — keeping it behind this interface lets
// pkg/management/ stay reusable, testable in isolation, and free of an
// import cycle on the main package.
//
// Contract:
//   - CreateAndStart MUST construct an in-process vServer for the given id
//     (allocated by the caller via ServerAdd) and bring it fully online
//     (listeners up, registry populated). On success it returns the TCP/UDP
//     port the vServer is now listening on plus the WebSocket port (0 when
//     web listening is disabled). Errors propagate as gRPC Internal.
//   - StopAndRemove MUST tear down the in-process vServer cleanly (no
//     goroutine or listener leaks) if it is running. It is OK if the id is
//     not registered — the DB row may exist without a live process (e.g.
//     after a crash) and the caller still proceeds with the DB delete.
//   - Exists reports whether the id is currently running in this process,
//     independent of the database. Used for sanity / debugging, not as the
//     primary "does this server exist?" check (the DB is the source of
//     truth there).
type VServerLifecycle interface {
	CreateAndStart(id int64) (port int32, webPort int32, err error)
	StopAndRemove(id int64) error
	Exists(id int64) bool
}
