// Copyright (c) 2010 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"

	"mumble.info/grumble/pkg/blobstore"
	"mumble.info/grumble/pkg/database"
	"mumble.info/grumble/pkg/logtarget"
	"mumble.info/grumble/pkg/management"
)

var blobStore blobstore.BlobStore

// resolveDbConfig turns the boot-time persistence args into a database.DbConfig.
//
// SQLite (the default) is unchanged from the original behaviour: when no path
// is given it falls back to $DATADIR/murmur.sqlite and logs that choice, so the
// self-host zero-config flow is preserved exactly. Postgres uses the configured
// DSN verbatim. An EMPTY driver string is treated as "sqlite" (backwards
// compatible with launchers that set nothing); a non-empty UNRECOGNISED driver
// is passed through and rejected by NewDB rather than silently falling back — a
// typo'd driver should fail loudly, not quietly write a local sqlite file.
func resolveDbConfig(args args) *database.DbConfig {
	driver := args.DatabaseDriver
	if driver == "" {
		driver = "sqlite"
	}

	switch driver {
	case "postgres":
		log.Printf("Using Postgres database backend.")
		return &database.DbConfig{
			Type: "postgres",
			Conn: args.DatabaseDSN,
		}
	default:
		// "sqlite" (the default) lands here. A non-empty unrecognised driver
		// also lands here and is passed through as-is; NewDB then REJECTS it
		// (it does NOT fall back to sqlite). The block below preserves the
		// self-host default DB path for the sqlite case.
		sqliteDB := args.SQLiteDB
		if len(sqliteDB) == 0 {
			sqliteDB = filepath.Join(args.DataDir, "murmur.sqlite")
			log.Printf("Murmur SQLite database is not specified, will use %s as default.", sqliteDB)
		}
		return &database.DbConfig{
			Type: driver,
			Conn: sqliteDB,
		}
	}
}

