package main

import (
	"flag"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"text/template"
)

type UsageArgs struct {
	Version        string
	BuildDate      string
	OS             string
	Arch           string
	DefaultDataDir string
}

var usageTmpl = `usage: grumble [options]

 grumble {{.Version}} ({{.BuildDate}})
 target: {{.OS}}, {{.Arch}}

 --help
     Shows this help listing.

 --datadir <data-dir> (default: {{.DefaultDataDir}})
     Directory to use for server storage.

 --log <log-path> (default: $DATADIR/grumble.log)
     Log file path.

 --regen-keys
     Force grumble to regenerate its global RSA
     keypair (and certificate).

     The global keypair lives in the root of the
     grumble data directory.

 --import-murmurdb <murmur-sqlite-path>
     Import a Murmur SQLite database into grumble.

     Use the --cleanup argument to force grumble to
     clean up its data directory when doing the
     import. This is *DESTRUCTIVE*! Use with care.

 --database-driver <sqlite|postgres> (default: sqlite, env: DATABASE_DRIVER)
     Selects the persistence backend. "sqlite" keeps the
     zero-config self-host database in the data directory.
     "postgres" points the server at a central Postgres
     (managed deployments); requires --database-dsn.

 --database-dsn <dsn> (default: empty, env: DATABASE_DSN)
     Postgres connection string, used only when
     --database-driver=postgres. Example:
     "host=localhost user=oracle password=oracle dbname=oracle port=5432 sslmode=disable".

 --management-listen <host:port> (default: empty, env: MANAGEMENT_LISTEN)
     Enables the INTERNAL gRPC management API on the given
     LOOPBACK address (e.g. "127.0.0.1:50051"). Empty
     (the default) disables the API entirely — no extra
     port is opened, zero-config self-host is unchanged.
     SECURITY: MVP has no auth; non-loopback addresses are
     rejected at startup. Production exposure requires mTLS
     or a bearer token (deferred follow-up).

 --island-metrics-redis-url <url> (default: empty, env: ISLAND_METRICS_REDIS_URL)
     Redis connection string the island metrics publisher
     writes to, e.g. "redis://localhost:6379". Empty (the
     default) disables the publisher entirely — no Redis
     connection, no extra goroutine. Both this AND
     --island-metrics-island-id must be set to enable.

 --island-metrics-island-id <uuid> (default: empty, env: ISLAND_METRICS_ISLAND_ID)
     This island's UUID, matching the Oracle islands.id row.
     Required (along with --island-metrics-redis-url) to
     enable the publisher.

 --island-metrics-publish-interval-sec <seconds> (default: 5, env: ISLAND_METRICS_PUBLISH_INTERVAL_SEC)
     How often per-island metrics are pushed to Redis. The
     Redis key TTL is 3x this interval, so a stopped
     publisher's metrics expire after ~15s by default.

 --media-sidechannel-addr <host:port> (default: empty, env: MEDIA_SIDECHANNEL_ADDR)
     Address the MediaControl sidechannel gRPC server binds
     on. hachiman-media nodes dial this address to register
     and stream heartbeats. Default is empty — the
     sidechannel is OFF in zero-config self-host so no extra
     port is opened. Set to "127.0.0.1:7880" (or another
     loopback addr) to enable; non-loopback hosts are
     rejected at startup because phase 1 ships without mTLS.
     Split-mode deploys override to a routable address once
     mTLS lands later in phase 5.

 --coturn-config <path> (default: empty, env: COTURN_CONFIG)
     Path to a JSON file describing per-region coturn TURN
     clusters (regions, endpoints, HMAC secret, credential
     TTL). Empty (the default) leaves VoiceTokenGrant
     ice_servers empty — the client falls back to host /
     srflx ICE only. Loaded once at boot; reload requires a
     restart. See pkg/coturn for the schema.

 --oracle-addr <host:port> (default: empty, env: ORACLE_ADDR)
     gRPC address of the Oracle control plane that owns
     media-node registration + placement. Empty (the
     default) keeps the in-memory media registry
     authoritative — local pickNode() drives placement in
     dev / embedded mode. When set, sidechannel events
     forward to Oracle's RegisterMediaNode /
     MediaNodeHeartbeat best-effort, and PlaceMediaSession
     is called at session setup with local fallback.
`

type args struct {
	ShowHelp  bool
	DataDir   string
	LogPath   string
	RegenKeys bool
	SQLiteDB  string
	CleanUp   bool

	// Persistence backend selection (bootstrap; see serverconf.DefaultCfg).
	// DatabaseDriver is "sqlite" (default, self-host) or "postgres" (managed).
	// DatabaseDSN is the Postgres connection string, only used when
	// DatabaseDriver=postgres.
	DatabaseDriver string
	DatabaseDSN    string

	// Internal management gRPC API listen address (e.g. "127.0.0.1:50051").
	// Empty disables the API — zero-config self-host preserved. See
	// pkg/management/ for the full security posture.
	ManagementListen string

	// Island metrics publisher (see pkg/islandmetrics/ and ISLAND-METRICS.md).
	// All three are gated together: the publisher only starts when BOTH
	// IslandMetricsRedisURL and IslandMetricsIslandID are non-empty. With
	// either empty (the default), zero-config self-host is preserved — no
	// Redis connection and no extra goroutine.
	IslandMetricsRedisURL           string
	IslandMetricsIslandID           string
	IslandMetricsPublishIntervalSec int

	// MediaSidechannelAddr is the loopback host:port the MediaControl gRPC
	// server binds on. Default is empty (disabled) so zero-config self-host
	// opens no extra port — operators opt in by setting this. Embedded mode
	// (hachiman-media in-process) also leaves this empty. Mirrors the
	// hachiman-media -sidechannel-addr flag (cmd/hachiman-media/args.go).
	MediaSidechannelAddr string

	// CoturnConfig is the path to the per-region coturn TURN config JSON
	// file. Empty (default) → no TURN; ice_servers stays empty on
	// VoiceTokenGrant. Loaded once at boot; reload requires restart.
	CoturnConfig string

	// OracleAddr is the gRPC address of the Oracle control plane that owns
	// media-node placement and registry. Empty (default) → in-memory
	// registry is authoritative; pickNode() drives placement locally.
	OracleAddr string
}

