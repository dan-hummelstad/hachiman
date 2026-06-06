package database

import "gorm.io/gorm/clause"

// GroupMember is a (server, group, user) tuple — there's at most one row per
// triple, which `group_member_uniq` enforces. The unique index serves both as
// the upsert conflict target (Postgres requires an explicit target on
// ON CONFLICT) AND as the natural-key guarantee — without it, repeated
// GroupMemberAdd calls would silently insert duplicates on SQLite and 42601
// on Postgres.
type GroupMember struct {
	ServerID uint64  `gorm:"not null;uniqueIndex:group_member_uniq;index:group_members_users"`
	Server   *Server `gorm:"constraint:OnDelete:CASCADE;"`

	GroupID uint64 `gorm:"not null;uniqueIndex:group_member_uniq"`
	Group   *Group `gorm:"foreignKey:ServerID,GroupID;references:ServerID,GroupID;constraint:OnDelete:CASCADE;"`
	UserID  uint64 `gorm:"not null;uniqueIndex:group_member_uniq;index:group_members_users"`
	User    *User  `gorm:"belongsTo;foreignKey:ServerID,UserID;references:ServerID,UserID;constraint:OnDelete:CASCADE;"`

	Addit bool // Member should be include or exclude for group
}

func (s GroupMember) TableName() string {
	return "group_members"
}

func (d *DbTx) GroupMemberList(sid, gid uint64) ([]GroupMember, error) {
	var members []GroupMember
	err := d.db.Find(&members, "server_id = ? AND group_id = ?", sid, gid).Error
	if err != nil {
		return nil, err
	}
	return members, nil
}

func (d *DbTx) GroupMemberAdd(sid, gid, uid uint64, addit bool) error {
	return d.db.Clauses(clause.OnConflict{
		// Postgres requires the conflict target on UPSERT; SQLite is lenient.
		// Matches the `group_member_uniq` index defined on the model.
		Columns:   []clause.Column{{Name: "server_id"}, {Name: "group_id"}, {Name: "user_id"}},
		UpdateAll: true,
	}).Create(&GroupMember{ServerID: sid, GroupID: gid, UserID: uid, Addit: addit}).Error
}

func (d *DbTx) GroupMemberRemove(sid, gid, uid uint64) error {
	return d.db.Delete(&GroupMember{}, "server_id = ? AND group_id = ? AND user_id = ?", sid, gid, uid).Error
}

func (d *DbTx) GroupMemberRemoveAll(sid, gid uint64) error {
	return d.db.Delete(&GroupMember{}, "server_id = ? AND group_id = ?", sid, gid).Error
}
