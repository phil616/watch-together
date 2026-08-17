package rooms

import "testing"

func TestExpectedPosition(t *testing.T) {
	s := PlaybackState{Phase: PhasePlaying, AnchorPositionMs: 100000, AnchorServerTimeMs: 1000000, PlaybackRate: 1, DurationMs: 200000}
	if got := s.Expected(1005000); got != 105000 {
		t.Fatalf("got %d", got)
	}
	s.PlaybackRate = 1.5
	if got := s.Expected(1005000); got != 107500 {
		t.Fatalf("got %d", got)
	}
	s.Phase = PhasePaused
	if got := s.Expected(1005000); got != 100000 {
		t.Fatalf("paused advanced to %d", got)
	}
}

func TestHostAnchorRequiresSustainedHealthyDrift(t *testing.T) {
	a := &Actor{playback: PlaybackState{
		Phase:              PhasePlaying,
		AnchorPositionMs:   1000,
		AnchorServerTimeMs: 1000,
		PlaybackRate:       1,
	}}
	if a.acceptHostAnchorSample(2000, 3000, false, 4) {
		t.Fatal("one drift sample must not move the room anchor")
	}
	if a.playback.AnchorPositionMs != 1000 {
		t.Fatalf("anchor moved after one sample: %d", a.playback.AnchorPositionMs)
	}
	if !a.acceptHostAnchorSample(7000, 8000, false, 4) {
		t.Fatal("two same-direction healthy samples should refresh the anchor")
	}
	if a.playback.AnchorPositionMs != 8000 || a.playback.AnchorServerTimeMs != 7000 {
		t.Fatalf("unexpected refreshed anchor: %+v", a.playback)
	}
}

func TestHostAnchorRejectsJitterBufferingAndRapidRefresh(t *testing.T) {
	a := &Actor{playback: PlaybackState{
		Phase:              PhasePlaying,
		AnchorPositionMs:   0,
		AnchorServerTimeMs: 1000,
		PlaybackRate:       1,
	}}

	// Reversing drift is jitter, not evidence for a new anchor.
	a.acceptHostAnchorSample(2000, 3000, false, 4)
	if a.acceptHostAnchorSample(7000, 5000, false, 4) {
		t.Fatal("opposite drift samples must not refresh the anchor")
	}
	// A paused or under-buffered host is never a valid clock source.
	if a.acceptHostAnchorSample(12000, 14000, true, 4) ||
		a.acceptHostAnchorSample(17000, 19000, false, 2) {
		t.Fatal("unhealthy host samples must be ignored")
	}

	// Establish an update, then prove that another pair inside the minimum
	// interval cannot create a stream of room revisions.
	a.acceptHostAnchorSample(22000, 24000, false, 4)
	if !a.acceptHostAnchorSample(27000, 29000, false, 4) {
		t.Fatal("expected initial anchor refresh")
	}
	a.acceptHostAnchorSample(32000, 35000, false, 4)
	if a.acceptHostAnchorSample(37000, 40000, false, 4) {
		t.Fatal("anchor refresh must be rate limited")
	}
}
