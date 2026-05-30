// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"sync"
	"testing"
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
