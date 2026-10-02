// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

// Code generation for the media-plane management gRPC API (contract §9).
//
// Run via:   go generate ./pkg/management/
//
// Requires (one-time setup):
//   go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
//   go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
//   (and protoc itself: `brew install protobuf` on macOS,
//    `apt install protobuf-compiler` on Debian/Ubuntu,
//    `dnf install protobuf-compiler` on Fedora/RHEL.)

//go:generate protoc --go_out=. --go_opt=paths=source_relative --go-grpc_out=. --go-grpc_opt=paths=source_relative management.proto

package management
