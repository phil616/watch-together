package chat

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"movie-sync/internal/database"
	"movie-sync/internal/model"
	"movie-sync/internal/repository"
	"movie-sync/internal/rooms"
)

func TestChatValidationAndPlainTextPersistence(t *testing.T) {
	ctx := context.Background()
	db, err := database.Open(ctx, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := repository.New(db)
	now := time.Now().UnixMilli()
	user := model.User{ID: "host", Username: "host", Nickname: "Host"}
	if err = store.CreateUser(ctx, user, "hash", now); err != nil {
		t.Fatal(err)
	}
	room := model.Room{ID: "11111111-1111-4111-8111-111111111111", Code: "ABC23456", Title: "Movie", HostUserID: user.ID, Status: "OPEN", JoinPolicy: "INVITE", MaxMembers: 5}
	if err = store.CreateRoom(ctx, room, now); err != nil {
		t.Fatal(err)
	}
	registry := rooms.NewRegistry(store, time.Hour)
	defer registry.Shutdown()
	roomService := rooms.NewService(store, registry, 5)
	service := New(store, roomService, registry)
	identity := model.Identity{ID: user.ID, Nickname: user.Nickname}
	for _, content := range []string{"   ", strings.Repeat("x", 2001)} {
		if _, err = service.Send(ctx, room.ID, identity, content); err == nil || err.Error() != "MESSAGE_TOO_LARGE" {
			t.Errorf("invalid chat length accepted: %d runes, error=%v", len([]rune(content)), err)
		}
	}
	content := `<img src=x onerror="globalThis.pwned=true">`
	message, err := service.Send(ctx, room.ID, identity, content)
	if err != nil {
		t.Fatal(err)
	}
	if message.Content != content {
		t.Fatalf("chat text changed: %q", message.Content)
	}
	messages, err := store.Messages(ctx, room.ID, 0, 10)
	if err != nil || len(messages) != 1 || messages[0].Content != content {
		t.Fatalf("persisted messages=%+v err=%v", messages, err)
	}
}
