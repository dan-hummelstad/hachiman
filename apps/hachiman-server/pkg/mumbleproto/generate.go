// Copyright (c) 2011 The Grumble Authors
// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

// Code generation for the Hachiman Mumble proto fork.
//
// The proto is no longer a mirror of upstream Mumble — media-plane phase 2
// added VoiceTokenRequest / VoiceTokenGrant / MediaTrackPublish / ... and
// deleted UDPTunnel / VoiceTarget / CryptSetup (packet-type IDs 1/15/19 are
// permanently burned in the registry). Regenerating MUST NOT clobber those
// edits — that's why this no longer pulls from
// https://github.com/mumble-voip/mumble. Hand-edit Mumble.proto and run
// `go generate ./pkg/mumbleproto/`.
//
// Requires (one-time setup):
//   go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
//   (and protoc itself: `brew install protobuf` on macOS,
//    `apt install protobuf-compiler` on Debian/Ubuntu,
//    `dnf install protobuf-compiler` on Fedora/RHEL.)

//go:generate protoc --go_out=. --go_opt=paths=source_relative Mumble.proto

package mumbleproto
