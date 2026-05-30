// Copyright (c) 2011 The Grumble Authors
// The use of this source code is goverened by a BSD-style
// license that can be found in the LICENSE-file.

package serverconf

import (
	"strconv"
	"sync"
)

var DefaultCfg = map[string]string{
	"MaxBandwidth":          "72000",
	"MaxUsers":              "1000",
	"MaxUsersPerChannel":    "0",
	"MaxTextMessageLength":  "5000",
	"MaxImageMessageLength": "131072",
	"AllowHTML":             "true",
	"DefaultChannel":        "0",
	"RememberChannel":       "true",
	"WelcomeText":           "Welcome to this server running <b>Grumble</b>.",
	"SendVersion":           "true",
	"AllowRecording":        "true",
	"ChannelNestingLimit":   "10",
	"MessageLimit":          "1",
	"MessageBurst":          "5",
	"PluginMessageLimit":    "4",
	"PluginMessageBurst":    "15",

	// Oracle / Takusen SSO (RFC 7662 introspection).
	// All three URL/ClientID/ClientSecret must be set for the server to
	// attempt introspection on inbound Authenticate.oracle_token values.
	"OracleIntrospectionURL": "",
	"OracleClientID":         "",
	"OracleClientSecret":     "",
	// When true, reject any client that does not present a verifiable
	// Oracle token. Defaults to false so anonymous clients are still
	// accepted on servers that haven't opted in.
	"OracleOnly": "false",
	// The logical voice region this server is currently homed in (e.g.
	// "us-east"), mirroring the Oracle registry's mutable `servers.region`.
	// Empty = unplaced. Read via cfg.StringValue("ServerRegion"); informational
	// today, consumed by the future placement/re-home layer.
	"ServerRegion": "",

	// Persistence backend selection.
	//
	// NOTE: unlike the keys above, these are *bootstrap* settings. The
	// per-vServer config map is itself stored in the database, so the DB
	// backend must be resolved before any config can be read from it
	// (chicken-and-egg). The authoritative values are therefore read at
	// process start from CLI flags / environment (DATABASE_DRIVER,
	// DATABASE_DSN) in cmd/grumble; these defaults document the contract and
	// give callers a single place to discover the supported values.
	//
	// DatabaseDriver selects the GORM dialector: "sqlite" (default, self-host,
	// zero-config) or "postgres" (managed — points the vServer at a central
	// Postgres so any island can restore any vServer).
	"DatabaseDriver": "sqlite",
	// DatabaseDSN is the Postgres connection string, used only when
	// DatabaseDriver=postgres. Empty ⇒ fall back to the SQLite path/default.
	// Example: "host=localhost user=oracle password=oracle dbname=oracle port=5432 sslmode=disable".
	"DatabaseDSN": "",

	// Internal management gRPC API listen address. Empty (the default)
	// disables the API entirely — zero-config self-host behaviour is
	// preserved, no extra port is opened. Set to a LOOPBACK address (e.g.
	// "127.0.0.1:50051") to enable the API for an Oracle control plane.
	//
	// SECURITY: MVP has NO auth. A non-loopback host is rejected at startup
	// — production exposure requires mTLS or a bearer token (deferred). See
	// pkg/management/service.go for the full posture.
	"ManagementListen": "",
}

type ConfigRepo interface {
	Set(key string, value string)
	StringValue(key string) string
	IntValue(key string) int
	Uint32Value(key string) uint32
	BoolValue(key string) bool
}

type Config struct {
	cfgMap map[string]string
	mutex  sync.RWMutex
}

// Create a new Config using cfgMap as the intial internal config map.
// If cfgMap is nil, ConfigWithMap will create a new config map.
func New(cfgMap map[string]string) ConfigRepo {
	if cfgMap == nil {
		cfgMap = make(map[string]string)
	}
	return &Config{cfgMap: cfgMap}
}

// GetAll gets a copy of the Config's internal config map
func (cfg *Config) GetAll() (all map[string]string) {
	cfg.mutex.RLock()
	defer cfg.mutex.RUnlock()

	all = make(map[string]string)
	for k, v := range cfg.cfgMap {
		all[k] = v
	}
	return
}

// Set a new value for a config key
func (cfg *Config) Set(key string, value string) {
	cfg.mutex.Lock()
	defer cfg.mutex.Unlock()
	cfg.cfgMap[key] = value
}

// Reset the value of a config key
func (cfg *Config) Reset(key string) {
	cfg.mutex.Lock()
	defer cfg.mutex.Unlock()
	delete(cfg.cfgMap, key)
}

// StringValue gets the value of a specific config key encoded as a string
func (cfg *Config) StringValue(key string) (value string) {
	cfg.mutex.RLock()
	defer cfg.mutex.RUnlock()

	value, exists := cfg.cfgMap[key]
	if exists {
		return value
	}

	value, exists = DefaultCfg[key]
	if exists {
		return value
	}

	return ""
}

// IntValue gets the value of a speific config key as an int
func (cfg *Config) IntValue(key string) (intval int) {
	str := cfg.StringValue(key)
	intval, _ = strconv.Atoi(str)
	return
}

// Uint32Value gets the value of a specific config key as a uint32
func (cfg *Config) Uint32Value(key string) (uint32val uint32) {
	str := cfg.StringValue(key)
	uintval, _ := strconv.ParseUint(str, 10, 0)
	return uint32(uintval)
}

// BoolValue gets the value fo a sepcific config key as a bool
func (cfg *Config) BoolValue(key string) (boolval bool) {
	str := cfg.StringValue(key)
	boolval, _ = strconv.ParseBool(str)
	return
}
