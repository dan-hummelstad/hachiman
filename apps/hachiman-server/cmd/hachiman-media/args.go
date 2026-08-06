package main

import (
	"flag"
	"fmt"
	"os"
)

type args struct {
	// Region tag this node serves. Propagated to Oracle placement at
	// RegisterMediaNode time. Defaults to "dev" so a freshly-cloned repo
	// can start the binary without any flags.
	Region string

	// Address the sidechannel gRPC server listens on (control → media RPCs).
	// Defaults to loopback so an unconfigured node can't accept control-plane
	// traffic from arbitrary networks; deploys override to a routable address.
	SidechannelAddr string

	// Address of the control plane the node registers with on boot.
	// Empty in embedded mode — set by docker-compose / production deploy.
	ControlAddr string

	// Path to a log file. Empty = stderr.
	LogPath string

	// usage is the flag.FlagSet's bound Usage func. Stored on args so the
	// main package can re-trigger help output when -help is passed (rather
	// than maintaining a parallel hand-formatted Usage that drifts out of
	// sync with the actual flag definitions).
	usage func()

	ShowHelp bool
}

func ParseCommandLines() args {
	var a args
	fs := flag.NewFlagSet("hachiman-media", flag.ExitOnError)
	fs.StringVar(&a.Region, "region", "dev", "region tag this node serves (e.g. us-east, eu-west)")
	fs.StringVar(&a.SidechannelAddr, "sidechannel-addr", "127.0.0.1:7881", "address the sidechannel gRPC server listens on (loopback by default; deploys override)")
	fs.StringVar(&a.ControlAddr, "control-addr", "", "address of the control plane (empty in embedded/standalone mode)")
	fs.StringVar(&a.LogPath, "log", "", "path to log file; empty writes to stderr")
	fs.BoolVar(&a.ShowHelp, "help", false, "print this help")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: hachiman-media [flags]")
		fs.PrintDefaults()
	}
	if err := fs.Parse(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	a.usage = fs.Usage
	return a
}
