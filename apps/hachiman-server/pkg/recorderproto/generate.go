// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

// Code generation for the media↔recorder sidechannel gRPC service.
//
// Run via:   go generate ./pkg/recorderproto/
//
// Requires (one-time setup):
//   go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
//   go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
//   (and protoc itself: `brew install protobuf` on macOS,
//    `apt install protobuf-compiler` on Debian/Ubuntu,
//    `dnf install protobuf-compiler` on Fedora/RHEL.)
//
// This is SEPARATE from pkg/mediaproto/ (control↔media) — per the doc, the
// recorder talks to media's primary SFU directly, never to control. The two
// surfaces stay split so recorder credentials don't bleed into the control
// plane.

//go:generate protoc --go_out=. --go_opt=paths=source_relative --go-grpc_out=. --go-grpc_opt=paths=source_relative RecorderControl.proto

package recorderproto
