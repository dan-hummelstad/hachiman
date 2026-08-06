package database

import "log"

type Server struct {
	ServerID uint64 `gorm:"primaryKey;autoIncrement"`

	// Server-level defaults for channel media configuration. Channels with
	// null HomeRegion / QualityProfileID inherit these. Set by the server-
	// create UI; admins can change them at runtime.
	//
	// DefaultHomeRegion is NOT NULL with an empty-string default — empty
	// means "no preference; Oracle's placement scorer picks". Freshly-
	// migrated rows land here automatically.
	//
	// DefaultQualityProfileID is nullable: until the seed runs there is no
	// profile to point at, so the FK has to allow null. Once seeded the
	// server-create path can stamp the Hachiman-Standard ID.
	DefaultHomeRegion       string `gorm:"not null;default:''"`
	DefaultQualityProfileID *uint
	DefaultQualityProfile   *QualityProfile `gorm:"foreignKey:DefaultQualityProfileID;references:ID;constraint:OnDelete:SET NULL"`
}

func (s Server) TableName() string {
	return "servers"
}

func (d *DbTx) ServerList(offset, limit int) ([]Server, error) {
	servers := make([]Server, 0)
	err := d.db.Limit(limit).Offset(offset).Find(&servers).Error
	return servers, err
}

func (d *DbTx) ServerAdd() (*Server, error) {
	var server Server
	// Stamp the seeded default quality profile FK so freshly-created vServers
	// have a real ladder/jitter target to inherit instead of nil (which the
	// channel-level resolver would have to fall through to a hardcoded
	// fallback). The seed runs in Init() so this lookup should always hit;
	// if it doesn't (race or out-of-band DB tampering) we log a warning and
	// proceed with a nil FK rather than failing server creation outright —
	// the channel-level resolver will still produce something sensible.
	profile, err := d.QualityProfileGetByName("Hachiman-Standard")
	if err != nil {
		log.Printf("ServerAdd: lookup Hachiman-Standard profile: %v (proceeding without default FK)", err)
	} else if profile == nil {
		log.Printf("ServerAdd: Hachiman-Standard profile not seeded (proceeding without default FK)")
	} else {
		id := profile.ID
		server.DefaultQualityProfileID = &id
	}
	if err := d.db.Create(&server).Error; err != nil {
		return nil, err
	}
	return &server, nil
}

func (d *DbTx) ServerExists(sid uint64) (bool, error) {
	var count int64
	err := d.db.Model(&Server{}).Where(&Server{ServerID: sid}).Count(&count).Error
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

func (d *DbTx) ServerDelete(sid uint64) error {
	return d.db.Delete(&Server{ServerID: sid}).Error
}

// ServerInit performs the idempotent bootstrap a vServer needs to be
// connectable end-to-end on a fresh install: root channel (ChannelID=0) and
// the "admin" group on the root channel. In self-host mode it additionally
// seeds a local "SuperUser" user account (UserID=0) and wires it into the
// admin group; in managed mode (isManaged=true) the SuperUser row + admin
// group membership are skipped — the only admin path is the Oracle owner
// grant in cmd/grumble/server.go (handleAuthenticate), which short-circuits
// ACLs via the side-channel `client.superUser` flag instead of carrying a
// real user id.
//
// The bool return reports whether this call had to *create* the SuperUser
// account (i.e. "is this server brand new and self-hosted?") — the caller
// uses that to decide whether to print the generated SuperUser password.
// In managed mode the return is always false (no password to print).
//
// Every step here is idempotent so re-running this on an already-initialised
// vServer is a safe no-op. Earlier behaviour returned isNew=false as soon as
// any single bootstrap row already existed, which left half-initialised
// servers in a permanently broken state (e.g. SuperUser row present but root
// channel missing => RootChannel() Fatalf on first client connect). The
// fail-safe in cmd/grumble.Server.RootChannel covers the worst case at
// runtime, but bootstrapping all rows here keeps the steady-state path
// untouched.
func (d *DbTx) ServerInit(sid uint64, suPassword UserPasswordHash, isManaged bool) (bool, error) {
	var isNew bool
	if !isManaged {
		suExisted, err := d.UserExists(sid, 0)
		if err != nil {
			return false, err
		}
		if !suExisted {
			if err := d.userInitSuperuser(sid, "SuperUser", suPassword); err != nil {
				return false, err
			}
			isNew = true
		}
	}

	// Root channel + admin group bootstrap in BOTH modes — the admin group
	// carries WritePermission on root via seedRootChannelACLs regardless of
	// whether anyone is currently a member, so leaving it intact keeps the
	// future "promote registered user X to admin" path open without a
	// migration. Managed mode just never adds the SuperUser member below.
	if _, err := d.channelInit(sid, "Root"); err != nil {
		return false, err
	}
	group, err := d.groupEnsure(sid, 0, "admin")
	if err != nil {
		return false, err
	}

	if !isManaged {
		// GroupMemberAdd is an UPSERT (OnConflict UpdateAll), safe to re-run.
		if err := d.GroupMemberAdd(sid, group.GroupID, 0, true); err != nil {
			return false, err
		}
	}

	return isNew, nil
}

// GroupEnsure returns the existing group with (sid, cid, name) if it exists,
// otherwise creates it. Idempotent counterpart to groupInit, which only
// creates a group when *no* group exists on the channel. Exported so callers
// outside the package can use it as a safety net (see
// cmd/grumble.Server.RootChannel).
func (d *DbTx) GroupEnsure(sid, cid uint64, name string) (*Group, error) {
	return d.groupEnsure(sid, cid, name)
}

func (d *DbTx) groupEnsure(sid, cid uint64, name string) (*Group, error) {
	var existing Group
	err := d.db.Where("server_id = ? AND channel_id = ? AND name = ?", sid, cid, name).
		Limit(1).Find(&existing).Error
	if err != nil {
		return nil, err
	}
	if existing.Name == name {
		return &existing, nil
	}
	return d.GroupAdd(sid, cid, name, true, true)
}
