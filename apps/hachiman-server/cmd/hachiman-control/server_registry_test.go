// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"sync"
	"sync/atomic"
	"testing"

	"mumble.info/grumble/pkg/mediaproto"
)

func TestServerRegistry_RegisterGetUnregister(t *testing.T) {
	r := NewServerRegistry()

	// Empty registry: Get/Exists report not present, List is empty.
	if _, ok := r.Get(1); ok {
		t.Fatal("Get on empty registry returned ok=true")
	}
	if r.Exists(1) {
		t.Fatal("Exists on empty registry returned true")
	}
	if got := len(r.List()); got != 0 {
		t.Fatalf("List on empty registry has %d entries", got)
	}

	// Register and observe.
	s := &Server{Id: 42}
	r.Register(s)

	if got, ok := r.Get(42); !ok || got != s {
		t.Fatalf("Get(42) = (%v, %v), want (%v, true)", got, ok, s)
	}
	if !r.Exists(42) {
		t.Fatal("Exists(42) = false after Register")
	}
	if got := r.List(); len(got) != 1 || got[0] != s {
		t.Fatalf("List = %v, want [%v]", got, s)
	}

	// Unregister and observe.
	r.Unregister(42)
	if _, ok := r.Get(42); ok {
		t.Fatal("Get(42) returned ok=true after Unregister")
	}
	if r.Exists(42) {
		t.Fatal("Exists(42) = true after Unregister")
	}
	if got := len(r.List()); got != 0 {
		t.Fatalf("List after Unregister has %d entries", got)
	}

	// Unregister of an unknown id is a no-op.
	r.Unregister(999)
}

func TestServerRegistry_ConcurrentAccess(t *testing.T) {
	r := NewServerRegistry()

	// Hammer Register/Unregister/Get from several goroutines to exercise
	// the mutex. A race here would surface under `go test -race`.
	const workers = 16
	const ops = 100
	var wg sync.WaitGroup
	wg.Add(workers)
	for w := 0; w < workers; w++ {
		go func(base int64) {
			defer wg.Done()
			for i := int64(0); i < ops; i++ {
				id := base*1000 + i
				r.Register(&Server{Id: id})
				_, _ = r.Get(id)
				_ = r.List()
				r.Unregister(id)
			}
		}(int64(w))
	}
	wg.Wait()

	// After all workers finish, registry should be empty.
	if got := len(r.List()); got != 0 {
		t.Fatalf("List after concurrent churn = %d entries, want 0", got)
	}
}

// makeServerForRoutingTest builds a minimal *Server stub with just the
// fields HandleMediaInbound touches. Avoids the full DB / network setup.
func makeServerForRoutingTest(id int64) *Server {
	s := &Server{Id: id}
	ch := make(chan mediaInboundJob, 8)
	s.mediaInbound.Store(&ch)
	return s
}

// drain returns up to n jobs from the server's mediaInbound channel.
func drainInbound(t *testing.T, s *Server, n int) []mediaInboundJob {
	t.Helper()
	ch := derefMediaInbound(&s.mediaInbound)
	out := make([]mediaInboundJob, 0, n)
	for i := 0; i < n; i++ {
		select {
		case job := <-ch:
			out = append(out, job)
		default:
			return out
		}
	}
	return out
}

// TestServerRegistry_RoutesByVServerPrefix locks in CRITICAL #5: a
// session_id prefixed with the vServer id routes to the right vServer
// even when multiple vServers are registered.
func TestServerRegistry_RoutesByVServerPrefix(t *testing.T) {
	r := NewServerRegistry()
	s1 := makeServerForRoutingTest(1)
	s2 := makeServerForRoutingTest(2)
	r.Register(s1)
	r.Register(s2)

	// Envelope for vServer 1, session 42.
	r.HandleMediaInbound("node-a", &mediaproto.Envelope{
		Payload: &mediaproto.Envelope_SdpSignal{
			SdpSignal: &mediaproto.SdpSignal{SessionId: "1:42", SdpType: "offer", Sdp: "v=0"},
		},
	})
	// Envelope for vServer 2, session 7.
	r.HandleMediaInbound("node-a", &mediaproto.Envelope{
		Payload: &mediaproto.Envelope_SdpSignal{
			SdpSignal: &mediaproto.SdpSignal{SessionId: "2:7", SdpType: "offer", Sdp: "v=0"},
		},
	})

	got1 := drainInbound(t, s1, 4)
	got2 := drainInbound(t, s2, 4)

	if len(got1) != 1 || got1[0].session != 42 {
		t.Errorf("vServer 1 inbound = %+v, want [{session:42}]", got1)
	}
	if len(got2) != 1 || got2[0].session != 7 {
		t.Errorf("vServer 2 inbound = %+v, want [{session:7}]", got2)
	}
}

// TestServerRegistry_RoutesMalformedAreDropped locks in the malformed
// session_id path: no panic, no envelope on either vServer.
func TestServerRegistry_RoutesMalformedAreDropped(t *testing.T) {
	r := NewServerRegistry()
	s := makeServerForRoutingTest(1)
	r.Register(s)

	// No colon at all.
	r.HandleMediaInbound("node-a", &mediaproto.Envelope{
		Payload: &mediaproto.Envelope_SdpSignal{
			SdpSignal: &mediaproto.SdpSignal{SessionId: "garbage"},
		},
	})
	// Unknown vServer.
	r.HandleMediaInbound("node-a", &mediaproto.Envelope{
		Payload: &mediaproto.Envelope_SdpSignal{
			SdpSignal: &mediaproto.SdpSignal{SessionId: "999:42"},
		},
	})

	if got := drainInbound(t, s, 4); len(got) != 0 {
		t.Errorf("vServer 1 received %d jobs, want 0", len(got))
	}
}

// TestServerRegistry_DropCounter locks in HIGH #1: when mediaInbound is
// saturated, drops are counted on the vServer rather than silently
// blocking the sidechannel.
func TestServerRegistry_DropCounter(t *testing.T) {
	r := NewServerRegistry()
	s := &Server{Id: 5}
	// Tiny buffer so the second envelope can't fit.
	ch := make(chan mediaInboundJob, 1)
	s.mediaInbound.Store(&ch)
	r.Register(s)

	for i := 0; i < 4; i++ {
		r.HandleMediaInbound("node-a", &mediaproto.Envelope{
			Payload: &mediaproto.Envelope_SdpSignal{
				SdpSignal: &mediaproto.SdpSignal{SessionId: "5:1"},
			},
		})
	}

	if got := atomic.LoadUint64(&s.mediaInboundDropped); got != 3 {
		t.Errorf("mediaInboundDropped = %d, want 3", got)
	}
}

func TestServerRegistry_RegisterReplaces(t *testing.T) {
	r := NewServerRegistry()
	s1 := &Server{Id: 7}
	s2 := &Server{Id: 7}

	r.Register(s1)
	r.Register(s2)

	got, ok := r.Get(7)
	if !ok {
		t.Fatal("Get(7) returned ok=false after double-Register")
	}
	if got != s2 {
		t.Fatalf("Get(7) returned %v, want %v (second Register should replace)", got, s2)
	}
	if got := len(r.List()); got != 1 {
		t.Fatalf("List has %d entries after double-Register, want 1", got)
	}
}
