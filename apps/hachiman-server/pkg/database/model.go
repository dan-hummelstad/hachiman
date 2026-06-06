package database

import (
	"fmt"

	"gorm.io/driver/postgres"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

const (
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
	err := d.db.AutoMigrate(&Meta{}, &Server{}, &ServerLog{}, &Config{}, &Channel{}, &ChannelInfo{}, &User{}, &UserInfo{}, &Group{}, &GroupMember{}, &ACL{}, &ChannelLink{}, &Ban{}, &ChannelListener{}, &Message{})
	if err != nil {
		return err
	}

	tx := d.Tx()
	defer tx.Commit()
	err = tx.MetaSetVersion(DBStructureVersion)
	if err != nil {
		return err
	}
	return nil
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
