// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"mumble.info/grumble/pkg/islandmetrics"
)

// islandMetricsRegistryAdapter satisfies islandmetrics.RegistrySnapshot by
// wrapping the cmd/grumble *ServerRegistry. The metrics package can't import
// cmd/grumble (which is `package main`), so the adapter lives here.
//
// List() returns a freshly-allocated slice via ServerRegistry.List(), so the
// publisher iterates without holding any caller lock. Each *Server is wrapped
// in serverClientCounter to expose only ClientCount() — the metrics package
// must not touch any other Server field (and physically can't, with this
// narrow interface).
type islandMetricsRegistryAdapter struct {
	registry *ServerRegistry
}

func (a *islandMetricsRegistryAdapter) List() []islandmetrics.ClientCounter {
	servers := a.registry.List()
	out := make([]islandmetrics.ClientCounter, 0, len(servers))
	for _, s := range servers {
		out = append(out, serverClientCounter{s: s})
	}
	return out
}

// serverClientCounter is the per-vServer ClientCounter wrapper. It reads
// len(server.clients) WITHOUT any lock — matching the existing access pattern
// in server.go (the UDP handler does the same at line ~1376 to ping-reply with
// the current client count). A momentarily stale count is acceptable for
// metrics; we're never on the voice hot path.
type serverClientCounter struct {
	s *Server
}

func (w serverClientCounter) ClientCount() int {
	return len(w.s.clients)
}

// Compile-time check that the adapter satisfies the metrics interface.
var _ islandmetrics.RegistrySnapshot = (*islandMetricsRegistryAdapter)(nil)
