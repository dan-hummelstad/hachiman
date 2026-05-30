// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package management

import (
	"errors"
	"fmt"
	"net"
	"strings"

	"google.golang.org/grpc"
)

// Listener bundles the bound TCP socket and the gRPC server using it.
// Returned by Listen so callers can Stop() cleanly during shutdown.
type Listener struct {
	addr   string
	lis    net.Listener
	server *grpc.Server
}

// Addr returns the actual bound address (useful when callers passed
// ":0" / "127.0.0.1:0" to ask the OS to allocate a port).
func (l *Listener) Addr() string {
	return l.lis.Addr().String()
}

// Serve blocks running the gRPC server until Stop is called. Intended to
// run in its own goroutine.
func (l *Listener) Serve() error {
	return l.server.Serve(l.lis)
}

// Stop performs a graceful shutdown of the gRPC server and closes the
// listening socket. Safe to call multiple times.
func (l *Listener) Stop() {
	if l.server != nil {
		l.server.GracefulStop()
	}
}

// Listen binds the management gRPC server on addr and returns a Listener
// ready for Serve(). addr must be a non-empty host:port. The host is
// validated to be loopback — see security posture in service.go. An empty
// addr is treated as a wiring bug (callers should check ManagementListen
// before calling Listen).
func Listen(addr string, svc *Service) (*Listener, error) {
	if svc == nil {
		return nil, errors.New("management.Listen: service must not be nil")
	}
	if addr == "" {
		return nil, errors.New("management.Listen: addr must not be empty")
	}
	if err := requireLoopback(addr); err != nil {
		return nil, err
	}

	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("management.Listen: %w", err)
	}

	gs := grpc.NewServer()
	RegisterGrumbleManagementServer(gs, svc)

	return &Listener{
		addr:   addr,
		lis:    lis,
		server: gs,
	}, nil
}

// requireLoopback rejects any addr whose host is not a loopback address.
// This is a HARD safety rail: the MVP service has no auth, so a non-loopback
// bind would expose vServer create/delete to the network. Callers who
// genuinely need network exposure must add mTLS or a bearer-token
// interceptor and then loosen this check.
//
// We accept: 127.0.0.0/8 (IPv4 loopback), ::1 (IPv6 loopback), "localhost"
// (treated as loopback by convention), and "" or omitted host (when addr
// starts with ":") — the latter is OK because Go's net.Listen on ":port"
// binds to all interfaces, BUT we reject that here too: omitting the host
// is the most common way to accidentally bind to 0.0.0.0.
func requireLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("management.Listen: invalid addr %q: %w", addr, err)
	}
	if host == "" {
		return fmt.Errorf("management.Listen: addr %q omits host — refusing to bind to all interfaces "+
			"(MVP has no auth, loopback only); use 127.0.0.1:port or [::1]:port", addr)
	}
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("management.Listen: host %q is not an IP and not 'localhost' — refusing "+
			"(MVP has no auth, loopback only)", host)
	}
	if !ip.IsLoopback() {
		return fmt.Errorf("management.Listen: host %q is not loopback — refusing to bind "+
			"(MVP has no auth, loopback only)", host)
	}
	return nil
}
