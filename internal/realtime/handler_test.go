package realtime_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"movie-sync/internal/auth"
	"movie-sync/internal/chat"
	"movie-sync/internal/database"
	"movie-sync/internal/model"
	"movie-sync/internal/realtime"
	"movie-sync/internal/repository"
	"movie-sync/internal/rooms"
)

func TestHostMemberWebSocketFlowAndReconnect(t *testing.T) {
	ctx := context.Background()
	db, err := database.Open(ctx, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := repository.New(db)
	now := time.Now().UnixMilli()
	for _, u := range []model.User{{ID: "host", Username: "host", Nickname: "Host"}, {ID: "member", Username: "member", Nickname: "Member"}} {
		if err = store.CreateUser(ctx, u, "hash", now); err != nil {
			t.Fatal(err)
		}
	}
	tokens := map[string]string{"host": "host-token", "member": "member-token"}
	for id, token := range tokens {
		if err = store.CreateSession(ctx, "session-"+id, id, auth.TokenHash(token), auth.TokenHash("csrf-"+id), now+60000, now, "", "test"); err != nil {
			t.Fatal(err)
		}
	}
	room := model.Room{ID: "11111111-1111-4111-8111-111111111111", Code: "ABC23456", Title: "Movie", HostUserID: "host", Status: "OPEN", JoinPolicy: "INVITE", MaxMembers: 5}
	if err = store.CreateRoom(ctx, room, now); err != nil {
		t.Fatal(err)
	}
	if err = store.AddMember(ctx, room.ID, "member", now); err != nil {
		t.Fatal(err)
	}
	authSvc := auth.New(store, time.Hour, false)
	registry := rooms.NewRegistry(store, time.Hour)
	defer registry.Shutdown()
	roomSvc := rooms.NewService(store, registry, 5)
	chatSvc := chat.New(store, roomSvc, registry)
	handler := &realtime.Handler{Auth: authSvc, Rooms: roomSvc, Registry: registry, Chat: chatSvc, Origins: []string{"http://example.com"}, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	mux := http.NewServeMux()
	mux.Handle("GET /api/v1/rooms/{roomID}/ws", handler)
	server := httptest.NewServer(mux)
	defer server.Close()
	badHeaders := http.Header{}
	badHeaders.Set("Cookie", auth.SessionCookie+"="+tokens["host"])
	badHeaders.Set("Origin", "https://evil.example")
	badConn, badResp, badErr := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/v1/rooms/11111111-1111-4111-8111-111111111111/ws", &websocket.DialOptions{HTTPHeader: badHeaders})
	if badErr == nil {
		badConn.CloseNow()
		t.Fatal("invalid websocket origin accepted")
	}
	if badResp == nil || badResp.StatusCode != http.StatusForbidden {
		t.Fatalf("invalid origin status: response=%v err=%v", badResp, badErr)
	}
	dial := func(id string) *websocket.Conn {
		headers := http.Header{}
		headers.Set("Cookie", auth.SessionCookie+"="+tokens[id])
		headers.Set("Origin", "http://example.com")
		conn, resp, e := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/v1/rooms/11111111-1111-4111-8111-111111111111/ws", &websocket.DialOptions{HTTPHeader: headers})
		if e != nil {
			if resp != nil {
				t.Fatalf("dial %s: %v status=%d", id, e, resp.StatusCode)
			}
			t.Fatalf("dial %s: %v", id, e)
		}
		return conn
	}
	host := dial("host")
	defer host.CloseNow()
	if got := readType(t, host, "event.room.snapshot"); got.Revision != 0 {
		t.Fatalf("initial revision=%d", got.Revision)
	}
	member := dial("member")
	if got := readType(t, member, "event.room.snapshot"); got.Type != "event.room.snapshot" {
		t.Fatalf("snapshot=%+v", got)
	}
	write(t, host, map[string]any{"v": 1, "type": "cmd.playback.play", "requestId": "play-1", "payload": map[string]any{"positionMs": 1000}})
	state := readType(t, member, "event.playback.state")
	if state.Revision != 1 {
		t.Fatalf("play revision=%d", state.Revision)
	}
	readType(t, host, "ack")
	write(t, host, map[string]any{"v": 1, "type": "cmd.playback.pause", "requestId": "pause-1", "payload": map[string]any{"positionMs": 1200}})
	if paused := readType(t, member, "event.playback.state"); paused.Revision != 2 {
		t.Fatalf("pause revision=%d", paused.Revision)
	}
	readType(t, host, "ack")
	write(t, host, map[string]any{"v": 1, "type": "cmd.playback.seek", "requestId": "host-seek-1", "payload": map[string]any{"positionMs": 2000}})
	if sought := readType(t, member, "event.playback.state"); sought.Revision != 3 {
		t.Fatalf("seek revision=%d", sought.Revision)
	}
	readType(t, host, "ack")
	write(t, member, map[string]any{"v": 1, "type": "cmd.playback.seek", "requestId": "seek-1", "payload": map[string]any{"positionMs": 5000}})
	denied := readType(t, member, "error")
	payload := denied.Payload.(map[string]any)
	if payload["code"] != "NOT_HOST" {
		t.Fatalf("error=%+v", denied)
	}
	member.Close(websocket.StatusNormalClosure, "reconnect")
	member = dial("member")
	defer member.CloseNow()
	snapshot := readType(t, member, "event.room.snapshot")
	if snapshot.Revision != 3 {
		t.Fatalf("reconnect snapshot revision=%d", snapshot.Revision)
	}
}

func TestExpiredSessionCannotOpenWebSocket(t *testing.T) {
	ctx := context.Background()
	db, err := database.Open(ctx, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := repository.New(db)
	now := time.Now().UnixMilli()
	if err = store.CreateUser(ctx, model.User{ID: "host", Username: "host", Nickname: "Host"}, "hash", now); err != nil {
		t.Fatal(err)
	}
	if err = store.CreateSession(ctx, "expired", "host", auth.TokenHash("expired-token"), auth.TokenHash("csrf"), now-1, now-1000, "", "test"); err != nil {
		t.Fatal(err)
	}
	room := model.Room{ID: "11111111-1111-4111-8111-111111111111", Code: "ABC23456", Title: "Movie", HostUserID: "host", Status: "OPEN", JoinPolicy: "INVITE", MaxMembers: 5}
	if err = store.CreateRoom(ctx, room, now); err != nil {
		t.Fatal(err)
	}
	registry := rooms.NewRegistry(store, time.Hour)
	defer registry.Shutdown()
	roomSvc := rooms.NewService(store, registry, 5)
	handler := &realtime.Handler{
		Auth: auth.New(store, time.Hour, false), Rooms: roomSvc, Registry: registry,
		Chat: chat.New(store, roomSvc, registry), Origins: []string{"http://example.com"},
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/v1/rooms/{roomID}/ws", handler)
	server := httptest.NewServer(mux)
	defer server.Close()
	headers := http.Header{}
	headers.Set("Cookie", auth.SessionCookie+"=expired-token")
	headers.Set("Origin", "http://example.com")
	conn, resp, dialErr := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/v1/rooms/"+room.ID+"/ws", &websocket.DialOptions{HTTPHeader: headers})
	if conn != nil {
		conn.CloseNow()
	}
	if dialErr == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expired session accepted: status=%v err=%v", resp, dialErr)
	}
}

type wireEnvelope struct {
	V         int    `json:"v"`
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Revision  int64  `json:"revision"`
	Payload   any    `json:"payload"`
}

func readType(t *testing.T, c *websocket.Conn, want string) wireEnvelope {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		var e wireEnvelope
		if err := wsjson.Read(ctx, c, &e); err != nil {
			t.Fatalf("read %s: %v", want, err)
		}
		if e.Type == want {
			return e
		}
	}
}
func write(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, c, v); err != nil {
		t.Fatal(err)
	}
}
