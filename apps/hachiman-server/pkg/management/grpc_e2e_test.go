// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package management

import (
	"context"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

// TestGRPC_EndToEnd_CreateDelete spins up the real gRPC server on a loopback
// port, dials it with a real client, and runs Create + Delete. This is the
// "managed smoke test" called out in the task — equivalent to grpcurl
// without needing the binary.
func TestGRPC_EndToEnd_CreateDelete(t *testing.T) {
	db := newTestDB(t)
	lc := &fakeLifecycle{}
	svc := NewService(db, lc)

	lis, err := Listen("127.0.0.1:0", svc)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer lis.Stop()

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- lis.Serve()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, err := grpc.NewClient(
		lis.Addr(),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("grpc.NewClient: %v", err)
	}
	defer conn.Close()

	client := NewGrumbleManagementClient(conn)

	// CREATE.
	createResp, err := client.CreateVirtualServer(ctx, &CreateVirtualServerRequest{})
	if err != nil {
		t.Fatalf("CreateVirtualServer: %v", err)
	}
	if createResp.ServerId <= 0 {
		t.Fatalf("server_id = %d, want > 0", createResp.ServerId)
	}

	// DELETE.
	if _, err := client.DeleteVirtualServer(ctx, &DeleteVirtualServerRequest{ServerId: createResp.ServerId}); err != nil {
		t.Fatalf("DeleteVirtualServer: %v", err)
	}

	// Second DELETE => NotFound.
	_, err = client.DeleteVirtualServer(ctx, &DeleteVirtualServerRequest{ServerId: createResp.ServerId})
	if err == nil {
		t.Fatal("expected NotFound on second delete")
	}
	st, _ := status.FromError(err)
	if st.Code() != codes.NotFound {
		t.Fatalf("second delete code = %v, want NotFound", st.Code())
	}

	// Tear down. GracefulStop drains in-flight RPCs first.
	lis.Stop()
	select {
	case err := <-serveErr:
		if err != nil && err != grpc.ErrServerStopped {
			// grpc.Serve returns nil after GracefulStop.
			t.Logf("Serve returned: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Serve did not return after GracefulStop")
	}
}
