package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"movie-sync/internal/auth"
	"movie-sync/internal/database"
	"movie-sync/internal/model"
	"movie-sync/internal/realtime"
	"movie-sync/internal/repository"
	"movie-sync/internal/rooms"
	"movie-sync/internal/s3store"
)

type adminObjects struct {
	s3store.Disabled
	deletes int
}

func (s *adminObjects) Delete(context.Context, string) error { s.deletes++; return nil }

type adminFixture struct {
	s                                 *Server
	handler                           http.Handler
	admin, user                       model.User
	adminToken, userToken, guestToken string
	objects                           *adminObjects
}

func newAdminFixture(t *testing.T) *adminFixture {
	t.Helper()
	ctx := context.Background()
	db, e := database.Open(ctx, filepath.Join(t.TempDir(), "admin.db"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	st := repository.New(db)
	a := auth.New(st, time.Hour, false)
	admin, e := a.BootstrapAdmin(ctx, "admin", "initial-password", "超级管理员")
	if e != nil {
		t.Fatal(e)
	}
	u, e := a.CreateUser(ctx, "alice", "member-password", "Alice")
	if e != nil {
		t.Fatal(e)
	}
	reg := rooms.NewRegistry(st, time.Second)
	t.Cleanup(reg.Shutdown)
	service := rooms.NewService(st, reg, 20)
	objects := &adminObjects{}
	s := &Server{Store: st, Auth: a, Registry: reg, Rooms: service, Objects: objects, BaseURL: "http://example.test", Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	s.Realtime = &realtime.Handler{Auth: a, Rooms: service, Registry: reg, Log: s.Log}
	_, at, _, e := a.Login(ctx, "admin", "initial-password", "", "")
	if e != nil {
		t.Fatal(e)
	}
	_, ut, _, e := a.Login(ctx, "alice", "member-password", "", "")
	if e != nil {
		t.Fatal(e)
	}
	return &adminFixture{s: s, handler: s.Handler(nil), admin: admin, user: u, adminToken: at, userToken: ut, objects: objects}
}
func (f *adminFixture) request(t *testing.T, method, path, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, "http://example.test"+path, strings.NewReader(body))
	r.Header.Set("Origin", "http://example.test")
	if token != "" {
		name := auth.SessionCookie
		if token == f.guestToken {
			name = auth.GuestCookie
		}
		r.AddCookie(&http.Cookie{Name: name, Value: token})
		_, csrf, e := f.s.Auth.Authenticate(r.Context(), r)
		if e == nil {
			_ = csrf
			// Test sessions use a known CSRF value without weakening production validation.
			if name == auth.SessionCookie {
				_, e = f.s.Store.DB.Exec(`UPDATE sessions SET csrf_hash=? WHERE token_hash=?`, auth.TokenHash("test-csrf"), auth.TokenHash(token))
			} else {
				_, e = f.s.Store.DB.Exec(`UPDATE guest_sessions SET csrf_hash=? WHERE token_hash=?`, auth.TokenHash("test-csrf"), auth.TokenHash(token))
			}
			if e != nil {
				t.Fatal(e)
			}
			r.AddCookie(&http.Cookie{Name: auth.CSRFCookie, Value: "test-csrf"})
			r.Header.Set("X-CSRF-Token", "test-csrf")
		}
	}
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	return w
}
func requireStatus(t *testing.T, w *httptest.ResponseRecorder, want int) {
	t.Helper()
	if w.Code != want {
		t.Fatalf("status %d want %d: %s", w.Code, want, w.Body.String())
	}
}
func TestAdminPermissionsAndClosedRegistration(t *testing.T) {
	f := newAdminFixture(t)
	requireStatus(t, f.request(t, "POST", "/api/v1/auth/register", `{"username":"bypass","password":"password1234","nickname":"Bypass"}`, ""), 403)
	paths := []struct{ method, path string }{{"GET", "stats"}, {"GET", "users"}, {"POST", "users"}, {"GET", "users/u"}, {"PATCH", "users/u"}, {"DELETE", "users/u"}, {"GET", "rooms"}, {"POST", "rooms"}, {"GET", "rooms/r"}, {"PATCH", "rooms/r"}, {"DELETE", "rooms/r"}, {"POST", "rooms/r/close"}, {"POST", "rooms/r/reopen"}, {"GET", "media"}, {"GET", "media/m"}, {"PATCH", "media/m"}, {"DELETE", "media/m"}}
	room, e := f.s.Rooms.Create(context.Background(), model.Identity{ID: f.user.ID}, "Guest room", 5)
	if e != nil {
		t.Fatal(e)
	}
	e = f.s.Store.CreateGuestSession(context.Background(), "guest", room.ID, "Guest", auth.TokenHash("guest-token"), auth.TokenHash("test-csrf"), time.Now().Add(time.Hour).UnixMilli(), 1)
	if e != nil {
		t.Fatal(e)
	}
	f.guestToken = "guest-token"
	for _, p := range paths {
		for _, token := range []string{"", f.userToken, f.guestToken} {
			want := 403
			if token == "" {
				want = 401
			}
			requireStatus(t, f.request(t, p.method, "/api/v1/admin/"+p.path, "{}", token), want)
		}
	}
	requireStatus(t, f.request(t, "GET", "/api/v1/admin/stats", "", f.adminToken), 200)
	r := httptest.NewRequest("POST", "http://example.test/api/v1/admin/users", bytes.NewBufferString(`{}`))
	r.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: f.adminToken})
	r.Header.Set("Origin", "http://example.test")
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	requireStatus(t, w, 403)
	me := f.request(t, "GET", "/api/v1/auth/me", "", f.adminToken)
	if !strings.Contains(me.Body.String(), `"role":"SUPER_ADMIN"`) {
		t.Fatal(me.Body.String())
	}
}
func TestAdminAccountLifecycleAndSingleton(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	if _, e := f.s.Auth.BootstrapAdmin(ctx, "second", "another-password", "Second"); e == nil {
		t.Fatal("second administrator allowed")
	}
	for _, body := range []string{`{"disabled":true}`} {
		requireStatus(t, f.request(t, "PATCH", "/api/v1/admin/users/"+f.admin.ID, body, f.adminToken), 409)
	}
	requireStatus(t, f.request(t, "DELETE", "/api/v1/admin/users/"+f.admin.ID, "", f.adminToken), 409)
	w := f.request(t, "POST", "/api/v1/admin/users", `{"username":"created","password":"created-password","nickname":"Created","role":"SUPER_ADMIN"}`, f.adminToken)
	requireStatus(t, w, 201)
	var created struct{ Data model.User }
	if e := json.Unmarshal(w.Body.Bytes(), &created); e != nil {
		t.Fatal(e)
	}
	if created.Data.Role != model.RoleUser {
		t.Fatal("role escalation")
	}
	requireStatus(t, f.request(t, "POST", "/api/v1/admin/users", `{"username":"created","password":"created-password","nickname":"Duplicate"}`, f.adminToken), 409)
	requireStatus(t, f.request(t, "POST", "/api/v1/admin/users", `{"username":"short","password":"short","nickname":"Short"}`, f.adminToken), 400)
	requireStatus(t, f.request(t, "GET", "/api/v1/admin/users?q=created&perPage=1", "", f.adminToken), 200)
	_, token, _, e := f.s.Auth.Login(ctx, "created", "created-password", "", "")
	if e != nil {
		t.Fatal(e)
	}
	requireStatus(t, f.request(t, "PATCH", "/api/v1/admin/users/"+created.Data.ID, `{"disabled":true,"password":"replacement-password"}`, f.adminToken), 200)
	requireStatus(t, f.request(t, "GET", "/api/v1/auth/me", "", token), 401)
	if _, _, _, e = f.s.Auth.Login(ctx, "created", "replacement-password", "", ""); e == nil {
		t.Fatal("disabled account logged in")
	}
	requireStatus(t, f.request(t, "PATCH", "/api/v1/admin/users/"+created.Data.ID, `{"disabled":false}`, f.adminToken), 200)
	if _, _, _, e = f.s.Auth.Login(ctx, "created", "created-password", "", ""); e == nil {
		t.Fatal("old password accepted")
	}
	if _, _, _, e = f.s.Auth.Login(ctx, "created", "replacement-password", "", ""); e != nil {
		t.Fatal(e)
	}
	requireStatus(t, f.request(t, "DELETE", "/api/v1/admin/users/"+created.Data.ID, "", f.adminToken), 200)
	if _, e = f.s.Store.UserByID(ctx, created.Data.ID); !errors.Is(e, repository.ErrNotFound) {
		t.Fatal(e)
	}
	var count int
	if e = f.s.Store.DB.QueryRow(`SELECT COUNT(*) FROM audit_events`).Scan(&count); e != nil || count < 4 {
		t.Fatalf("audit %d %v", count, e)
	}
}
func TestAdminRoomAndMediaLifecycle(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	r, e := f.s.Rooms.Create(ctx, model.Identity{ID: f.user.ID}, "Member room", 5)
	if e != nil {
		t.Fatal(e)
	}
	requireStatus(t, f.request(t, "DELETE", "/api/v1/admin/users/"+f.user.ID, "", f.adminToken), 409)
	requireStatus(t, f.request(t, "DELETE", "/api/v1/admin/rooms/"+r.ID, "", f.adminToken), 409)
	requireStatus(t, f.request(t, "PATCH", "/api/v1/admin/rooms/"+r.ID, `{"title":"Renamed"}`, f.adminToken), 200)
	actor, e := f.s.Registry.Get(ctx, r.ID)
	if e != nil {
		t.Fatal(e)
	}
	snapshot := actor.Snapshot(ctx)
	if snapshot["room"].(model.Room).Title != "Renamed" {
		t.Fatal("stale actor title")
	}
	requireStatus(t, f.request(t, "POST", "/api/v1/admin/rooms/"+r.ID+"/close", "{}", f.adminToken), 200)
	requireStatus(t, f.request(t, "POST", "/api/v1/admin/rooms/"+r.ID+"/reopen", "{}", f.adminToken), 200)
	requireStatus(t, f.request(t, "GET", "/api/v1/admin/rooms?q=Renamed", "", f.adminToken), 200)
	m := model.Media{ID: "movie", OwnerUserID: f.user.ID, ObjectKey: "movie-key", OriginalFilename: "before.mp4", MIMEType: "video/mp4", SizeBytes: 512, Status: "READY", CreatedAtMs: 1, UpdatedAtMs: 1}
	if e = f.s.Store.CreateMediaUpload(ctx, m, model.Upload{ID: "upload", MediaID: m.ID, Mode: "single", Status: "COMPLETED"}); e != nil {
		t.Fatal(e)
	}
	if e = f.s.Store.SetRoomMedia(ctx, r.ID, m.ID, 1); e != nil {
		t.Fatal(e)
	}
	requireStatus(t, f.request(t, "DELETE", "/api/v1/admin/media/"+m.ID, "", f.adminToken), 409)
	requireStatus(t, f.request(t, "PATCH", "/api/v1/admin/media/"+m.ID, `{"originalFilename":"after.mp4"}`, f.adminToken), 200)
	requireStatus(t, f.request(t, "GET", "/api/v1/admin/media?q=after", "", f.adminToken), 200)
	requireStatus(t, f.request(t, "POST", "/api/v1/admin/rooms/"+r.ID+"/close", "{}", f.adminToken), 200)
	requireStatus(t, f.request(t, "DELETE", "/api/v1/admin/media/"+m.ID, "", f.adminToken), 200)
	if f.objects.deletes != 1 {
		t.Fatal("object not removed")
	}
	if e = f.s.Store.SetRoomMedia(ctx, r.ID, m.ID, 2); !errors.Is(e, repository.ErrNotFound) {
		t.Fatal("deleted media selectable", e)
	}
	requireStatus(t, f.request(t, "DELETE", "/api/v1/admin/rooms/"+r.ID, "", f.adminToken), 200)
	if e = f.s.Store.Ready(ctx); e != nil {
		t.Fatal(e)
	}
	requireStatus(t, f.request(t, "DELETE", "/api/v1/admin/users/"+f.user.ID, "", f.adminToken), 200)
	if _, e = f.s.Registry.Get(ctx, r.ID); !errors.Is(e, repository.ErrNotFound) {
		t.Fatal("deleted actor resurrected", e)
	}
}
