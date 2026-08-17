package rooms

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"movie-sync/internal/model"
)

type fakePersistence struct {
	mu          sync.Mutex
	checkpoints []model.Checkpoint
	members     []model.Member
	closedRooms int
	reopened    int
	statuses    []string
}

func (f *fakePersistence) SaveCheckpoint(_ context.Context, c model.Checkpoint) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.checkpoints = append(f.checkpoints, c)
	return nil
}
func (f *fakePersistence) Members(context.Context, string) ([]model.Member, error) {
	return f.members, nil
}
func (*fakePersistence) TransferHost(context.Context, string, string, string, int64) error {
	return nil
}
func (f *fakePersistence) CloseRoom(context.Context, string, int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closedRooms++
	return nil
}
func (f *fakePersistence) ReopenRoom(context.Context, string, int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reopened++
	return nil
}
func (*fakePersistence) SaveChat(context.Context, model.ChatMessage) error         { return nil }
func (*fakePersistence) LeaveMember(context.Context, string, string, int64) error  { return nil }
func (*fakePersistence) SetRoomMedia(context.Context, string, string, int64) error { return nil }
func (*fakePersistence) UpdateMediaMetadata(context.Context, string, int64, int, int, int64) error {
	return nil
}
func (*fakePersistence) DeleteGuestSession(context.Context, string, string) error { return nil }
func (f *fakePersistence) UpdateRoomStatus(_ context.Context, _ string, status string, _ int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statuses = append(f.statuses, status)
	return nil
}

type fakeClient struct {
	identity model.Identity
	out      chan Envelope
	closed   chan clientClose
}

type clientClose struct {
	code   int
	reason string
}

