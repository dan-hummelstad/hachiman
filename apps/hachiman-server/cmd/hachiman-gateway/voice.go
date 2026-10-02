// Copyright (c) 2026 The Hachiman Authors
// The use of this source code is governed by a BSD-style
// license that can be found in the LICENSE-file.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"hachiman/server/pkg/coturn"
	"hachiman/server/pkg/management"
	"hachiman/server/pkg/permissions"
	"hachiman/server/pkg/voicetoken"
)

type voiceRequest struct {
	GuildID    string  `json:"guildId"`
	ChannelID  *string `json:"channelId"`
	SelfMute   bool    `json:"selfMute"`
	SelfDeaf   bool    `json:"selfDeaf"`
	SelfStream bool    `json:"selfStream"`
}

var stunOnly = []coturn.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}}

// onVoice implements contract §6 "Voice join". One voice session per user
// globally: voice_user:{uid} names the guild, voice:{g}[uid] holds the state.
func (s *session) onVoice(ctx context.Context, req voiceRequest) error {
	if req.ChannelID == nil {
		s.leaveVoice(ctx)
		return nil
	}
	chID, me := *req.ChannelID, s.user.ID
	gs := s.guilds[req.GuildID]
	if gs == nil {
		return fmt.Errorf("not a member of guild %s", req.GuildID)
	}
	ch := gs.channels[chID]
	if ch == nil || ch.Type != "voice" {
		return fmt.Errorf("%s is not a voice channel", chID)
	}
	if !permissions.Has(gs.perms(me, ch), permissions.Connect|permissions.ViewChannel) {
		return fmt.Errorf("missing CONNECT on %s", chID)
	}

	prev := s.g.currentVoice(ctx, me)
	if prev != nil && prev.GuildID != req.GuildID {
		s.g.removeVoice(ctx, *prev)
		prev = nil
	}
	st := VoiceState{GuildID: req.GuildID, ChannelID: &chID, UserID: me, SessionID: s.id, SelfMute: req.SelfMute, SelfDeaf: req.SelfDeaf, SelfStream: req.SelfStream}
	if _, err := s.g.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, kVoice(req.GuildID), me, string(mustJSON(st)))
		p.Set(ctx, kVoiceUser(me), req.GuildID, 0)
		return nil
	}); err != nil {
		return err
	}
	s.voice = &st
	s.g.publish(ctx, "guild:"+req.GuildID, "VOICE_STATE_UPDATE", st)

	moved := prev == nil || prev.SessionID != s.id || prev.ChannelID == nil || *prev.ChannelID != chID
	if !moved {
		return nil // mute/deaf/stream toggle: media connection stays as is
	}
	nodeID, endpoint, err := s.g.resolveNode(ctx, chID, req.GuildID, gs.region)
	if err != nil {
		return fmt.Errorf("place media session: %w", err)
	}
	if prev != nil && prev.ChannelID != nil {
		// Same guild, other channel or other device. A same-session move on
		// the same node needs no kick: media replaces by sessionId (4011).
		if prevNode, _ := s.g.rdb.Get(ctx, kVoiceRoom(*prev.ChannelID)).Result(); prev.SessionID != s.id || prevNode != nodeID {
			s.g.kick(ctx, prevNode, prev.SessionID, *prev.ChannelID)
		}
		s.g.releaseRoomIfEmpty(ctx, prev.GuildID, *prev.ChannelID)
	}

	now := time.Now()
	claims := voicetoken.Claims{
		SessionID: s.id, UserID: me, GuildID: req.GuildID, ChannelID: chID, MediaNodeID: nodeID,
		IssuedAt: now, ExpiresAt: now.Add(voicetoken.DefaultTTL),
	}
	token, err := s.g.signer.Mint(claims)
	if err != nil {
		return err
	}
	ice := stunOnly
	if s.g.turn != nil {
		ice = s.g.turn.Mint(me, now)
	}
	s.dispatch("VOICE_SERVER_UPDATE", map[string]any{
		"guildId": req.GuildID, "channelId": chID, "endpoint": endpoint, "token": token,
		"iceServers": ice, "expiresAt": iso(claims.ExpiresAt),
	})
	return nil
}

