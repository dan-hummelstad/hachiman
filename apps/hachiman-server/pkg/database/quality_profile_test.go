package database_test

import (
	"encoding/json"
	"testing"

	"mumble.info/grumble/pkg/database"
)

// TestQualityProfile_AddAndLookup covers the basic create / fetch round-trip.
func TestQualityProfile_AddAndLookup(t *testing.T) {
	db, err := NewTestDB()
	if err != nil {
		t.Fatal(err)
	}

	tx := db.Tx()
	defer tx.Rollback()

	ladder := []database.QualityProfileLayer{
		{Name: "1080p60", Width: 1920, Height: 1080, FPS: 60},
		{Name: "720p30", Width: 1280, Height: 720, FPS: 30},
	}
	jitter := database.QualityProfileJitter{P50Ms: 30, P95Ms: 60, P99Ms: 100}

	created, err := tx.QualityProfileAdd("Test-Profile", "av1", ladder, jitter)
	if err != nil {
		t.Fatalf("QualityProfileAdd: %v", err)
	}
	if created.ID == 0 {
		t.Fatal("created profile has zero ID")
	}

	got, err := tx.QualityProfileGetByName("Test-Profile")
	if err != nil {
		t.Fatalf("QualityProfileGetByName: %v", err)
	}
	if got == nil {
		t.Fatal("profile not found after add")
	}
	if got.ID != created.ID {
		t.Errorf("ID mismatch: got %d, want %d", got.ID, created.ID)
	}
	if got.Codec != "av1" {
		t.Errorf("codec: got %q, want %q", got.Codec, "av1")
	}

	var gotLadder []database.QualityProfileLayer
	if err := json.Unmarshal([]byte(got.Ladder), &gotLadder); err != nil {
		t.Fatalf("ladder json: %v", err)
	}
	if len(gotLadder) != 2 || gotLadder[0].Name != "1080p60" {
		t.Errorf("ladder roundtrip: got %+v", gotLadder)
	}

	var gotJitter database.QualityProfileJitter
	if err := json.Unmarshal([]byte(got.Jitter), &gotJitter); err != nil {
		t.Fatalf("jitter json: %v", err)
	}
	if gotJitter != jitter {
		t.Errorf("jitter roundtrip: got %+v, want %+v", gotJitter, jitter)
	}

	// Lookup by ID.
	byID, err := tx.QualityProfileGet(created.ID)
	if err != nil {
		t.Fatalf("QualityProfileGet by id: %v", err)
	}
	if byID == nil || byID.Name != "Test-Profile" {
		t.Errorf("get by id: got %+v", byID)
	}

	// Missing name returns (nil, nil).
	missing, err := tx.QualityProfileGetByName("does-not-exist")
	if err != nil {
		t.Fatalf("QualityProfileGetByName (missing): %v", err)
	}
	if missing != nil {
		t.Errorf("expected nil for missing name, got %+v", missing)
	}
}

// TestQualityProfile_SeedIdempotent locks in the requirement that running the
// seed twice does NOT create a duplicate row.
func TestQualityProfile_SeedIdempotent(t *testing.T) {
	db, err := NewTestDB()
	if err != nil {
		t.Fatal(err)
	}

	// First seed call — Init() already ran one as part of NewTestDB() above
	// (the SeedDefaultQualityProfile call lives inside Init()), so the row
	// should already be present here.
	tx := db.Tx()
	defer tx.Rollback()

	first, err := tx.QualityProfileGetByName("Hachiman-Standard")
	if err != nil {
		t.Fatalf("look up seeded profile: %v", err)
	}
	if first == nil {
		t.Fatal("Init() did not seed Hachiman-Standard")
	}

	// Re-seed explicitly — should return the same row, not insert a duplicate.
	// Running it twice more pushes harder on the idempotency contract.
	for i := 0; i < 2; i++ {
		again, err := tx.SeedDefaultQualityProfile()
		if err != nil {
			t.Fatalf("SeedDefaultQualityProfile (re-run %d): %v", i, err)
		}
		if again.ID != first.ID {
			t.Errorf("seed returned different ID on re-run %d: first=%d again=%d", i, first.ID, again.ID)
		}
	}

	// Direct COUNT assertion: exactly one "Hachiman-Standard" row exists
	// after the re-seeds. Catches a regression where idempotency moved from
	// the unique index to the row-existence check — if the existence check
	// regressed (e.g. nil-check inverted) the unique index would surface a
	// duplicate-insert error in the loop above, but a missing existence check
	// combined with a relaxed index would silently double-seed. COUNT closes
	// that loophole.
	count, err := tx.QualityProfileCountByName("Hachiman-Standard")
	if err != nil {
		t.Fatalf("count Hachiman-Standard rows: %v", err)
	}
	if count != 1 {
		t.Errorf("expected exactly 1 Hachiman-Standard row, got %d", count)
	}

	// Verify the seeded contents match the spec values.
	var ladder []database.QualityProfileLayer
	if err := json.Unmarshal([]byte(first.Ladder), &ladder); err != nil {
		t.Fatalf("seeded ladder json: %v", err)
	}
	if len(ladder) != 3 {
		t.Errorf("seeded ladder length: got %d, want 3 (1080p60/720p30/480p15)", len(ladder))
	}
	if first.Codec != "av1" {
		t.Errorf("seeded codec: got %q, want %q", first.Codec, "av1")
	}

	var jitter database.QualityProfileJitter
	if err := json.Unmarshal([]byte(first.Jitter), &jitter); err != nil {
		t.Fatalf("seeded jitter json: %v", err)
	}
	if jitter.P50Ms == 0 || jitter.P95Ms == 0 || jitter.P99Ms == 0 {
		t.Errorf("seeded jitter has zero fields: %+v", jitter)
	}
}
