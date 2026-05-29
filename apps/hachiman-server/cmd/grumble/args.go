package main

import (
	"flag"
	"os"
	"path/filepath"
	"runtime"
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

	flag.Parse()

	if arg.LogPath == "" {
		arg.LogPath = defaultLogPath(arg.DataDir)
	}

	return arg
}
