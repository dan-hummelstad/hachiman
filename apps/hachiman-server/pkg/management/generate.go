// Copyright (c) 2026 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

// Code generation for the internal Grumble management gRPC API.
//
// Run via:   go generate ./pkg/management/
// or:        ./scripts/generate-management-proto.sh
//
// Requires (one-time setup):
//   go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
//   go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
//   (and protoc itself: `brew install protobuf` on macOS,
//    `apt install protobuf-compiler` on Debian/Ubuntu,
//    `dnf install protobuf-compiler` on Fedora/RHEL.)
//
// This is a SEPARATE generation from pkg/mumbleproto/ — that one downloads
// the upstream Mumble proto and regenerates `Mumble.pb.go`; this one is
// our own service definition with its own gRPC code emitter.

//go:generate protoc --go_out=. --go_opt=paths=source_relative --go-grpc_out=. --go-grpc_opt=paths=source_relative management.proto

package management
