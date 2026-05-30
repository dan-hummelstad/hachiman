// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"sync"
)

// ServerRegistry is a thread-safe, in-process registry of currently running
// virtual servers keyed by Server.Id. It is populated when servers are loaded
// at boot (existing flow in main()) AND when the management gRPC API creates a
// new vServer at runtime. The Oracle control plane uses the management API to
// drive this — see pkg/management/.
//
// The registry stays inside cmd/grumble (next to Server) so it can hold the
// concrete *Server type without an import cycle. The management service in
// pkg/management/ talks to it through a VServerLifecycle interface.
type ServerRegistry struct {
	mu      sync.RWMutex
	servers map[int64]*Server
}

func NewServerRegistry() *ServerRegistry {
	return &ServerRegistry{
		servers: make(map[int64]*Server),
	}
}

// Register adds a server to the registry. Calling Register twice for the same
// Id replaces the previous entry (callers should Unregister first if that
// matters).
func (r *ServerRegistry) Register(s *Server) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.servers[s.Id] = s
}

// Unregister removes a server from the registry. No-op if the id isn't
// registered.
func (r *ServerRegistry) Unregister(id int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.servers, id)
}

// Get returns the registered server for id, or (nil, false) if no such id is
// registered.
func (r *ServerRegistry) Get(id int64) (*Server, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.servers[id]
	return s, ok
}

// List returns a snapshot slice of all registered servers. Safe to iterate
// without holding the lock.
func (r *ServerRegistry) List() []*Server {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*Server, 0, len(r.servers))
	for _, s := range r.servers {
		out = append(out, s)
	}
	return out
}

// Exists reports whether a server with the given id is currently registered.
func (r *ServerRegistry) Exists(id int64) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, ok := r.servers[id]
	return ok
}
