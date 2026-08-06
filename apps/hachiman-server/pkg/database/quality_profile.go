package database

import (
	"encoding/json"
	"errors"

	"gorm.io/gorm"
)

// QualityProfile is a server-side codec / simulcast ladder / jitter
// configuration record. Per the migration plan's "Quality profiles live in
// hachiman-control's DB" decision, this is application-layer config consumed
// at voice-token mint time and embedded in the client-facing QualityProfile
// mumble message + the sidechannel QualityProfileApplied envelope.
//
// The shape is intentionally narrow at phase 1:
//   - `Name` is a stable identifier ("Hachiman-Standard").
//   - `Codec` is the primary screen-share codec ("av1", "vp9", ...).
//   - `Ladder` is the simulcast ladder descriptor — JSON-serialized into a
//     TEXT column so this row stays portable across SQLite and Postgres
//     without needing native jsonb on the SQLite side.
//   - `Jitter` is the jitter-buffer target spec — same TEXT-encoded JSON shape.
//
// Channels point at a profile via `channels.quality_profile_id` (nullable —
// channel inherits from server default when null) and servers point at a
// default via `servers.default_quality_profile_id`. The two-layer inheritance
// is resolved at app-layer; the DB just holds the FK.
type QualityProfile struct {
	ID uint `gorm:"primaryKey;autoIncrement"`
	// Stable identifier — the migration plan calls out "Hachiman-Standard" as
	// the seeded default. Unique so seed idempotency can rely on (Name) for the
	// "already there?" check.
	Name string `gorm:"not null;uniqueIndex"`
	// Primary codec used by clients honoring this profile. Phase 1 seed
	// inserts "av1" — VP9 is the fallback negotiated by the client when AV1
	// hardware decode is missing.
	Codec string `gorm:"not null"`
	// JSON-serialized simulcast layer descriptors. Phase 1 default is the
	// 1080p60 / 720p30 / 480p15 ladder per the Quality Targets section. Stored
	// as TEXT so SQLite and Postgres both serve it without driver tricks.
	Ladder string `gorm:"type:text;not null"`
	// JSON-serialized jitter targets (p50_ms / p95_ms / p99_ms). Same TEXT
	// rationale as Ladder.
	Jitter string `gorm:"type:text;not null"`
}

func (QualityProfile) TableName() string {
	return "quality_profiles"
}

// QualityProfileLayer is the wire shape encoded into `quality_profiles.ladder`.
// Keeping the type alongside the model lets callers Marshal/Unmarshal without
// reinventing the schema. Phase 1 ladder entries are pure descriptors — bitrate
// caps live on the client-side encoder config.
type QualityProfileLayer struct {
	Name   string `json:"name"`
	Width  uint32 `json:"width"`
	Height uint32 `json:"height"`
	FPS    uint32 `json:"fps"`
}

// QualityProfileJitter is the wire shape encoded into `quality_profiles.jitter`.
// Mirrors the voice-quality targets in MEDIA-PLANE-MIGRATION.md ("p50 ≤ 80 ms,
// p95 ≤ 120 ms intra-region"). Phase 1 seeds {40, 80, 120}.
type QualityProfileJitter struct {
	P50Ms uint32 `json:"p50_ms"`
	P95Ms uint32 `json:"p95_ms"`
	P99Ms uint32 `json:"p99_ms"`
}

// QualityProfileAdd inserts a new profile and returns its assigned ID.
func (d *DbTx) QualityProfileAdd(name, codec string, ladder []QualityProfileLayer, jitter QualityProfileJitter) (*QualityProfile, error) {
	ladderJSON, err := json.Marshal(ladder)
	if err != nil {
		return nil, err
	}
	jitterJSON, err := json.Marshal(jitter)
	if err != nil {
		return nil, err
	}
	p := QualityProfile{
		Name:   name,
		Codec:  codec,
		Ladder: string(ladderJSON),
		Jitter: string(jitterJSON),
	}
	if err := d.db.Create(&p).Error; err != nil {
		return nil, err
	}
	return &p, nil
}

// QualityProfileGetByName returns the profile with the given Name, or nil when
// no row matches. Errors propagate; "not found" is the (nil, nil) return.
func (d *DbTx) QualityProfileGetByName(name string) (*QualityProfile, error) {
	var p QualityProfile
	err := d.db.Where("name = ?", name).First(&p).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &p, nil
}

// QualityProfileCountByName returns the number of profile rows with the given
// Name. Test-facing helper used to assert seed idempotency directly (the
// unique index prevents duplicates, but COUNT proves the seeded row is alone).
func (d *DbTx) QualityProfileCountByName(name string) (int64, error) {
	var count int64
	err := d.db.Model(&QualityProfile{}).Where("name = ?", name).Count(&count).Error
	return count, err
}

// QualityProfileGet returns the profile with the given ID, or nil when no
// row matches.
func (d *DbTx) QualityProfileGet(id uint) (*QualityProfile, error) {
	var p QualityProfile
	err := d.db.First(&p, id).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &p, nil
}

// SeedDefaultQualityProfile inserts the "Hachiman-Standard" profile when it
// doesn't already exist. Idempotent — re-running on a populated DB is a no-op
// (the unique index on Name guards against duplicates even if two callers race).
// Returns the existing or newly-inserted profile.
//
// The seed values match the Quality Targets section in MEDIA-PLANE-MIGRATION.md:
//   - codec: AV1 (clients fall back to VP9 when AV1 hardware decode is missing)
//   - ladder: 1080p60 / 720p30 / 480p15
//   - jitter: p50=40ms, p95=80ms, p99=120ms (intra-region voice SLO)
func (d *DbTx) SeedDefaultQualityProfile() (*QualityProfile, error) {
	existing, err := d.QualityProfileGetByName("Hachiman-Standard")
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return existing, nil
	}
	ladder := []QualityProfileLayer{
		{Name: "1080p60", Width: 1920, Height: 1080, FPS: 60},
		{Name: "720p30", Width: 1280, Height: 720, FPS: 30},
		{Name: "480p15", Width: 854, Height: 480, FPS: 15},
	}
	jitter := QualityProfileJitter{P50Ms: 40, P95Ms: 80, P99Ms: 120}
	return d.QualityProfileAdd("Hachiman-Standard", "av1", ladder, jitter)
}