func main() {
	var err error

	args := ParseCommandLines()
	if args.ShowHelp {
		Usage()
		return
	}

	// Open the data dir to check whether it exists.
	dataDir, err := os.Open(args.DataDir)
	if err != nil {
		log.Fatalf("Unable to open data directory (%v): %v", args.DataDir, err)
		return
	}
	dataDir.Close()

	// Set up logging
	logtarget.Default, err = logtarget.OpenFile(args.LogPath, os.Stderr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Unable to open log file (%v): %v", args.LogPath, err)
		return
	}
	log.SetPrefix("[G] ")
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.SetOutput(logtarget.Default)
	log.Printf("Grumble")
	log.Printf("Using data directory: %s", args.DataDir)

	// Open the blobstore.  If the directory doesn't
	// already exist, create the directory and open
	// the blobstore.
	// The Open method of the blobstore performs simple
	// sanity checking of content of the blob directory,
	// and will return an error if something's amiss.
	blobDir := filepath.Join(args.DataDir, "blob")
	err = os.Mkdir(blobDir, 0700)
	if err != nil && !os.IsExist(err) {
		log.Fatalf("Unable to create blob directory (%v): %v", blobDir, err)
	}
	blobStore = blobstore.Open(blobDir)

	// Check whether we should regenerate the default global keypair
	// and corresponding certificate.
	// These are used as the default certificate of all virtual servers
	// and the SSH admin console, but can be overridden using the "key"
	// and "cert" arguments to Grumble.
	certFn := filepath.Join(args.DataDir, "cert.pem")
	keyFn := filepath.Join(args.DataDir, "key.pem")
	shouldRegen := false
	if args.RegenKeys {
		shouldRegen = true
	} else {
		// OK. Here's the idea:  We check for the existence of the cert.pem
		// and key.pem files in the data directory on launch. Although these
		// might be deleted later (and this check could be deemed useless),
		// it's simply here to be convenient for admins.
		hasKey := true
		hasCert := true
		_, err = os.Stat(certFn)
		if err != nil && os.IsNotExist(err) {
			hasCert = false
		}
		_, err = os.Stat(keyFn)
		if err != nil && os.IsNotExist(err) {
			hasKey = false
		}
		if !hasCert && !hasKey {
			shouldRegen = true
		} else if !hasCert || !hasKey {
			if !hasCert {
				log.Fatal("Grumble could not find its default certificate (cert.pem)")
			}
			if !hasKey {
				log.Fatal("Grumble could not find its default private key (key.pem)")
			}
		}
	}
	if shouldRegen {
		log.Printf("Generating 4096-bit RSA keypair for self-signed certificate...")

		err := GenerateSelfSignedCert(certFn, keyFn, args.DataDir)
		if err != nil {
			log.Printf("Error: %v", err)
			return
		}

		log.Printf("Certificate output to %v", certFn)
		log.Printf("Private key output to %v", keyFn)
	}

	// Create the servers directory if it doesn't already
	// exist.
	serversDirPath := filepath.Join(args.DataDir, "servers")
	err = os.Mkdir(serversDirPath, 0700)
	if err != nil && !os.IsExist(err) {
		log.Fatalf("Unable to create servers directory: %v", err)
	}

	// Load database, create server from database. The backend is selected at
	// boot (CLI flag / env, see args.go); SQLite is the zero-config self-host
	// default, Postgres is opt-in for managed deployments.
	dbCfg := resolveDbConfig(args)
	db, err := database.NewDB(dbCfg)
	if err != nil {
		log.Fatalf("Unable to open the servers database: %v", err.Error())
	}
	err = db.Init()
	if err != nil {
		log.Fatalf("Unable to initialize database: %v", err.Error())
	}

	tx := db.Tx()
	dbServerList, err := tx.ServerList(0, 1000)
	if err != nil {
		tx.Rollback()
		log.Fatalf("Unable fetch server list from database: %v", err.Error())
	}
	tx.Commit()

	// In-process registry of running vServers, shared between the boot loop
	// here and the management gRPC API (so a runtime CreateVirtualServer
	// drops the new server into the same map the boot-loaded ones live in).
	registry := NewServerRegistry()

	servers := make([]*Server, len(dbServerList))
	for i, v := range dbServerList {
		serv, err := NewServer(int64(v.ServerID), args.DataDir, db)
		if err != nil {
			log.Fatalf("Unable to create server from database: %v", err.Error())
		}
		servers[i] = serv
	}

	// If no servers were found, create the default virtual server.
	if len(servers) == 0 {
		tx := db.Tx()
		rootSrv, err := tx.ServerAdd()
		if err != nil {
			tx.Rollback()
			log.Fatalf("Couldn't create server: %s", err.Error())
		}
		tx.Commit()

		s, err := NewServer(int64(rootSrv.ServerID), args.DataDir, db)
		if err != nil {
			log.Fatalf("Couldn't start server: %s", err.Error())
		}

		servers = append(servers, s)
	}

	// Launch the servers we found during launch. Register each one as it
	// comes up so the management API (if enabled) can see them.
	for _, server := range servers {
		err = server.Start()
		if err != nil {
			log.Printf("Unable to start server %v: %v", server.Id, err.Error())
			continue
		}
		registry.Register(server)
	}

	// Internal management gRPC API. Empty ManagementListen (the default)
	// disables it entirely — zero-config self-host opens no extra port and
	// starts no extra goroutines. See pkg/management/ for the security
	// posture (loopback only, no auth on the MVP).
	if args.ManagementListen != "" {
		lifecycle := newVServerLifecycle(registry, db, args.DataDir)
		svc := management.NewService(db, lifecycle)
		mgmt, err := management.Listen(args.ManagementListen, svc)
		if err != nil {
			log.Fatalf("Unable to start management API: %v", err)
		}
		log.Printf("Management gRPC API listening on %s", mgmt.Addr())
		go func() {
			if err := mgmt.Serve(); err != nil {
				log.Printf("Management gRPC API stopped: %v", err)
			}
		}()
	}

	// If any servers were loaded, launch the signal
	// handler goroutine and sleep...
	if len(servers) > 0 {
		go SignalHandler()
		select {}
	}
}