// envOr returns the value of the environment variable named by key, or def if
// the variable is unset or empty. Used to let bootstrap settings be supplied
// via the environment (convenient for container deployments) while still
// allowing an explicit CLI flag to win.
func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// envOrInt is the int-typed sibling of envOr. Unset / empty / unparseable
// values fall through to def — silent rather than fatal because these are
// optional bootstrap flags; a typo'd env var should not crash the boot.
func envOrInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func defaultDataDir() string {
	homedir := os.Getenv("HOME")
	dirname := ".grumble"
	if runtime.GOOS == "windows" {
		homedir = os.Getenv("USERPROFILE")
	}
	return filepath.Join(homedir, dirname)
}

func defaultLogPath(dataDir string) string {
	return filepath.Join(dataDir, "grumble.log")
}

func Usage() {
	t, err := template.New("usage").Parse(usageTmpl)
	if err != nil {
		panic("unable to parse usage template")
	}

	err = t.Execute(os.Stdout, UsageArgs{
		Version:        version,
		BuildDate:      buildDate,
		OS:             runtime.GOOS,
		Arch:           runtime.GOARCH,
		DefaultDataDir: defaultDataDir(),
	})
	if err != nil {
		panic("unable to execute usage template")
	}
}

func ParseCommandLines() args {
	var arg args

	flag.Usage = Usage

	flag.BoolVar(&arg.ShowHelp, "help", false, "")
	flag.StringVar(&arg.DataDir, "datadir", defaultDataDir(), "")
	flag.StringVar(&arg.LogPath, "log", "", "")
	flag.BoolVar(&arg.RegenKeys, "regen-keys", false, "")

	flag.StringVar(&arg.SQLiteDB, "import-murmurdb", "", "")
	flag.BoolVar(&arg.CleanUp, "cleanup", false, "")

	// Bootstrap persistence settings. Default to the environment so container
	// deployments can configure them without rewriting the launch command;
	// an explicit flag still overrides. SQLite remains the zero-config default.
	flag.StringVar(&arg.DatabaseDriver, "database-driver", envOr("DATABASE_DRIVER", "sqlite"), "")
	flag.StringVar(&arg.DatabaseDSN, "database-dsn", envOr("DATABASE_DSN", ""), "")

	// Management gRPC API listen address (mirrors the database flag pattern:
	// flag wins over env, env wins over default-empty/disabled).
	flag.StringVar(&arg.ManagementListen, "management-listen", envOr("MANAGEMENT_LISTEN", ""), "")

	// Island metrics publisher (mirrors the management/database pattern: flag
	// wins over env, env wins over default-empty/disabled). The interval is
	// a positive integer in seconds; an unparseable env falls through to 5.
	flag.StringVar(&arg.IslandMetricsRedisURL, "island-metrics-redis-url", envOr("ISLAND_METRICS_REDIS_URL", ""), "")
	flag.StringVar(&arg.IslandMetricsIslandID, "island-metrics-island-id", envOr("ISLAND_METRICS_ISLAND_ID", ""), "")
	flag.IntVar(&arg.IslandMetricsPublishIntervalSec, "island-metrics-publish-interval-sec", envOrInt("ISLAND_METRICS_PUBLISH_INTERVAL_SEC", 5), "")

	// MediaControl sidechannel listener. Default is empty (disabled) so a
	// zero-config self-host install does NOT silently open a new gRPC port.
	// Set this (e.g. "127.0.0.1:7880") to enable; non-loopback hosts are
	// rejected at startup because phase 1 has no mTLS yet. Split-mode deploys
	// override to a routable address once mTLS lands later in phase 5.
	flag.StringVar(&arg.MediaSidechannelAddr, "media-sidechannel-addr", envOr("MEDIA_SIDECHANNEL_ADDR", ""), "")

	// Per-region coturn TURN config. Phase 3a wires the loader + minter; the
	// VoiceTokenGrant emission path that consumes it is gated on phase 4
	// client work (see TODO in webrtc_handlers.go:setupWebRTCForClient).
	flag.StringVar(&arg.CoturnConfig, "coturn-config", envOr("COTURN_CONFIG", ""), "")

	// Oracle gRPC address. Empty (default) keeps the in-memory registry
	// authoritative. When set, control's media-node registration mirrors to
	// Oracle and PlaceMediaSession is called at session setup.
	flag.StringVar(&arg.OracleAddr, "oracle-addr", envOr("ORACLE_ADDR", ""), "")

	flag.Parse()

	if arg.LogPath == "" {
		arg.LogPath = defaultLogPath(arg.DataDir)
	}

	return arg
}
