package database

import "database/sql"

// Message is a persisted text chat message.
//
// Messages are persisted per channel they were sent to (direct or via tree
// broadcast). Whisper / DMs (TextMessage.session) are NOT persisted.
type Message struct {
	// Covering index for the history pagination query:
	//   WHERE server_id=? AND channel_id=? AND id<? ORDER BY id DESC LIMIT ?
	ID        uint64 `gorm:"primaryKey;autoIncrement;index:messages_history,priority:3,sort:desc"`
	ServerID  int64  `gorm:"not null;index:messages_history,priority:1"`
	ChannelID int    `gorm:"not null;index:messages_history,priority:2"`

	// Sender's session at the time of sending. Transient, but useful for debugging.
	ActorSession uint32

	// Registered user id of the sender, if any. Null for anonymous / unregistered actors.
	ActorUserID sql.NullInt64

	// Snapshot of the sender's display name at send time.
	ActorName string

	// Message body (post-filter).
	Message string `gorm:"type:text"`

	// Unix timestamp in milliseconds.
	CreatedAtMs int64 `gorm:"not null;index:messages_created_at"`
}

func (Message) TableName() string {
	return "messages"
}

// MessageInsert persists a single chat message. Returns the auto-assigned ID.
func (d *DbTx) MessageInsert(
	serverID int64,
	channelID int,
	actorSession uint32,
	actorUserID sql.NullInt64,
	actorName string,
	body string,
	createdAtMs int64,
) (uint64, error) {
	m := Message{
		ServerID:     serverID,
		ChannelID:    channelID,
		ActorSession: actorSession,
		ActorUserID:  actorUserID,
		ActorName:    actorName,
		Message:      body,
		CreatedAtMs:  createdAtMs,
	}
	if err := d.db.Create(&m).Error; err != nil {
		return 0, err
	}
	return m.ID, nil
}

// MessageDeleteByChannel removes every persisted message for the given
// (server, channel) pair. Used as part of channel deletion so removing a
// text channel also clears its chat history rather than leaking orphaned
// rows that would never be readable again (no FK, no cascade — the
// Postgres driver runs with DisableForeignKeyConstraintWhenMigrating).
// No-op when there are no rows; safe to call for voice channels too
// (live-only chat means there's nothing persisted to delete).
func (d *DbTx) MessageDeleteByChannel(serverID int64, channelID int) error {
	return d.db.Where("server_id = ? AND channel_id = ?", serverID, channelID).Delete(&Message{}).Error
}

// ChannelMessageHistory returns up to `limit` persisted messages for a given
// channel, ordered newest-first. If `beforeID` is zero, the latest `limit`
// messages are returned. Otherwise messages with id < beforeID are returned.
//
// The returned `hasMore` flag indicates whether older messages exist beyond
// the returned page. It is computed by fetching one extra row (limit+1) and
// dropping it from the result.
func (d *DbTx) ChannelMessageHistory(
	serverID int64,
	channelID int,
	beforeID uint64,
	limit int,
) ([]Message, bool, error) {
	if limit <= 0 {
		return nil, false, nil
	}

	var msgs []Message
	q := d.db.Where("server_id = ? AND channel_id = ?", serverID, channelID)
	if beforeID > 0 {
		q = q.Where("id < ?", beforeID)
	}
	if err := q.Order("id DESC").Limit(limit + 1).Find(&msgs).Error; err != nil {
		return nil, false, err
	}

	hasMore := false
	if len(msgs) > limit {
		hasMore = true
		msgs = msgs[:limit]
	}
	return msgs, hasMore, nil
}
