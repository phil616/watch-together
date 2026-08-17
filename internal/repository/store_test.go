package repository

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"movie-sync/internal/database"
	"movie-sync/internal/model"
)

func TestSessionRoomMessageAndCheckpointRepositories(t *testing.T) {
	ctx := context.Background()
	db, err := database.Open(ctx, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := New(db)
	now := time.Now().UnixMilli()
	u := model.User{ID: "u", Username: "alice", Nickname: "Alice"}
	if err = s.CreateUser(ctx, u, "hash", now); err != nil {
		t.Fatal(err)
	}
	if err = s.CreateSession(ctx, "s", "u", "token", "csrf", now+1000, now, "ip", "ua"); err != nil {
		t.Fatal(err)
	}
	identity, csrf, err := s.SessionIdentity(ctx, "token", now)
	if err != nil || identity.ID != "u" || csrf != "csrf" {
		t.Fatalf("identity=%+v csrf=%s err=%v", identity, csrf, err)
	}
	room := model.Room{ID: "r", Code: "ABC23456", Title: "Movie", HostUserID: "u", Status: "OPEN", JoinPolicy: "INVITE", MaxMembers: 5}
	if err = s.CreateRoom(ctx, room, now); err != nil {
		t.Fatal(err)
	}
	loaded, err := s.RoomByCode(ctx, "abc23456")
	if err != nil || loaded.ID != "r" {
		t.Fatalf("room=%+v err=%v", loaded, err)
	}
	msg := model.ChatMessage{ID: "m", RoomID: "r", SenderID: "u", SenderKind: "user", SenderNickname: "Alice", Content: "hello", CreatedAtMs: now}
	if err = s.SaveChat(ctx, msg); err != nil {
		t.Fatal(err)
	}
	messages, err := s.Messages(ctx, "r", 0, 50)
	if err != nil || len(messages) != 1 || messages[0].Content != "hello" {
		t.Fatalf("messages=%+v err=%v", messages, err)
	}
	cp := model.Checkpoint{RoomID: "r", PositionMs: 1234, PlaybackRate: 1.25, Phase: "playing", UpdatedAtMs: now}
	if err = s.SaveCheckpoint(ctx, cp); err != nil {
		t.Fatal(err)
	}
	got, err := s.Checkpoint(ctx, "r")
	if err != nil || got.PositionMs != 1234 {
		t.Fatalf("checkpoint=%+v err=%v", got, err)
	}
	if err = s.CloseRoom(ctx, room.ID, now+1); err != nil {
		t.Fatal(err)
	}
	if err = s.ReopenRoom(ctx, room.ID, now+2); err != nil {
		t.Fatal(err)
	}
	reopened, err := s.RoomByID(ctx, room.ID)
	if err != nil || reopened.Status != "HOST_DISCONNECTED" || reopened.ClosedAtMs != nil {
		t.Fatalf("reopened room=%+v err=%v", reopened, err)
	}
}
