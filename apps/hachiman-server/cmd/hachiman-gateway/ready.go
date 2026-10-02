// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"hachiman/server/pkg/permissions"
)

// Entity shapes, contract §1. JSON is camelCase on every boundary.

type User struct {
	ID       string  `json:"id"`
	Username string  `json:"username"`
	Avatar   *string `json:"avatar"`
}

type Guild struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Icon      *string `json:"icon"`
	Banner    *string `json:"banner"`
	OwnerID   string  `json:"ownerId"`
	Region    *string `json:"region"`
	CreatedAt string  `json:"createdAt"`
}

type Role struct {
	ID          string `json:"id"`
	GuildID     string `json:"guildId"`
	Name        string `json:"name"`
	Color       int    `json:"color"`
	Position    int    `json:"position"`
	Permissions int64  `json:"permissions"`
}

type Channel struct {
	ID                   string                  `json:"id"`
	GuildID              *string                 `json:"guildId"`
	Type                 string                  `json:"type"`
	Name                 *string                 `json:"name"`
	Topic                *string                 `json:"topic"`
	ParentID             *string                 `json:"parentId"`
	Position             int                     `json:"position"`
	PermissionOverwrites []permissions.Overwrite `json:"permissionOverwrites"`
	Recipients           []User                  `json:"recipients,omitempty"`
	OwnerID              *string                 `json:"ownerId,omitempty"`
}

type Member struct {
	GuildID  string   `json:"guildId"`
	User     User     `json:"user"`
	Nick     *string  `json:"nick"`
	Roles    []string `json:"roles"`
	JoinedAt string   `json:"joinedAt"`
}

type Presence struct {
	UserID string `json:"userId"`
	Status string `json:"status"`
}

type VoiceState struct {
	GuildID    string  `json:"guildId"`
	ChannelID  *string `json:"channelId"`
	UserID     string  `json:"userId"`
	SessionID  string  `json:"sessionId"`
	SelfMute   bool    `json:"selfMute"`
	SelfDeaf   bool    `json:"selfDeaf"`
	SelfStream bool    `json:"selfStream"`
}

type GuildFull struct {
	Guild
	Channels    []Channel    `json:"channels"`
	Roles       []Role       `json:"roles"`
	Members     []Member     `json:"members"`
	VoiceStates []VoiceState `json:"voiceStates"`
	Presences   []Presence   `json:"presences"`
}

// readyData is what Postgres knows about a user. Guild channels are ALL of
// them (not just visible ones): the session needs hidden channels to emit
// CHANNEL_CREATE when a permission change reveals one.
type readyData struct {
	Guilds []*GuildFull
	DMs    []Channel
}

// usernameSQL implements contract §1: displayName ?? name ?? email local part.
const usernameSQL = `COALESCE(NULLIF(u.display_name, ''), NULLIF(u.name, ''), split_part(u.email, '@', 1))`

