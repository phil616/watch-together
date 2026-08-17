package rooms

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"movie-sync/internal/model"
	"movie-sync/internal/repository"
)

var (
	ErrNotHost         = errors.New("NOT_HOST")
	ErrRoomClosed      = errors.New("ROOM_CLOSED")
	ErrRoomFull        = errors.New("ROOM_FULL")
	ErrInvalidCommand  = errors.New("INVALID_COMMAND")
	ErrInvalidPosition = errors.New("INVALID_POSITION")
	ErrNotMember       = errors.New("FORBIDDEN")
)

// StatusConnectionSuperseded tells an older client that another connection
// for the same identity has taken ownership of the room session. It must not
// automatically reconnect, otherwise the two clients continuously replace
// each other.
const StatusConnectionSuperseded = 4001

type Envelope struct {
	V            int    `json:"v"`
	Type         string `json:"type"`
	RequestID    string `json:"requestId,omitempty"`
	RoomID       string `json:"roomId,omitempty"`
	Revision     int64  `json:"revision,omitempty"`
	ServerTimeMs int64  `json:"serverTimeMs,omitempty"`
	Payload      any    `json:"payload,omitempty"`
}
type Command struct {
	Type, RequestID string
	Payload         json.RawMessage
}
type Client interface {
	ID() string
	Identity() model.Identity
	Send(Envelope) bool
	Close(code int, reason string)
}
type Persistence interface {
	SaveCheckpoint(context.Context, model.Checkpoint) error
	Members(context.Context, string) ([]model.Member, error)
	TransferHost(context.Context, string, string, string, int64) error
	CloseRoom(context.Context, string, int64) error
	ReopenRoom(context.Context, string, int64) error
	SaveChat(context.Context, model.ChatMessage) error
	LeaveMember(context.Context, string, string, int64) error
	SetRoomMedia(context.Context, string, string, int64) error
	UpdateMediaMetadata(context.Context, string, int64, int, int, int64) error
	DeleteGuestSession(context.Context, string, string) error
	UpdateRoomStatus(context.Context, string, string, int64) error
}

type Actor struct {
	room                   model.Room
	playback               PlaybackState
	persist                Persistence
	now                    func() time.Time
	grace                  time.Duration
	commands               chan any
	done                   chan struct{}
	clients                atomic.Int64
	hostDriftSamples       int
	hostDriftDirection     int
	lastHostAnchorUpdateMs int64
}
type joinReq struct {
	c     Client
	reply chan error
}
type leaveReq struct {
	id     string
	client Client
}
type commandReq struct {
	identity model.Identity
	cmd      Command
	reply    chan result
}
type result struct {
	state *PlaybackState
	err   error
}
type snapshotReq struct{ reply chan map[string]any }
type closeReq struct{ done chan struct{} }
type reopenReq struct{ reply chan error }
type expireHost struct{ hostID string }
type broadcastReq struct{ event Envelope }
type readyReq struct {
	id    string
	ready bool
}
type checkpointReq struct{}
type runtimeMember struct {
	identity model.Identity
	client   Client
	joinedAt int64
	ready    bool
}

