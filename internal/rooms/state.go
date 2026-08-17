package rooms

import "math"

const (
	ScheduleLeadMs          int64 = 350
	HostDriftThresholdMs    int64 = 750
	HostDriftConfirmations        = 2
	HostAnchorMinIntervalMs int64 = 15000
)

type Phase string

const (
	PhaseNoMedia   Phase = "no_media"
	PhaseLoading   Phase = "loading"
	PhasePaused    Phase = "paused"
	PhasePlaying   Phase = "playing"
	PhaseBuffering Phase = "buffering"
	PhaseEnded     Phase = "ended"
)

type PlaybackState struct {
	MediaID            string  `json:"mediaId,omitempty"`
	Revision           int64   `json:"revision"`
	TimelineEpoch      int64   `json:"timelineEpoch"`
	Phase              Phase   `json:"phase"`
	AnchorPositionMs   int64   `json:"anchorPositionMs"`
	AnchorServerTimeMs int64   `json:"anchorServerTimeMs"`
	PlaybackRate       float64 `json:"playbackRate"`
	DurationMs         int64   `json:"durationMs,omitempty"`
	ResumeIntent       Phase   `json:"resumeIntent,omitempty"`
}

func (s PlaybackState) Expected(now int64) int64 {
	p := s.AnchorPositionMs
	if s.Phase == PhasePlaying && now > s.AnchorServerTimeMs {
		p += int64(float64(now-s.AnchorServerTimeMs) * s.PlaybackRate)
	}
	if p < 0 {
		return 0
	}
	if s.DurationMs > 0 && p > s.DurationMs {
		return s.DurationMs
	}
	return p
}
func validRate(v float64) bool {
	for _, x := range []float64{.5, .75, 1, 1.25, 1.5, 2} {
		if math.Abs(v-x) < .0001 {
			return true
		}
	}
	return false
}
