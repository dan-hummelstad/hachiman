// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"flag"
	"fmt"
	"os"
)

// args is the parsed CLI surface for hachiman-recorder. Mirrors the
// hachiman-media flag style: one struct, one ParseCommandLines entry point,
// fs.Usage retained on the struct so main can re-trigger help.
type args struct {
	// Region tag this recorder serves. Logged today; used for placement /
	// label dispatch later. Defaults to "dev" so a freshly-cloned repo can
	// start the binary without any flags.
	Region string

	// Address of the media node hosting the room's primary SFU. Empty in
	// boot-test mode — the binary starts, sets up signal handling, and
	// blocks on shutdown without ever opening a subscription. Useful for
	// container smoke tests and the eventual k8s readiness probe.
	MediaAddr string

	// Room the recorder subscribes to. One room only; multi-room batching
	// is not implemented.
	RoomID string

	// Placeholder credential the media node verifies on SubscribeAsRecorder.
	// A real signed credential is not implemented.
	RecorderCredential string

	// S3 bucket for segment writes. The recorder logs received frames and
	// discards payload, so this is informational only.
	S3Bucket string

	// Path to a log file. Empty = stderr.
	LogPath string

	// usage is the flag.FlagSet's bound Usage func. Stored on args so main
	// can re-trigger help output when -help is passed.
	usage func()

	ShowHelp bool
}

// ParseCommandLines parses the recorder CLI surface and returns the populated
// args struct. Exits 2 on parse failure (flag.ExitOnError matches the media
// binary's behaviour).
func ParseCommandLines() args {
	var a args
	fs := flag.NewFlagSet("hachiman-recorder", flag.ExitOnError)
	fs.StringVar(&a.Region, "region", "dev", "region tag this recorder serves (e.g. us-east, eu-west)")
	fs.StringVar(&a.MediaAddr, "media-addr", "", "host:port of the media node hosting the room's primary SFU (empty = boot-test, no subscription)")
	fs.StringVar(&a.RoomID, "room-id", "", "room id to record; required when --media-addr is set")
	fs.StringVar(&a.RecorderCredential, "recorder-credential", "", "credential the media node verifies on SubscribeAsRecorder")
	fs.StringVar(&a.S3Bucket, "s3-bucket", "", "S3 bucket for segment writes (informational; the scaffold does not write to S3)")
	fs.StringVar(&a.LogPath, "log", "", "path to log file; empty writes to stderr")
	fs.BoolVar(&a.ShowHelp, "help", false, "print this help")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: hachiman-recorder [flags]")
		fs.PrintDefaults()
	}
	if err := fs.Parse(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	// Both --media-addr and --room-id must be set together, or both empty.
	// A half-configured pair used to silently fall into boot-test mode
	// (subscriber.run returned with no subscription); operators who
	// thought they configured a recorder would never get any logs that
	// suggested otherwise. Fail fast instead — exit code 2 matches
	// flag.ExitOnError's parse-failure path.
	hasMediaAddr := a.MediaAddr != ""
	hasRoomID := a.RoomID != ""
	if hasMediaAddr != hasRoomID {
		fmt.Fprintf(os.Stderr,
			"hachiman-recorder: --media-addr and --room-id must be set together (got media-addr=%q room-id=%q); leave both empty for boot-test mode\n",
			a.MediaAddr, a.RoomID)
		os.Exit(2)
	}
	a.usage = fs.Usage
	return a
}