func NewActor(room model.Room, checkpoint *model.Checkpoint, p Persistence, grace time.Duration) *Actor {
	pb := PlaybackState{PlaybackRate: 1, Phase: PhaseNoMedia}
	if room.MediaID != nil {
		pb.MediaID = *room.MediaID
		pb.Phase = PhasePaused
	}
	if checkpoint != nil {
		pb.MediaID = ""
		if checkpoint.MediaID != nil {
			pb.MediaID = *checkpoint.MediaID
		}
		pb.AnchorPositionMs = checkpoint.PositionMs
		pb.PlaybackRate = checkpoint.PlaybackRate
		pb.Phase = PhasePaused
	}
	a := &Actor{room: room, playback: pb, persist: p, now: time.Now, grace: grace, commands: make(chan any, 128), done: make(chan struct{})}
	go a.run()
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				select {
				case a.commands <- checkpointReq{}:
				case <-a.done:
					return
				}
			case <-a.done:
				return
			}
		}
	}()
	return a
}
func (a *Actor) ID() string  { return a.room.ID }
func (a *Actor) Online() int { return int(a.clients.Load()) }
func (a *Actor) Join(ctx context.Context, c Client) error {
	reply := make(chan error, 1)
	select {
	case a.commands <- joinReq{c, reply}:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case e := <-reply:
		return e
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (a *Actor) Leave(id string) {
	select {
	case a.commands <- leaveReq{id: id}:
	case <-a.done:
	}
}
func (a *Actor) LeaveClient(client Client) {
	select {
	case a.commands <- leaveReq{id: client.ID(), client: client}:
	case <-a.done:
	}
}
func (a *Actor) Command(ctx context.Context, i model.Identity, c Command) (*PlaybackState, error) {
	reply := make(chan result, 1)
	select {
	case a.commands <- commandReq{i, c, reply}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	select {
	case r := <-reply:
		return r.state, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func (a *Actor) Snapshot(ctx context.Context) map[string]any {
	reply := make(chan map[string]any, 1)
	select {
	case a.commands <- snapshotReq{reply}:
	case <-ctx.Done():
		return nil
	}
	select {
	case s := <-reply:
		return s
	case <-ctx.Done():
		return nil
	}
}
func (a *Actor) Broadcast(e Envelope) {
	select {
	case a.commands <- broadcastReq{e}:
	case <-a.done:
	}
}
func (a *Actor) SetReady(id string, ready bool) {
	select {
	case a.commands <- readyReq{id, ready}:
	case <-a.done:
	}
}
func (a *Actor) Stop() {
	d := make(chan struct{})
	select {
	case a.commands <- closeReq{d}:
		<-d
	case <-a.done:
	}
}

func (a *Actor) Reopen(ctx context.Context) error {
	reply := make(chan error, 1)
	select {
	case a.commands <- reopenReq{reply: reply}:
	case <-ctx.Done():
		return ctx.Err()
	case <-a.done:
		return ErrRoomClosed
	}
	select {
	case err := <-reply:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-a.done:
		return ErrRoomClosed
	}
}

func (a *Actor) run() {
	members := map[string]*runtimeMember{}
	var hostTimer *time.Timer
	defer close(a.done)
	broadcast := func(e Envelope) {
		e.V = 1
		e.RoomID = a.room.ID
		e.ServerTimeMs = a.now().UnixMilli()
		for _, m := range members {
			if !m.client.Send(e) {
				m.client.Close(1013, "slow consumer")
				// The connection read loop will submit LeaveClient. Keeping the
				// member until then is important: a slow host must pass through
				// the normal host-disconnect checkpoint and grace-period path.
			}
		}
	}
	snapshot := func() map[string]any {
		list := make([]map[string]any, 0, len(members))
		for _, m := range members {
			role := "member"
			if m.identity.ID == a.room.HostUserID {
				role = "host"
			}
			kind := "user"
			if m.identity.Guest {
				kind = "guest"
			}
			list = append(list, map[string]any{"id": m.identity.ID, "nickname": m.identity.Nickname, "role": role, "kind": kind, "online": true, "ready": m.ready})
		}
		slices.SortFunc(list, func(x, y map[string]any) int {
			if x["role"] == "host" {
				return -1
			}
			if y["role"] == "host" {
				return 1
			}
			return 0
		})
		return map[string]any{"room": a.room, "playback": a.playback, "members": list}
	}
	for msg := range a.commands {
		switch x := msg.(type) {
		case joinReq:
			if a.room.Status == "CLOSED" {
				x.reply <- ErrRoomClosed
				continue
			}
			if _, ok := members[x.c.ID()]; !ok && len(members) >= a.room.MaxMembers {
				x.reply <- ErrRoomFull
				continue
			}
			if old := members[x.c.ID()]; old != nil {
				old.client.Close(StatusConnectionSuperseded, "replaced by reconnect")
			} else {
				a.clients.Add(1)
			}
			members[x.c.ID()] = &runtimeMember{identity: x.c.Identity(), client: x.c, joinedAt: a.now().UnixMilli()}
			if x.c.ID() == a.room.HostUserID && a.room.Status == "HOST_DISCONNECTED" {
				if hostTimer != nil {
					hostTimer.Stop()
				}
				a.room.Status = "OPEN"
				_ = a.persist.UpdateRoomStatus(context.Background(), a.room.ID, "OPEN", a.now().UnixMilli())
			}
			x.c.Send(Envelope{V: 1, Type: "event.room.snapshot", RoomID: a.room.ID, Revision: a.playback.Revision, ServerTimeMs: a.now().UnixMilli(), Payload: snapshot()})
			broadcast(Envelope{Type: "event.room.member_joined", Payload: map[string]any{"member": members[x.c.ID()].identity}})
			x.reply <- nil
		case leaveReq:
			m := members[x.id]
			if m == nil {
				continue
			}
			if x.client != nil && m.client != x.client {
				continue
			}
			delete(members, x.id)
			a.clients.Add(-1)
			broadcast(Envelope{Type: "event.room.member_left", Payload: map[string]any{"memberId": x.id}})
			if x.id == a.room.HostUserID && a.room.Status == "OPEN" {
				now := a.now().UnixMilli()
				a.playback.AnchorPositionMs = a.playback.Expected(now)
				a.playback.AnchorServerTimeMs = now
				a.playback.Phase = PhasePaused
				a.playback.Revision++
				a.room.Status = "HOST_DISCONNECTED"
				_ = a.persist.UpdateRoomStatus(context.Background(), a.room.ID, "HOST_DISCONNECTED", now)
				broadcast(Envelope{Type: "event.playback.state", Revision: a.playback.Revision, Payload: a.playback})
				a.persistCheckpoint()
				host := x.id
				hostTimer = time.AfterFunc(a.grace, func() {
					select {
					case a.commands <- expireHost{host}:
					case <-a.done:
					}
				})
			}
		case expireHost:
			if a.room.Status != "HOST_DISCONNECTED" || a.room.HostUserID != x.hostID {
				continue
			}
			dbmembers, _ := a.persist.Members(context.Background(), a.room.ID)
			var next string
			for _, candidate := range dbmembers {
				if candidate.ID == x.hostID {
					continue
				}
				if m := members[candidate.ID]; m != nil && !m.identity.Guest {
					next = candidate.ID
					break
				}
			}
			if next == "" {
				// No eligible member is online to take over. Keep the paused room
				// recoverable instead of turning a temporary host absence into a
				// permanent close. The host can reconnect at any later time.
				continue
			} else {
				old := a.room.HostUserID
				a.room.HostUserID = next
				a.room.Status = "OPEN"
				_ = a.persist.TransferHost(context.Background(), a.room.ID, old, next, a.now().UnixMilli())
				broadcast(Envelope{Type: "event.room.host_changed", Payload: map[string]any{"hostUserId": next}})
			}
		case commandReq:
			st, err := a.apply(x.identity, x.cmd, broadcast, members)
			x.reply <- result{st, err}
		case snapshotReq:
			x.reply <- snapshot()
		case readyReq:
			if m := members[x.id]; m != nil {
				m.ready = x.ready
			}
		case broadcastReq:
			broadcast(x.event)
		case checkpointReq:
			if a.playback.Phase == PhasePlaying {
				a.persistCheckpoint()
			}
		case reopenReq:
			if a.room.Status != "CLOSED" {
				x.reply <- nil
				continue
			}
			now := a.now().UnixMilli()
			if err := a.persist.ReopenRoom(context.Background(), a.room.ID, now); err != nil {
				x.reply <- err
				continue
			}
			a.room.Status = "HOST_DISCONNECTED"
			a.room.ClosedAtMs = nil
			a.room.UpdatedAtMs = now
			x.reply <- nil
		case closeReq:
			if hostTimer != nil {
				hostTimer.Stop()
			}
			for _, m := range members {
				m.client.Send(Envelope{Type: "event.server.shutdown"})
				m.client.Close(1001, "server shutdown")
			}
			a.persistCheckpoint()
			close(x.done)
			return
		}
	}
}

func (a *Actor) apply(i model.Identity, c Command, broadcast func(Envelope), members map[string]*runtimeMember) (*PlaybackState, error) {
	isAdmin := strings.HasPrefix(c.Type, "cmd.room.")
	if members[i.ID] == nil && !isAdmin {
		return nil, ErrNotMember
	}
	if c.Type == "client.ready" {
		var p struct {
			Ready       bool   `json:"ready"`
			MediaID     string `json:"mediaId"`
			DurationMs  int64  `json:"durationMs"`
			VideoWidth  int    `json:"videoWidth"`
			VideoHeight int    `json:"videoHeight"`
		}
		if json.Unmarshal(c.Payload, &p) != nil {
			return nil, ErrInvalidCommand
		}
		members[i.ID].ready = p.Ready
		if i.ID == a.room.HostUserID && p.Ready && p.MediaID == a.playback.MediaID && p.DurationMs > 0 && p.DurationMs <= 7*24*60*60*1000 {
			a.playback.DurationMs = p.DurationMs
			a.playback.Revision++
			_ = a.persist.UpdateMediaMetadata(context.Background(), p.MediaID, p.DurationMs, p.VideoWidth, p.VideoHeight, a.now().UnixMilli())
			state := a.playback
			broadcast(Envelope{Type: "event.playback.state", Revision: state.Revision, Payload: state})
			return &state, nil
		}
		return nil, nil
	}
	if c.Type == "telemetry.member.playback" || c.Type == "presence.typing" {
		return nil, nil
	}
	if i.ID != a.room.HostUserID {
		return nil, ErrNotHost
	}
	now := a.now().UnixMilli()
	var p struct {
		PositionMs   int64   `json:"positionMs"`
		PlaybackRate float64 `json:"playbackRate"`
		Paused       bool    `json:"paused"`
		ReadyState   int     `json:"readyState"`
		TargetUserID string  `json:"targetUserId"`
		MediaID      string  `json:"mediaId"`
		DurationMs   int64   `json:"durationMs"`
	}
	if err := json.Unmarshal(c.Payload, &p); err != nil {
		return nil, ErrInvalidCommand
	}
	if c.Type == "cmd.room.transfer_host" {
		target := members[p.TargetUserID]
		if target == nil || target.identity.Guest {
			return nil, ErrInvalidCommand
		}
		old := a.room.HostUserID
		if err := a.persist.TransferHost(context.Background(), a.room.ID, old, p.TargetUserID, now); err != nil {
			return nil, err
		}
		a.room.HostUserID = p.TargetUserID
		broadcast(Envelope{Type: "event.room.host_changed", Payload: map[string]any{"hostUserId": p.TargetUserID}})
		return nil, nil
	}
	if c.Type == "cmd.room.kick" {
		target := members[p.TargetUserID]
		if target == nil || p.TargetUserID == a.room.HostUserID {
			return nil, ErrInvalidCommand
		}
		delete(members, p.TargetUserID)
		a.clients.Add(-1)
		if target.identity.Guest {
			_ = a.persist.DeleteGuestSession(context.Background(), a.room.ID, p.TargetUserID)
		} else {
			_ = a.persist.LeaveMember(context.Background(), a.room.ID, p.TargetUserID, now)
		}
		target.client.Close(1008, "removed from room")
		broadcast(Envelope{Type: "event.room.member_left", Payload: map[string]any{"memberId": p.TargetUserID, "kicked": true}})
		return nil, nil
	}
	if c.Type == "cmd.room.close" {
		a.room.Status = "CLOSED"
		if err := a.persist.CloseRoom(context.Background(), a.room.ID, now); err != nil {
			return nil, err
		}
		broadcast(Envelope{Type: "event.room.closed"})
		for id, m := range members {
			m.client.Close(1000, "room closed")
			delete(members, id)
		}
		a.clients.Store(0)
		return nil, nil
	}
	if c.Type == "cmd.room.media" {
		if p.MediaID == "" || p.DurationMs < 0 {
			return nil, ErrInvalidCommand
		}
		if err := a.persist.SetRoomMedia(context.Background(), a.room.ID, p.MediaID, now); err != nil {
			return nil, err
		}
		a.room.MediaID = &p.MediaID
		a.playback.MediaID = p.MediaID
		a.playback.DurationMs = p.DurationMs
		a.playback.Phase = PhaseLoading
		a.playback.AnchorPositionMs = 0
		a.playback.AnchorServerTimeMs = now
		a.playback.PlaybackRate = 1
		a.playback.TimelineEpoch++
		a.playback.Revision++
		state := a.playback
		broadcast(Envelope{Type: "event.playback.state", Revision: state.Revision, Payload: state})
		a.persistCheckpoint()
		return &state, nil
	}
	if p.PositionMs < 0 || (a.playback.DurationMs > 0 && p.PositionMs > a.playback.DurationMs+1000) {
		return nil, ErrInvalidPosition
	}
	changed := true
	switch c.Type {
	case "cmd.playback.play":
		a.resetHostDriftTracking()
		a.playback.Phase = PhasePlaying
		a.playback.AnchorPositionMs = p.PositionMs
		a.playback.AnchorServerTimeMs = now + ScheduleLeadMs
	case "cmd.playback.pause":
		a.resetHostDriftTracking()
		a.playback.Phase = PhasePaused
		a.playback.AnchorPositionMs = p.PositionMs
		a.playback.AnchorServerTimeMs = now
	case "cmd.playback.seek":
		a.resetHostDriftTracking()
		a.playback.TimelineEpoch++
		a.playback.AnchorPositionMs = p.PositionMs
		if a.playback.Phase == PhasePlaying {
			a.playback.AnchorServerTimeMs = now + ScheduleLeadMs
		} else {
			a.playback.AnchorServerTimeMs = now
		}
	case "cmd.playback.rate":
		a.resetHostDriftTracking()
		if !validRate(p.PlaybackRate) {
			return nil, ErrInvalidCommand
		}
		pos := a.playback.Expected(now)
		a.playback.PlaybackRate = p.PlaybackRate
		a.playback.AnchorPositionMs = pos
		a.playback.AnchorServerTimeMs = now
	case "cmd.playback.host_buffering":
		a.resetHostDriftTracking()
		a.playback.Phase = PhaseBuffering
		a.playback.ResumeIntent = PhasePlaying
		a.playback.AnchorPositionMs = p.PositionMs
		a.playback.AnchorServerTimeMs = now
	case "cmd.playback.host_ready":
		a.resetHostDriftTracking()
		if a.playback.Phase == PhaseBuffering && a.playback.ResumeIntent == PhasePlaying {
			a.playback.Phase = PhasePlaying
			a.playback.AnchorServerTimeMs = now + ScheduleLeadMs
		} else {
			changed = false
		}
	case "telemetry.host.playback":
		if !a.acceptHostAnchorSample(now, p.PositionMs, p.Paused, p.ReadyState) {
			changed = false
		}
	case "cmd.playback.ended":
		a.resetHostDriftTracking()
		a.playback.Phase = PhaseEnded
		a.playback.AnchorPositionMs = p.PositionMs
		a.playback.AnchorServerTimeMs = now
	default:
		return nil, ErrInvalidCommand
	}
	if !changed {
		return nil, nil
	}
	a.playback.Revision++
	state := a.playback
	broadcast(Envelope{Type: "event.playback.state", Revision: state.Revision, Payload: state})
	a.persistCheckpoint()
	return &state, nil
}

// acceptHostAnchorSample prevents the host heartbeat from becoming a seek
// feedback loop. Only two healthy, same-direction drift samples can refresh
// the authoritative anchor, and refreshes are rate limited. Clients smooth
// these small anchor updates; the host never applies them back to itself.
func (a *Actor) acceptHostAnchorSample(now, positionMs int64, paused bool, readyState int) bool {
	if a.playback.Phase != PhasePlaying || paused || readyState < 3 {
		a.resetHostDriftTracking()
		return false
	}
	drift := positionMs - a.playback.Expected(now)
	if int64(math.Abs(float64(drift))) < HostDriftThresholdMs {
		a.resetHostDriftTracking()
		return false
	}
	direction := 1
	if drift < 0 {
		direction = -1
	}
	if direction != a.hostDriftDirection {
		a.hostDriftDirection = direction
		a.hostDriftSamples = 1
	} else {
		a.hostDriftSamples++
	}
	if a.hostDriftSamples < HostDriftConfirmations {
		return false
	}
	if a.lastHostAnchorUpdateMs > 0 && now-a.lastHostAnchorUpdateMs < HostAnchorMinIntervalMs {
		return false
	}
	a.playback.AnchorPositionMs = positionMs
	a.playback.AnchorServerTimeMs = now
	a.lastHostAnchorUpdateMs = now
	a.resetHostDriftTracking()
	return true
}

func (a *Actor) resetHostDriftTracking() {
	a.hostDriftSamples = 0
	a.hostDriftDirection = 0
}

func (a *Actor) persistCheckpoint() {
	position := a.playback.AnchorPositionMs
	if a.playback.Phase == PhasePlaying {
		position = a.playback.Expected(a.now().UnixMilli())
	}
	_ = a.persist.SaveCheckpoint(context.Background(), model.Checkpoint{RoomID: a.room.ID, MediaID: a.room.MediaID, PositionMs: position, PlaybackRate: a.playback.PlaybackRate, Phase: string(a.playback.Phase), UpdatedAtMs: a.now().UnixMilli()})
}

type Registry struct {
	mu     sync.RWMutex
	actors map[string]*Actor
	store  *repository.Store
	grace  time.Duration
	ready  atomic.Bool
}

func NewRegistry(store *repository.Store, grace time.Duration) *Registry {
	r := &Registry{actors: map[string]*Actor{}, store: store, grace: grace}
	r.ready.Store(true)
	return r
}
func (r *Registry) Get(ctx context.Context, id string) (*Actor, error) {
	r.mu.RLock()
	a := r.actors[id]
	r.mu.RUnlock()
	if a != nil {
		return a, nil
	}
	room, err := r.store.RoomByID(ctx, id)
	if err != nil {
		return nil, err
	}
	var checkpoint *model.Checkpoint
	if c, e := r.store.Checkpoint(ctx, id); e == nil {
		checkpoint = &c
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if a = r.actors[id]; a == nil {
		a = NewActor(room, checkpoint, r.store, r.grace)
		r.actors[id] = a
	}
	return a, nil
}
func (r *Registry) ActiveRooms() int { r.mu.RLock(); defer r.mu.RUnlock(); return len(r.actors) }
func (r *Registry) Ready() bool      { return r.ready.Load() }
func (r *Registry) Shutdown() {
	r.ready.Store(false)
	r.mu.Lock()
	actors := r.actors
	r.actors = map[string]*Actor{}
	r.mu.Unlock()
	for _, a := range actors {
		a.Stop()
	}
}
