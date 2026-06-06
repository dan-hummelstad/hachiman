package database

import "gorm.io/gorm/clause"

type Config struct {
	ServerID uint64  `gorm:"not null;uniqueIndex:config_key"`
	Server   *Server `gorm:"constraint:OnDelete:CASCADE;"`

	Key   string `gorm:"uniqueIndex:config_key"`
	Value string
}

func (s Config) TableName() string {
	return "config"
}

func (d *DbTx) ConfigGet(sid uint64, key string) (string, error) {
	cfg := Config{}
	err := d.db.Find(&cfg, "server_id = ? AND key = ?", sid, key).Error
	if err != nil {
		return "", err
	}
	return cfg.Value, nil
}

func (d *DbTx) ConfigList(sid uint64) (map[string]string, error) {
	var cfgs []Config
	err := d.db.Find(&cfgs, "server_id = ?", sid).Error
	if err != nil {
		return nil, err
	}

	kvMap := make(map[string]string)
	for _, cfg := range cfgs {
		kvMap[cfg.Key] = cfg.Value
	}
	return kvMap, nil
}

func (d *DbTx) ConfigSet(sid uint64, key, value string) error {
	cfg := Config{
		ServerID: sid,
		Key:      key,
		Value:    value,
	}
	err := d.db.Clauses(clause.OnConflict{
		// Postgres requires the conflict target on UPSERT; SQLite is lenient.
		// Matches the `config_key` index defined on the model.
		Columns:   []clause.Column{{Name: "server_id"}, {Name: "key"}},
		UpdateAll: true,
	}).Create(&cfg).Error
	return err
}

// ConfigClear removes a single per-server config key. Idempotent: deleting a
// non-existent (sid, key) returns nil. Needed for callers that have to clean
// up specific config rows independently of the parent server row — notably the
// management gRPC CreateVirtualServer rollback path, which can't rely on
// FK-cascade on Postgres (the GORM config sets
// DisableForeignKeyConstraintWhenMigrating=true for the Postgres driver to
// work around composite-unique-index issues; see pkg/database/model.go).
func (d *DbTx) ConfigClear(sid uint64, key string) error {
	return d.db.Where("server_id = ? AND key = ?", sid, key).Delete(&Config{}).Error
}