func (c *fakeClient) ID() string               { return c.identity.ID }
func (c *fakeClient) Identity() model.Identity { return c.identity }
func (c *fakeClient) Send(e Envelope) bool {
	select {
	case c.out <- e:
		return true
	default:
		return false
	}
}
func (c *fakeClient) Close(code int, reason string) {
	if c.closed == nil {
		return
	}
	select {
	case c.closed <- clientClose{code: code, reason: reason}:
	default:
	}
}
func payload(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func TestActorHostAuthorityAndRevision(t *testing.T) {
	p := &fakePersistence{}
	a := NewActor(model.Room{ID: "room", HostUserID: "host", Status: "OPEN", MaxMembers: 5}, nil, p, time.Hour)
	defer a.Stop()
	host := &fakeClient{identity: model.Identity{ID: "host", Nickname: "Host"}, out: make(chan Envelope, 20)}
	member := &fakeClient{identity: model.Identity{ID: "member", Nickname: "Member"}, out: make(chan Envelope, 20)}
	ctx := context.Background()
	if err := a.Join(ctx, host); err != nil {
		t.Fatal(err)
	}
	if err := a.Join(ctx, member); err != nil {
		t.Fatal(err)
	}
	state, err := a.Command(ctx, host.identity, Command{Type: "cmd.playback.play", Payload: payload(map[string]any{"positionMs": 1000})})
	if err != nil || state.Revision != 1 || state.Phase != PhasePlaying {
		t.Fatalf("play=%+v err=%v", state, err)
	}
	memberCommands := []string{
		"cmd.playback.play",
		"cmd.playback.pause",
		"cmd.playback.seek",
		"cmd.playback.rate",
		"cmd.room.media",
		"cmd.room.close",
		"cmd.room.kick",
		"cmd.room.transfer_host",
	}
	for _, command := range memberCommands {
		if _, commandErr := a.Command(ctx, member.identity, Command{Type: command, Payload: payload(map[string]any{
			"positionMs": 5000, "playbackRate": 1.25, "mediaId": "media", "targetUserId": "host",
		})}); commandErr != ErrNotHost {
			t.Errorf("member %s error=%v, want %v", command, commandErr, ErrNotHost)
		}
	}
	state, err = a.Command(ctx, host.identity, Command{Type: "cmd.playback.pause", Payload: payload(map[string]any{"positionMs": 1200})})
	if err != nil || state.Revision != 2 || state.AnchorPositionMs != 1200 {
		t.Fatalf("pause=%+v err=%v", state, err)
	}
}
func TestActorDropsStaleCapacityJoin(t *testing.T) {
	a := NewActor(model.Room{ID: "r", HostUserID: "h", Status: "OPEN", MaxMembers: 1}, nil, &fakePersistence{}, time.Hour)
	defer a.Stop()
	if err := a.Join(context.Background(), &fakeClient{identity: model.Identity{ID: "h"}, out: make(chan Envelope, 5)}); err != nil {
		t.Fatal(err)
	}
	if err := a.Join(context.Background(), &fakeClient{identity: model.Identity{ID: "m"}, out: make(chan Envelope, 5)}); err != ErrRoomFull {
		t.Fatalf("got %v", err)
	}
}

func TestActorMarksReplacedConnectionAsSuperseded(t *testing.T) {
	a := NewActor(model.Room{ID: "r", HostUserID: "h", Status: "OPEN", MaxMembers: 5}, nil, &fakePersistence{}, time.Hour)
	defer a.Stop()
	old := &fakeClient{
		identity: model.Identity{ID: "h"},
		out:      make(chan Envelope, 5),
		closed:   make(chan clientClose, 1),
	}
	current := &fakeClient{identity: model.Identity{ID: "h"}, out: make(chan Envelope, 5)}
	if err := a.Join(context.Background(), old); err != nil {
		t.Fatal(err)
	}
	if err := a.Join(context.Background(), current); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-old.closed:
		if got.code != StatusConnectionSuperseded || got.reason != "replaced by reconnect" {
			t.Fatalf("close=%+v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("old connection was not closed")
	}
}

func TestActorKeepsRoomRecoverableWhenHostGraceExpires(t *testing.T) {
	p := &fakePersistence{}
	a := NewActor(model.Room{ID: "r", HostUserID: "h", Status: "OPEN", MaxMembers: 5}, nil, p, 5*time.Millisecond)
	defer a.Stop()
	host := &fakeClient{identity: model.Identity{ID: "h"}, out: make(chan Envelope, 8)}
	if err := a.Join(context.Background(), host); err != nil {
		t.Fatal(err)
	}
	a.LeaveClient(host)

	deadline := time.Now().Add(time.Second)
	for {
		room := a.Snapshot(context.Background())["room"].(model.Room)
		if room.Status == "HOST_DISCONNECTED" && time.Now().After(deadline.Add(-900*time.Millisecond)) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("room status never settled at HOST_DISCONNECTED: %s", room.Status)
		}
		time.Sleep(5 * time.Millisecond)
	}
	p.mu.Lock()
	closedRooms := p.closedRooms
	p.mu.Unlock()
	if closedRooms != 0 {
		t.Fatalf("temporary host absence permanently closed %d rooms", closedRooms)
	}

	reconnected := &fakeClient{identity: model.Identity{ID: "h"}, out: make(chan Envelope, 8)}
	if err := a.Join(context.Background(), reconnected); err != nil {
		t.Fatal(err)
	}
	if got := a.Snapshot(context.Background())["room"].(model.Room).Status; got != "OPEN" {
		t.Fatalf("status after host reconnect=%s", got)
	}
}

func TestActorCanReopenExplicitlyClosedRoom(t *testing.T) {
	p := &fakePersistence{}
	closedAt := time.Now().UnixMilli()
	a := NewActor(model.Room{ID: "r", HostUserID: "h", Status: "CLOSED", MaxMembers: 5, ClosedAtMs: &closedAt}, nil, p, time.Hour)
	defer a.Stop()
	if err := a.Reopen(context.Background()); err != nil {
		t.Fatal(err)
	}
	room := a.Snapshot(context.Background())["room"].(model.Room)
	if room.Status != "HOST_DISCONNECTED" || room.ClosedAtMs != nil {
		t.Fatalf("reopened room=%+v", room)
	}
	p.mu.Lock()
	reopened := p.reopened
	p.mu.Unlock()
	if reopened != 1 {
		t.Fatalf("reopen persistence calls=%d", reopened)
	}
}
