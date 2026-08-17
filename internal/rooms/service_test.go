package rooms

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"movie-sync/internal/database"
	"movie-sync/internal/model"
	"movie-sync/internal/repository"
)

func TestInviteExpirationAndRoomAuthorization(t *testing.T) {
	ctx := context.Background()
	db, err := database.Open(ctx, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := repository.New(db)
	base := time.Unix(1_700_000_000, 0)
	for _, user := range []model.User{
		{ID: "host", Username: "host", Nickname: "Host"},
		{ID: "outsider", Username: "outsider", Nickname: "Outsider"},
	} {
		if err = store.CreateUser(ctx, user, "hash", base.UnixMilli()); err != nil {
			t.Fatal(err)
		}
	}
	registry := NewRegistry(store, time.Hour)
	defer registry.Shutdown()
	service := NewService(store, registry, 10)
	service.Now = func() time.Time { return base }
	host := model.Identity{ID: "host", Nickname: "Host"}
	room, err := service.Create(ctx, host, "Movie", 5)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.GetFor(ctx, room.ID, model.Identity{ID: "outsider"}); err != ErrNotMember {
		t.Fatalf("unauthorized room access error=%v", err)
	}
	invite, err := service.CreateInvite(ctx, room.ID, host, time.Minute, nil)
	if err != nil {
		t.Fatal(err)
	}
	service.Now = func() time.Time { return base.Add(2 * time.Minute) }
	if _, _, err = service.InviteInfo(ctx, invite.Token); err != repository.ErrNotFound {
		t.Fatalf("expired invite error=%v", err)
	}
}
