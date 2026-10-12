package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"movie-sync/internal/auth"
	"movie-sync/internal/database"
	"movie-sync/internal/model"
	"movie-sync/internal/repository"
	"movie-sync/internal/s3store"
)

func TestStorageHealthRequiresLoginAndReturnsStructuredStatus(t *testing.T) {
	ctx := context.Background()
	db, err := database.Open(ctx, filepath.Join(t.TempDir(), "health.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := repository.New(db)
	now := time.Now()
	if err = store.CreateUser(ctx, model.User{ID: "owner", Username: "owner", Nickname: "Owner"}, "unused", now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err = store.CreateSession(ctx, "session", "owner", auth.TokenHash("token"), "csrf", now.Add(time.Hour).UnixMilli(), now.UnixMilli(), "", ""); err != nil {
		t.Fatal(err)
	}
	server := &Server{Auth: auth.New(store, time.Hour, false), Objects: s3store.Disabled{}}
	for _, loggedIn := range []bool{false, true} {
		r := httptest.NewRequest("GET", "/api/v1/storage/health", nil)
		if loggedIn {
			r.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: "token"})
		}
		w := httptest.NewRecorder()
		server.storageHealth(w, r)
		if !loggedIn {
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("anonymous status=%d", w.Code)
			}
			continue
		}
		var result struct {
			Data s3store.Health `json:"data"`
		}
		if err = json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || result.Data.Status != "not_configured" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("response: %s", w.Body.String())
		}
	}
}