func iso(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// pgLoader loads a user's guilds (all memberships, or just onlyGuild) and,
// for a full load, their DM channels.
func pgLoader(db *pgxpool.Pool) func(ctx context.Context, userID, onlyGuild string) (*readyData, error) {
	return func(ctx context.Context, userID, onlyGuild string) (*readyData, error) {
		out := &readyData{}
		byID := map[string]*GuildFull{}
		var ids []string

		rows, _ := db.Query(ctx, `
			SELECT g.id::text, g.name, g.icon, g.banner, g.owner_id::text, g.region, g.created_at
			FROM guilds g JOIN guild_members m ON m.guild_id = g.id
			WHERE m.user_id = $1::uuid AND ($2 = '' OR g.id::text = $2)`, userID, onlyGuild)
		if err := forEach(rows, func() error {
			gf := &GuildFull{Channels: []Channel{}, Roles: []Role{}, Members: []Member{}}
			var created time.Time
			if err := rows.Scan(&gf.ID, &gf.Name, &gf.Icon, &gf.Banner, &gf.OwnerID, &gf.Region, &created); err != nil {
				return err
			}
			gf.CreatedAt = iso(created)
			byID[gf.ID] = gf
			ids = append(ids, gf.ID)
			out.Guilds = append(out.Guilds, gf)
			return nil
		}); err != nil {
			return nil, fmt.Errorf("guilds: %w", err)
		}

		if len(ids) > 0 {
			rows, _ = db.Query(ctx, `
				SELECT id::text, guild_id::text, name, color, position, permissions
				FROM roles WHERE guild_id = ANY($1::uuid[]) ORDER BY position`, ids)
			if err := forEach(rows, func() error {
				var r Role
				if err := rows.Scan(&r.ID, &r.GuildID, &r.Name, &r.Color, &r.Position, &r.Permissions); err != nil {
					return err
				}
				byID[r.GuildID].Roles = append(byID[r.GuildID].Roles, r)
				return nil
			}); err != nil {
				return nil, fmt.Errorf("roles: %w", err)
			}

			chans := map[string]*Channel{}
			var order []*Channel
			rows, _ = db.Query(ctx, `
				SELECT id::text, guild_id::text, type::text, name, topic, parent_id::text, position
				FROM channels WHERE guild_id = ANY($1::uuid[]) ORDER BY position, created_at`, ids)
			if err := forEach(rows, func() error {
				c := &Channel{PermissionOverwrites: []permissions.Overwrite{}}
				if err := rows.Scan(&c.ID, &c.GuildID, &c.Type, &c.Name, &c.Topic, &c.ParentID, &c.Position); err != nil {
					return err
				}
				chans[c.ID] = c
				order = append(order, c)
				return nil
			}); err != nil {
				return nil, fmt.Errorf("channels: %w", err)
			}
			rows, _ = db.Query(ctx, `
				SELECT o.channel_id::text, o.target_id::text, o.target_type::text, o.allow, o.deny
				FROM permission_overwrites o JOIN channels c ON c.id = o.channel_id
				WHERE c.guild_id = ANY($1::uuid[])`, ids)
			if err := forEach(rows, func() error {
				var chID string
				var o permissions.Overwrite
				if err := rows.Scan(&chID, &o.ID, &o.Type, &o.Allow, &o.Deny); err != nil {
					return err
				}
				if c := chans[chID]; c != nil {
					c.PermissionOverwrites = append(c.PermissionOverwrites, o)
				}
				return nil
			}); err != nil {
				return nil, fmt.Errorf("overwrites: %w", err)
			}
			for _, c := range order {
				byID[*c.GuildID].Channels = append(byID[*c.GuildID].Channels, *c)
			}

			rows, _ = db.Query(ctx, `
				SELECT m.guild_id::text, m.nick, m.joined_at, u.id::text, `+usernameSQL+`, u.image,
				       COALESCE(array_agg(mr.role_id::text) FILTER (WHERE mr.role_id IS NOT NULL), '{}')
				FROM guild_members m
				JOIN users u ON u.id = m.user_id
				LEFT JOIN member_roles mr ON mr.guild_id = m.guild_id AND mr.user_id = m.user_id
				WHERE m.guild_id = ANY($1::uuid[])
				GROUP BY m.guild_id, m.user_id, m.nick, m.joined_at, u.id`, ids)
			if err := forEach(rows, func() error {
				var m Member
				var joined time.Time
				if err := rows.Scan(&m.GuildID, &m.Nick, &joined, &m.User.ID, &m.User.Username, &m.User.Avatar, &m.Roles); err != nil {
					return err
				}
				m.JoinedAt = iso(joined)
				byID[m.GuildID].Members = append(byID[m.GuildID].Members, m)
				return nil
			}); err != nil {
				return nil, fmt.Errorf("members: %w", err)
			}
		}

		if onlyGuild != "" {
			return out, nil
		}

		dms := map[string]*Channel{}
		var dmIDs []string
		rows, _ = db.Query(ctx, `
			SELECT c.id::text, c.type::text, c.name, c.topic, c.owner_id::text
			FROM channels c JOIN dm_participants p ON p.channel_id = c.id
			WHERE p.user_id = $1::uuid ORDER BY c.created_at`, userID)
		if err := forEach(rows, func() error {
			c := &Channel{PermissionOverwrites: []permissions.Overwrite{}, Recipients: []User{}}
			if err := rows.Scan(&c.ID, &c.Type, &c.Name, &c.Topic, &c.OwnerID); err != nil {
				return err
			}
			dms[c.ID] = c
			dmIDs = append(dmIDs, c.ID)
			return nil
		}); err != nil {
			return nil, fmt.Errorf("dm channels: %w", err)
		}
		if len(dmIDs) > 0 {
			rows, _ = db.Query(ctx, `
				SELECT p.channel_id::text, u.id::text, `+usernameSQL+`, u.image
				FROM dm_participants p JOIN users u ON u.id = p.user_id
				WHERE p.channel_id = ANY($1::uuid[]) AND p.user_id <> $2::uuid`, dmIDs, userID)
			if err := forEach(rows, func() error {
				var chID string
				var u User
				if err := rows.Scan(&chID, &u.ID, &u.Username, &u.Avatar); err != nil {
					return err
				}
				dms[chID].Recipients = append(dms[chID].Recipients, u)
				return nil
			}); err != nil {
				return nil, fmt.Errorf("dm recipients: %w", err)
			}
		}
		for _, id := range dmIDs {
			out.DMs = append(out.DMs, *dms[id])
		}
		return out, nil
	}
}

// pgNodeURL resolves a media node id (from sticky voice_room) to its
// signaling URL. The media_nodes table is Takusen's; we only read it.
func pgNodeURL(db *pgxpool.Pool) func(ctx context.Context, nodeID string) (string, error) {
	return func(ctx context.Context, nodeID string) (string, error) {
		var url string
		err := db.QueryRow(ctx, `SELECT signaling_url FROM media_nodes WHERE node_id = $1`, nodeID).Scan(&url)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", errNodeGone
		}
		return url, err
	}
}

var errNodeGone = errors.New("media node not registered")

// deviceRow is the part of a devices row that the IDENTIFY check needs (§12.13).
type deviceRow struct {
	UserID string
	Status string // pending | active | revoked
}

var errNoDevice = errors.New("device not found")

// pgDevice reads one devices row. The table is Takusen's; we only read it.
// Callers pass a parsed UUID, so the cast cannot fail.
func pgDevice(db *pgxpool.Pool) func(ctx context.Context, deviceID string) (deviceRow, error) {
	return func(ctx context.Context, deviceID string) (deviceRow, error) {
		var d deviceRow
		err := db.QueryRow(ctx, `SELECT user_id::text, status::text FROM devices WHERE id = $1::uuid`, deviceID).Scan(&d.UserID, &d.Status)
		if errors.Is(err, pgx.ErrNoRows) {
			return d, errNoDevice
		}
		return d, err
	}
}

// forEach drains rows, surfacing both query and scan errors. Query errors
// are deferred into rows.Err(), so callers can ignore Query's error return.
func forEach(rows pgx.Rows, fn func() error) error {
	defer rows.Close()
	for rows.Next() {
		if err := fn(); err != nil {
			return err
		}
	}
	return rows.Err()
}
