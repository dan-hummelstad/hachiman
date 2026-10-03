// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"flag"
	"fmt"
	"os"
	"strconv"

	"hachiman/server/pkg/voicetoken"
)

// args mirrors contract §8 "Media flags/env".
type args struct {
	NodeID          string
	Region          string
	Listen          string
	SignalingURL    string
	TakusenGRPCAddr string
	RedisURL        string
	VoicePubKey     string // hex Ed25519 public key (prod)
	VoiceKey        string // seed path shared with the gateway (dev); used when VoicePubKey is empty
	PublicIP        string
	UDPPortMin      uint
	UDPPortMax      uint
	MaxSessions     uint
	LogPath         string
	WSReadLimit     int64 // MEDIA_WS_READ_LIMIT: largest client frame in bytes
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func parseArgs(argv []string) (args, error) {
	var a args
	host, _ := os.Hostname()
	fs := flag.NewFlagSet("hachiman-media", flag.ContinueOnError)
	// Hostname default: stable across dev restarts (the gateway's sticky
	// voice_room:{channelId} and the token aud keep pointing at us) and
	// unique per container in prod.
	fs.StringVar(&a.NodeID, "node-id", envOr("MEDIA_NODE_ID", "media-"+host), "media node id (token aud + Takusen registry key)")
	fs.StringVar(&a.Region, "region", envOr("MEDIA_REGION", "dev"), "region tag this node serves")
	fs.StringVar(&a.Listen, "listen", ":8090", "HTTP listen address for /voice and /healthz")
	fs.StringVar(&a.SignalingURL, "signaling-url", "ws://localhost:8090/voice", "public voice WS URL registered with Takusen")
	fs.StringVar(&a.TakusenGRPCAddr, "takusen-grpc-addr", envOr("TAKUSEN_GRPC_ADDR", "127.0.0.1:50051"), "Takusen management gRPC address (empty disables registration)")
	fs.StringVar(&a.RedisURL, "redis-url", envOr("REDIS_URL", "redis://localhost:6379"), "Redis URL for media:{nodeId} kicks")
	fs.StringVar(&a.VoicePubKey, "voice-pubkey", os.Getenv("VOICE_PUBKEY"), "hex Ed25519 public key of the gateway's voice-token signer")
	fs.StringVar(&a.VoiceKey, "voice-key", envOr("VOICE_KEY", voicetoken.DefaultKeyPath), "voice-token seed file shared with the gateway (dev; ignored when --voice-pubkey is set) (env VOICE_KEY)")
	fs.StringVar(&a.PublicIP, "public-ip", "", "public IP advertised in ICE host candidates (pion NAT 1:1)")
	fs.UintVar(&a.UDPPortMin, "udp-port-min", 0, "lowest UDP port for WebRTC (0 = ephemeral)")
	fs.UintVar(&a.UDPPortMax, "udp-port-max", 0, "highest UDP port for WebRTC (0 = ephemeral)")
	fs.UintVar(&a.MaxSessions, "max-sessions", 500, "capacity reported to Takusen placement")
	fs.StringVar(&a.LogPath, "log", "", "log file path; empty = stderr")
	fs.Usage = func() {
		fmt.Fprintln(fs.Output(), "Usage: hachiman-media [flags]")
		fs.PrintDefaults()
	}
	if err := fs.Parse(argv); err != nil {
		return a, err
	}
	if a.UDPPortMin > 65535 || a.UDPPortMax > 65535 || a.UDPPortMin > a.UDPPortMax {
		return a, fmt.Errorf("invalid --udp-port-min/max %d-%d", a.UDPPortMin, a.UDPPortMax)
	}
	a.WSReadLimit = defaultReadLimit
	if v := os.Getenv("MEDIA_WS_READ_LIMIT"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 {
			return a, fmt.Errorf("invalid MEDIA_WS_READ_LIMIT %q", v)
		}
		a.WSReadLimit = n
	}
	if a.NodeID == "" || a.RedisURL == "" {
		return a, fmt.Errorf("--node-id and --redis-url are required")
	}
	return a, nil
}