// leaveVoice drops this session's voice state. Another device's voice
// session for the same user is left alone.
func (s *session) leaveVoice(ctx context.Context) {
	s.voice = nil
	cur := s.g.currentVoice(ctx, s.user.ID)
	if cur == nil || cur.SessionID != s.id {
		return
	}
	s.g.rdb.Del(ctx, kVoiceUser(s.user.ID))
	s.g.removeVoice(ctx, *cur)
}

// restoreVoice re-adopts a voice state this session id held before RESUME.
func (s *session) restoreVoice(ctx context.Context) {
	if cur := s.g.currentVoice(ctx, s.user.ID); cur != nil && cur.SessionID == s.id {
		s.voice = cur
	}
}

func (g *Gateway) currentVoice(ctx context.Context, userID string) *VoiceState {
	gid, err := g.rdb.Get(ctx, kVoiceUser(userID)).Result()
	if err != nil {
		return nil
	}
	raw, err := g.rdb.HGet(ctx, kVoice(gid), userID).Result()
	if err != nil {
		return nil
	}
	var vs VoiceState
	if json.Unmarshal([]byte(raw), &vs) != nil {
		return nil
	}
	return &vs
}

// removeVoice deletes st, announces the leave and kicks the media session.
func (g *Gateway) removeVoice(ctx context.Context, st VoiceState) {
	g.rdb.HDel(ctx, kVoice(st.GuildID), st.UserID)
	left := st
	left.ChannelID = nil
	g.publish(ctx, "guild:"+st.GuildID, "VOICE_STATE_UPDATE", left)
	if st.ChannelID != nil {
		node, _ := g.rdb.Get(ctx, kVoiceRoom(*st.ChannelID)).Result()
		g.kick(ctx, node, st.SessionID, *st.ChannelID)
		g.releaseRoomIfEmpty(ctx, st.GuildID, *st.ChannelID)
	}
}

// kick names the channel being left so media can ignore it when the same
// session already reconnected into another channel on that node.
func (g *Gateway) kick(ctx context.Context, nodeID, sessionID, channelID string) {
	if nodeID == "" {
		return
	}
	b, _ := json.Marshal(map[string]string{"op": "kick", "sessionId": sessionID, "channelId": channelID})
	g.rdb.Publish(ctx, "media:"+nodeID, b)
}

// releaseRoomIfEmpty drops the sticky node once nobody is left in the channel.
// ponytail: check-then-DEL races a concurrent join; the joiner then gets
// re-placed, possibly on another node than a peer who joined a moment earlier.
func (g *Gateway) releaseRoomIfEmpty(ctx context.Context, guildID, channelID string) {
	vals, err := g.rdb.HVals(ctx, kVoice(guildID)).Result()
	if err != nil {
		return
	}
	for _, raw := range vals {
		var vs VoiceState
		if json.Unmarshal([]byte(raw), &vs) == nil && vs.ChannelID != nil && *vs.ChannelID == channelID {
			return
		}
	}
	g.rdb.Del(ctx, kVoiceRoom(channelID))
}

// resolveNode returns the media node hosting channelID, placing it via
// Takusen on first use. voice_room is the only stickiness: Takusen's placement
// just picks the least-loaded node, so SET NX decides races between gateways.
func (g *Gateway) resolveNode(ctx context.Context, channelID, guildID, region string) (nodeID, endpoint string, err error) {
	for attempt := 0; attempt < 2; attempt++ {
		nodeID, err = g.rdb.Get(ctx, kVoiceRoom(channelID)).Result()
		if errors.Is(err, redis.Nil) {
			res, perr := g.placer.PlaceMediaSession(ctx, &management.PlaceMediaSessionRequest{
				ChannelId: channelID, GuildId: guildID, HomeRegion: region,
			})
			if perr != nil {
				return "", "", perr
			}
			won, serr := g.rdb.SetNX(ctx, kVoiceRoom(channelID), res.NodeId, voiceRoomEX).Result()
			if serr != nil {
				return "", "", serr
			}
			if won {
				return res.NodeId, res.SignalingUrl, nil
			}
			continue // another gateway placed it first; use theirs
		}
		if err != nil {
			return "", "", err
		}
		endpoint, err = g.nodeURL(ctx, nodeID)
		if errors.Is(err, errNodeGone) {
			// Sticky entry outlived its node: forget it and place afresh.
			g.rdb.Del(ctx, kVoiceRoom(channelID))
			continue
		}
		return nodeID, endpoint, err
	}
	return "", "", fmt.Errorf("could not settle a media node for %s", channelID)
}
