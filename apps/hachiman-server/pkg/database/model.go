package database

import (
	"fmt"

	"gorm.io/driver/postgres"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

const (
	// DBStructureVersion is informational only. AutoMigrate is the only
	// migration tool wired into Init() — there is no per-version migration
	// step keyed off this constant, and no MetaGetVersion gate that decides
	// whether a migration runs. Bump it ONLY when you wire a real per-version
	// migration step alongside the bump.
	//
	// Until then, the canonical dev-stage workflow is "drop the SQLite file
	// and let the next boot reseed" (see the user's dev-migrations note);
	// stacking ALTERs through AutoMigrate-then-bump is the anti-pattern we
	// are explicitly avoiding.
	DBStructureVersion = 9
)

type GrumbleDb struct {
	db *gorm.DB
}

type DbConfig struct {
	Type string
	Conn string
}

// NewDB opens the Grumble database.
//
// In managed (postgres) mode every Grumble table is expected to live under the
// `grumble` schema so it can coexist with the Oracle control plane (which owns
// `servers`, `users`, ... in `public`) in a single Postgres database. The
// schema separation is enforced at the CONNECTION level via the DSN — set
// `search_path=grumble` in your DSN (URL form: `?search_path=grumble`;
// KV form: `options='-c search_path=grumble'`). The `grumble` schema itself is
// bootstrapped by docker/init.sql.
//
// We don't use GORM's `NamingStrategy.TablePrefix` for this because every
// Grumble model implements `TableName()` (the `Tabler` interface), and GORM
// bypasses TablePrefix whenever Tabler is implemented — so the prefix would
// silently do nothing. `search_path` is the connection-side equivalent.
//
// SQLite (self-host default) has no schema concept; the DSN is just a file
// path, no `search_path` needed, self-host behaviour unchanged.
func NewDB(cfg *DbConfig) (*GrumbleDb, error) {
	var dialet gorm.Dialector

	gormCfg := &gorm.Config{
		NamingStrategy: schema.NamingStrategy{
			TablePrefix:   "",
			SingularTable: true, // use singular table name, table for `User` would be `user` with this option enabled
			NameReplacer:  nil,
		},
	}

	switch cfg.Type {
	case "sqlite":
		dialet = sqlite.Open(cfg.Conn)
	case "postgres":
		if cfg.Conn == "" {
			return nil, fmt.Errorf("postgres database selected but no DSN/connection string configured")
		}
		dialet = postgres.Open(cfg.Conn)
		// Postgres rejects FK constraints that target a UNIQUE INDEX rather
		// than a UNIQUE CONSTRAINT / PRIMARY KEY. Several Grumble models
		// (Channel, Group, ACL, ChannelInfo, ...) declare COMPOSITE
		// uniqueness via GORM's `uniqueIndex:<name>` tag, which emits an
		// INDEX, not a CONSTRAINT — SQLite happily accepts FKs against
		// either, Postgres strictly requires the constraint. Rather than
		// retrofitting every composite-unique relation across the models,
		// we skip FK CONSTRAINT creation during AutoMigrate on the Postgres
		// path. The tables, columns, and unique indexes are still created;
		// only the DB-level FK enforcement is skipped. This matches
		// SQLite's effective default (FKs are off unless
		// `PRAGMA foreign_keys=ON`), so semantics stay consistent across
		// the two drivers. Application-level relationships (GORM preloads,
		// Go-side cascade logic in delete paths) are unaffected.
		gormCfg.DisableForeignKeyConstraintWhenMigrating = true
	default:
		return nil, fmt.Errorf("invalid sql database type %q", cfg.Type)
	}

	db, err := gorm.Open(dialet, gormCfg)
	if err != nil {
		return nil, err
	}

	return &GrumbleDb{
		db: db,
	}, nil
}

func (d *GrumbleDb) Init() error {
	// AutoMigrate order matters for SQLite (FKs are enforced in GORM's
	// sqlite driver, so referenced tables must exist before the table that
	// references them). On Postgres FK CONSTRAINT creation is suppressed via
	// DisableForeignKeyConstraintWhenMigrating, so order is tolerant there
	// too — placing QualityProfile first is harmless either way. The same
	// constraint applies to any future model that holds a FK target column.
	err := d.db.AutoMigrate(&Meta{}, &QualityProfile{}, &Server{}, &ServerLog{}, &Config{}, &Channel{}, &ChannelInfo{}, &User{}, &UserInfo{}, &Group{}, &GroupMember{}, &ACL{}, &ChannelLink{}, &Ban{}, &ChannelListener{}, &Message{})
	if err != nil {
		return err
	}

	// Use the explicit commit/rollback pattern so a mid-transaction error
	// doesn't leak a half-applied state via a deferred Commit (was a real
	// hazard pre-fix: the deferred Commit ran even when SeedDefaultQualityProfile
	// failed, persisting the version bump without the seed).
	tx := d.Tx()
	if err := tx.MetaSetVersion(DBStructureVersion); err != nil {
		_ = tx.Rollback()
		return err
	}
	// Seed the default quality profile. Idempotent — re-running Init() on a
	// populated DB is a no-op via the unique index on `quality_profiles.name`.
	if _, err := tx.SeedDefaultQualityProfile(); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

type DbTx struct {
	db *gorm.DB
}

func (d *GrumbleDb) Tx() DbTx {
	return DbTx{
		db: d.db.Begin(),
	}
}

func (d *DbTx) Commit() error {
	return d.db.Commit().Error
}

func (d *DbTx) Rollback() error {
	return d.db.Rollback().Error
}

func (d *GrumbleDb) Transaction(fc func(tx *DbTx) error) error {
	return d.db.Transaction(func(tx *gorm.DB) error {
		return fc(&DbTx{db: tx})
	})
}
