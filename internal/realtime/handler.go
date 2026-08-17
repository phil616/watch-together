package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"movie-sync/internal/auth"
	"movie-sync/internal/chat"
	"movie-sync/internal/model"
	"movie-sync/internal/rooms"
)

const ProtocolVersion = 1
const MaxMessageBytes = 16 * 1024

const (
	keepAliveInterval = 25 * time.Second
	writeTimeout      = 5 * time.Second
)

type Handler struct {
	Auth     *auth.Service
	Rooms    *rooms.Service
	Registry *rooms.Registry
	Chat     *chat.Service
	Origins  []string
	Log      *slog.Logger
	active   atomic.Int64
}

func (h *Handler) Active() int64 { return h.active.Load() }

type inbound struct {
	V         int             `json:"v"`
	Type      string          `json:"type"`
	RequestID string          `json:"requestId"`
	RoomID    string          `json:"roomId"`
	Payload   json.RawMessage `json:"payload"`
}
type connection struct {
	ws       *websocket.Conn
	identity model.Identity
	roomID   string
	out      chan rooms.Envelope
	done     chan struct{}
	once     sync.Once
}

func (c *connection) ID() string               { return c.identity.ID }
func (c *connection) Identity() model.Identity { return c.identity }
func (c *connection) Send(v rooms.Envelope) bool {
	select {
	case c.out <- v:
		return true
	default:
		return false
	}
}
func (c *connection) Close(code int, reason string) {
	c.once.Do(func() { close(c.done); _ = c.ws.Close(websocket.StatusCode(code), reason) })
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	startedAt := time.Now()
	identity, _, err := h.Auth.Authenticate(r.Context(), r)
	if err != nil {
		h.logRejected("authenticate", r, "", err)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	roomID := r.PathValue("roomID")
	room, err := h.Rooms.GetFor(r.Context(), roomID, identity)
	if err != nil {
		h.logRejected("room_access", r, identity.ID, err)
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.Origins, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		h.logRejected("upgrade", r, identity.ID, err)
		return
	}
	ws.SetReadLimit(MaxMessageBytes)
	// A hijacked WebSocket outlives the HTTP request lifecycle. The websocket
	// package explicitly warns against using r.Context after Accept.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &connection{ws: ws, identity: identity, roomID: room.ID, out: make(chan rooms.Envelope, 64), done: make(chan struct{})}
	actor, err := h.Registry.Get(ctx, room.ID)
	if err != nil {
		h.logRejected("room_actor", r, identity.ID, err)
		c.Close(1011, "room unavailable")
		return
	}
	h.active.Add(1)
	defer h.active.Add(-1)
	go c.writeLoop(ctx, cancel, h.Log)
	if err = actor.Join(ctx, c); err != nil {
		h.logRejected("room_join", r, identity.ID, err)
		c.Close(1008, err.Error())
		return
	}
	if h.Log != nil {
		h.Log.Info("websocket_connected", "roomId", room.ID, "identityId", identity.ID, "host", r.Host, "origin", r.Header.Get("Origin"))
	}
	defer actor.LeaveClient(c)
	defer c.Close(1000, "connection closed")
	for {
		recvAt := time.Now().UnixMilli()
		var msg inbound
		if err = wsjson.Read(ctx, ws, &msg); err != nil {
			if h.Log != nil {
				h.Log.Info("websocket_closed", "roomId", room.ID, "identityId", identity.ID, "closeCode", int(websocket.CloseStatus(err)), "durationMs", time.Since(startedAt).Milliseconds(), "error", err)
			}
			return
		}
		if msg.V != ProtocolVersion {
			c.Send(errorEnvelope(msg.RequestID, "PROTOCOL_VERSION_UNSUPPORTED", "Unsupported protocol version."))
			continue
		}
		if msg.RoomID != "" && msg.RoomID != room.ID {
			c.Send(errorEnvelope(msg.RequestID, "INVALID_COMMAND", "Room mismatch."))
			continue
		}
		switch msg.Type {
		case "clock.ping":
			var p struct {
				ClientMonoMs float64 `json:"clientMonoMs"`
			}
			if json.Unmarshal(msg.Payload, &p) != nil {
				c.Send(errorEnvelope(msg.RequestID, "INVALID_COMMAND", "Invalid clock sample."))
				continue
			}
			c.Send(rooms.Envelope{V: 1, Type: "clock.pong", Payload: map[string]any{"clientMonoMs": p.ClientMonoMs, "serverRecvUnixMs": recvAt, "serverSendUnixMs": time.Now().UnixMilli()}})
		case "chat.send":
			var p struct {
				Content string `json:"content"`
			}
			if json.Unmarshal(msg.Payload, &p) != nil {
				c.Send(errorEnvelope(msg.RequestID, "INVALID_COMMAND", "Invalid message."))
				continue
			}
			_, e := h.Chat.Send(ctx, room.ID, identity, p.Content)
			respond(c, msg.RequestID, e)
		case "presence.typing":
			var p struct {
				Typing bool `json:"typing"`
			}
			if json.Unmarshal(msg.Payload, &p) != nil {
				c.Send(errorEnvelope(msg.RequestID, "INVALID_COMMAND", "Invalid typing state."))
				continue
			}
			e := h.Chat.Typing(ctx, room.ID, identity, p.Typing)
			respond(c, msg.RequestID, e)
		default:
			if !allowedCommand(msg.Type) {
				c.Send(errorEnvelope(msg.RequestID, "INVALID_COMMAND", "Unknown command."))
				continue
			}
			_, e := actor.Command(ctx, identity, rooms.Command{Type: msg.Type, RequestID: msg.RequestID, Payload: msg.Payload})
			respond(c, msg.RequestID, e)
		}
	}
}

func (h *Handler) logRejected(stage string, r *http.Request, identityID string, err error) {
	if h.Log == nil {
		return
	}
	h.Log.Warn("websocket_rejected", "stage", stage, "identityId", identityID, "host", r.Host, "origin", r.Header.Get("Origin"), "error", err)
}
func allowedCommand(v string) bool {
	switch v {
	case "cmd.playback.play", "cmd.playback.pause", "cmd.playback.seek", "cmd.playback.rate", "cmd.playback.host_buffering", "cmd.playback.host_ready", "cmd.playback.ended", "telemetry.host.playback", "telemetry.member.playback", "client.ready":
		return true
	}
	return false
}
func respond(c *connection, id string, err error) {
	if err == nil {
		c.Send(rooms.Envelope{V: 1, Type: "ack", RequestID: id, Payload: map[string]any{"accepted": true}})
		return
	}
	code := "INVALID_COMMAND"
	switch {
	case errors.Is(err, rooms.ErrNotHost):
		code = "NOT_HOST"
	case errors.Is(err, rooms.ErrRoomClosed):
		code = "ROOM_CLOSED"
	case errors.Is(err, rooms.ErrRoomFull):
		code = "ROOM_FULL"
	case errors.Is(err, rooms.ErrNotMember):
		code = "FORBIDDEN"
	case errors.Is(err, rooms.ErrInvalidPosition):
		code = "INVALID_POSITION"
	}
	if err.Error() == "RATE_LIMITED" {
		code = "RATE_LIMITED"
	}
	if err.Error() == "MESSAGE_TOO_LARGE" {
		code = "MESSAGE_TOO_LARGE"
	}
	c.Send(errorEnvelope(id, code, err.Error()))
}
func errorEnvelope(id, code, message string) rooms.Envelope {
	return rooms.Envelope{V: 1, Type: "error", RequestID: id, Payload: map[string]any{"code": code, "message": message}}
}
func (c *connection) writeLoop(ctx context.Context, cancel context.CancelFunc, log *slog.Logger) {
	defer cancel()
	keepAlive := time.NewTicker(keepAliveInterval)
	defer keepAlive.Stop()
	for {
		select {
		case msg := <-c.out:
			wctx, done := context.WithTimeout(ctx, writeTimeout)
			err := wsjson.Write(wctx, c.ws, msg)
			done()
			if err != nil {
				if log != nil {
					log.Info("websocket_write_failed", "roomId", c.roomID, "identityId", c.identity.ID, "error", err)
				}
				return
			}
		case <-keepAlive.C:
			pctx, done := context.WithTimeout(ctx, writeTimeout)
			err := c.ws.Ping(pctx)
			done()
			if err != nil {
				if log != nil {
					log.Info("websocket_ping_failed", "roomId", c.roomID, "identityId", c.identity.ID, "error", err)
				}
				return
			}
		case <-c.done:
			return
		case <-ctx.Done():
			return
		}
	}
}
