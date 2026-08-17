package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"movie-sync/internal/auth"
	"movie-sync/internal/chat"
	"movie-sync/internal/media"
	"movie-sync/internal/model"
	"movie-sync/internal/realtime"
	"movie-sync/internal/repository"
	"movie-sync/internal/rooms"
	"movie-sync/internal/s3store"
)

type Server struct {
	Auth          *auth.Service
	Store         *repository.Store
	Rooms         *rooms.Service
	Registry      *rooms.Registry
	Media         *media.Service
	Chat          *chat.Service
	Realtime      *realtime.Handler
	Objects       s3store.ObjectStore
	Origins       []string
	BaseURL       string
	Log           *slog.Logger
	LoginLimiter  interface{ Allow(string) bool }
	ActionLimiter interface{ Allow(string) bool }
}
type ctxKey string

const requestIDKey ctxKey = "requestID"

func (s *Server) Handler(static http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeData(w, http.StatusOK, map[string]any{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", s.ready)
	mux.HandleFunc("GET /diagnostics", s.diagnostics)
	mux.HandleFunc("GET /api/v1/auth/csrf", s.csrf)
	mux.HandleFunc("POST /api/v1/auth/register", s.register)
	mux.HandleFunc("POST /api/v1/auth/login", s.login)
	mux.HandleFunc("POST /api/v1/auth/logout", s.logout)
	mux.HandleFunc("GET /api/v1/auth/me", s.me)
	mux.HandleFunc("POST /api/v1/rooms", s.createRoom)
	mux.HandleFunc("GET /api/v1/rooms", s.listRooms)
	mux.HandleFunc("GET /api/v1/rooms/{roomID}", s.getRoom)
	mux.HandleFunc("PATCH /api/v1/rooms/{roomID}", s.patchRoom)
	mux.HandleFunc("POST /api/v1/rooms/{roomID}/join", s.joinRoom)
	mux.HandleFunc("POST /api/v1/rooms/{roomID}/leave", s.leaveRoom)
	mux.HandleFunc("POST /api/v1/rooms/{roomID}/reopen", s.reopenRoom)
	mux.HandleFunc("POST /api/v1/rooms/{roomID}/close", s.closeRoom)
	mux.HandleFunc("POST /api/v1/rooms/{roomID}/transfer-host", s.transferHost)
	mux.HandleFunc("POST /api/v1/rooms/{roomID}/kick", s.kick)
	mux.HandleFunc("POST /api/v1/rooms/{roomID}/invites", s.createInvite)
	mux.HandleFunc("GET /api/v1/invites/{inviteToken}/info", s.inviteInfo)
	mux.HandleFunc("POST /api/v1/invites/{inviteToken}/join", s.joinInvite)
	mux.HandleFunc("GET /api/v1/media", s.listMedia)
	mux.HandleFunc("POST /api/v1/media/uploads", s.initUpload)
	mux.HandleFunc("POST /api/v1/media/uploads/{uploadID}/parts", s.uploadParts)
	mux.HandleFunc("POST /api/v1/media/uploads/{uploadID}/complete", s.completeUpload)
	mux.HandleFunc("DELETE /api/v1/media/uploads/{uploadID}", s.abortUpload)
	mux.HandleFunc("DELETE /api/v1/media/{mediaID}", s.deleteMedia)
	mux.HandleFunc("POST /api/v1/rooms/{roomID}/media", s.setRoomMedia)
	mux.HandleFunc("POST /api/v1/rooms/{roomID}/media-ticket", s.mediaTicket)
	mux.HandleFunc("GET /api/v1/rooms/{roomID}/messages", s.messages)
	mux.Handle("GET /api/v1/rooms/{roomID}/ws", s.Realtime)
	if static != nil {
		mux.Handle("/", static)
	}
	return s.middleware(mux)
}

func (s *Server) middleware(next *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if _, err := uuid.Parse(id); err != nil {
			id = uuid.NewString()
		}
		ctx := context.WithValue(r.Context(), requestIDKey, id)
		w.Header().Set("X-Request-ID", id)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		connectSources, mediaSources := "'self' ws: wss: https:", "'self' blob: https:"
		if strings.HasPrefix(s.BaseURL, "http://") {
			connectSources += " http:"
			mediaSources += " http:"
		}
		w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src "+connectSources+"; media-src "+mediaSources+"; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'")
		start := time.Now()
		_, pattern := next.Handler(r)
		next.ServeHTTP(w, r.WithContext(ctx))
		s.Log.Info("http_request", "requestId", id, "method", r.Method, "route", pattern, "durationMs", time.Since(start).Milliseconds())
	})
}
func reqID(r *http.Request) string { v, _ := r.Context().Value(requestIDKey).(string); return v }
func writeData(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
}
func writeError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"code": code, "message": message, "requestId": reqID(r)}})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
	if err := d.Decode(v); err != nil {
		writeError(w, r, 400, "INVALID_REQUEST", "Invalid JSON request.")
		return false
	}
	return true
}
func (s *Server) identity(w http.ResponseWriter, r *http.Request, mutate bool) (model.Identity, bool) {
	i, csrf, err := s.Auth.Authenticate(r.Context(), r)
	if err != nil {
		writeError(w, r, 401, "UNAUTHORIZED", "Authentication required.")
		return model.Identity{}, false
	}
	if mutate {
		if !s.originAllowed(r) || !s.Auth.ValidCSRF(r, csrf) {
			writeError(w, r, 403, "FORBIDDEN", "CSRF validation failed.")
			return model.Identity{}, false
		}
	}
	return i, true
}
func (s *Server) formal(w http.ResponseWriter, r *http.Request, mutate bool) (model.Identity, bool) {
	i, ok := s.identity(w, r, mutate)
	if ok && i.Guest {
		writeError(w, r, 403, "FORBIDDEN", "Registered account required.")
		return model.Identity{}, false
	}
	return i, ok && !i.Guest
}
func (s *Server) originAllowed(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return false
	}
	if parsed, err := url.Parse(o); err == nil && strings.EqualFold(parsed.Host, r.Host) {
		return true
	}
	return slices.Contains(s.Origins, o)
}
func anonymousCSRF(r *http.Request) bool {
	c, err := r.Cookie(auth.CSRFCookie)
	if err != nil {
		return false
	}
	h := r.Header.Get("X-CSRF-Token")
	return subtle.ConstantTimeCompare([]byte(c.Value), []byte(h)) == 1 && h != ""
}
func (s *Server) csrf(w http.ResponseWriter, r *http.Request) {
	token, err := auth.NewToken()
	if err != nil {
		writeError(w, r, 500, "INTERNAL_ERROR", "Unable to issue token.")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: auth.CSRFCookie, Value: token, Path: "/", HttpOnly: false, Secure: s.Auth.Secure, SameSite: http.SameSiteLaxMode})
	writeData(w, 200, map[string]string{"csrfToken": token})
}

func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	if !s.originAllowed(r) || !anonymousCSRF(r) {
		writeError(w, r, 403, "FORBIDDEN", "CSRF validation failed.")
		return
	}
	if s.LoginLimiter != nil && !s.LoginLimiter.Allow("register:"+auth.RemoteIP(r)) {
		writeError(w, r, 429, "RATE_LIMITED", "Too many requests.")
		return
	}
	var in struct{ Username, Password, Nickname string }
	if !decode(w, r, &in) {
		return
	}
	u, err := s.Auth.Register(r.Context(), in.Username, in.Password, in.Nickname)
	if err != nil {
		code := "INVALID_REQUEST"
		if repository.IsUniqueViolation(err) {
			code = "USERNAME_TAKEN"
		}
		writeError(w, r, 400, code, err.Error())
		return
	}
	writeData(w, 201, u)
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.originAllowed(r) || !anonymousCSRF(r) {
		writeError(w, r, 403, "FORBIDDEN", "CSRF validation failed.")
		return
	}
	if s.LoginLimiter != nil && !s.LoginLimiter.Allow("login:"+auth.RemoteIP(r)) {
		writeError(w, r, 429, "RATE_LIMITED", "Too many requests.")
		return
	}
	var in struct{ Username, Password string }
	if !decode(w, r, &in) {
		return
	}
	u, token, csrf, err := s.Auth.Login(r.Context(), in.Username, in.Password, auth.RemoteIP(r), r.UserAgent())
	if err != nil {
		writeError(w, r, 401, "UNAUTHORIZED", "Invalid credentials.")
		return
	}
	s.Auth.SetCookies(w, token, csrf, time.Now().Add(s.Auth.TTL), false)
	writeData(w, 200, u)
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.identity(w, r, true); !ok {
		return
	}
	_ = s.Auth.Logout(r.Context(), r)
	s.Auth.ClearCookies(w)
	writeData(w, 200, map[string]bool{"loggedOut": true})
}
func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	i, ok := s.identity(w, r, false)
	if !ok {
		return
	}
	writeData(w, 200, i)
}

func (s *Server) createRoom(w http.ResponseWriter, r *http.Request) {
	i, ok := s.formal(w, r, true)
	if !ok {
		return
	}
	if s.ActionLimiter != nil && !s.ActionLimiter.Allow("room-create:"+i.ID) {
		writeError(w, r, 429, "RATE_LIMITED", "Too many requests.")
		return
	}
	var in struct {
		Title      string `json:"title"`
		MaxMembers int    `json:"maxMembers"`
	}
	if !decode(w, r, &in) {
		return
	}
	room, err := s.Rooms.Create(r.Context(), i, in.Title, in.MaxMembers)
	if err != nil {
		writeError(w, r, 400, "INVALID_REQUEST", err.Error())
		return
	}
	writeData(w, 201, room)
}
func (s *Server) listRooms(w http.ResponseWriter, r *http.Request) {
	i, ok := s.formal(w, r, false)
	if !ok {
		return
	}
	list, err := s.Store.RoomsForUser(r.Context(), i.ID)
	if err != nil {
		writeError(w, r, 500, "INTERNAL_ERROR", "Unable to list rooms.")
		return
	}
	writeData(w, 200, list)
}
func (s *Server) getRoom(w http.ResponseWriter, r *http.Request) {
	i, ok := s.identity(w, r, false)
	if !ok {
		return
	}
	room, err := s.Rooms.GetFor(r.Context(), r.PathValue("roomID"), i)
	if err != nil {
		writeError(w, r, 404, "ROOM_NOT_FOUND", "Room not found.")
		return
	}
	var mediaItem any
	if room.MediaID != nil {
		if m, e := s.Store.MediaByID(r.Context(), *room.MediaID); e == nil {
			mediaItem = m
		}
	}
	writeData(w, 200, map[string]any{"room": room, "media": mediaItem})
}
func (s *Server) patchRoom(w http.ResponseWriter, r *http.Request) {
	i, ok := s.formal(w, r, true)
	if !ok {
		return
	}
	room, err := s.Rooms.GetFor(r.Context(), r.PathValue("roomID"), i)
	if err != nil || room.HostUserID != i.ID {
		writeError(w, r, 403, "NOT_HOST", "Only the host can update the room.")
		return
	}
	var in struct {
		Title string `json:"title"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Title = strings.TrimSpace(in.Title)
	if len([]rune(in.Title)) < 1 || len([]rune(in.Title)) > 100 {
		writeError(w, r, 400, "INVALID_REQUEST", "Invalid title.")
		return
	}
	err = s.Store.UpdateRoomTitle(r.Context(), room.ID, in.Title, time.Now().UnixMilli())
	if err != nil {
		writeError(w, r, 500, "INTERNAL_ERROR", "Unable to update room.")
		return
	}
	writeData(w, 200, map[string]bool{"updated": true})
}
func (s *Server) joinRoom(w http.ResponseWriter, r *http.Request) {
	i, ok := s.formal(w, r, true)
	if !ok {
		return
	}
	err := s.Rooms.Join(r.Context(), r.PathValue("roomID"), i)
	if err != nil {
		writeError(w, r, 403, "FORBIDDEN", err.Error())
		return
	}
	writeData(w, 200, map[string]bool{"joined": true})
}
func (s *Server) leaveRoom(w http.ResponseWriter, r *http.Request) {
	i, ok := s.identity(w, r, true)
	if !ok {
		return
	}
	if err := s.Rooms.Leave(r.Context(), r.PathValue("roomID"), i); err != nil {
		writeError(w, r, 400, "INVALID_REQUEST", err.Error())
		return
	}
	writeData(w, 200, map[string]bool{"left": true})
}
func (s *Server) reopenRoom(w http.ResponseWriter, r *http.Request) {
	i, ok := s.formal(w, r, true)
	if !ok {
		return
	}
	room, err := s.Rooms.Reopen(r.Context(), r.PathValue("roomID"), i)
	if err != nil {
		status, code := http.StatusBadRequest, "INVALID_REQUEST"
		if errors.Is(err, rooms.ErrNotHost) {
			status, code = http.StatusForbidden, "NOT_HOST"
		}
		writeError(w, r, status, code, err.Error())
		return
	}
	writeData(w, http.StatusOK, room)
}
func (s *Server) closeRoom(w http.ResponseWriter, r *http.Request) {
	s.admin(w, r, "cmd.room.close", map[string]any{})
}
func (s *Server) transferHost(w http.ResponseWriter, r *http.Request) {
	var in struct {
		UserID string `json:"userId"`
	}
	if !decode(w, r, &in) {
		return
	}
	s.admin(w, r, "cmd.room.transfer_host", map[string]any{"targetUserId": in.UserID})
}
func (s *Server) kick(w http.ResponseWriter, r *http.Request) {
	var in struct {
		UserID string `json:"userId"`
	}
	if !decode(w, r, &in) {
		return
	}
	s.admin(w, r, "cmd.room.kick", map[string]any{"targetUserId": in.UserID})
}
func (s *Server) admin(w http.ResponseWriter, r *http.Request, cmd string, payload any) {
	i, ok := s.formal(w, r, true)
	if !ok {
		return
	}
	if err := s.Rooms.Admin(r.Context(), r.PathValue("roomID"), i, cmd, payload); err != nil {
		code := "INVALID_REQUEST"
		if errors.Is(err, rooms.ErrNotHost) {
			code = "NOT_HOST"
		}
		writeError(w, r, 403, code, err.Error())
		return
	}
	writeData(w, 200, map[string]bool{"accepted": true})
}

func (s *Server) createInvite(w http.ResponseWriter, r *http.Request) {
	i, ok := s.formal(w, r, true)
	if !ok {
		return
	}
	if s.ActionLimiter != nil && !s.ActionLimiter.Allow("invite-create:"+i.ID) {
		writeError(w, r, 429, "RATE_LIMITED", "Too many requests.")
		return
	}
	var in struct {
		ExpiresInSeconds int64 `json:"expiresInSeconds"`
		MaxUses          *int  `json:"maxUses"`
	}
	if !decode(w, r, &in) {
		return
	}
	res, err := s.Rooms.CreateInvite(r.Context(), r.PathValue("roomID"), i, time.Duration(in.ExpiresInSeconds)*time.Second, in.MaxUses)
	if err != nil {
		writeError(w, r, 400, "INVALID_REQUEST", err.Error())
		return
	}
	res.URL = strings.TrimRight(s.BaseURL, "/") + "/join/" + res.Token
	writeData(w, 201, res)
}
func (s *Server) inviteInfo(w http.ResponseWriter, r *http.Request) {
	_, room, err := s.Rooms.InviteInfo(r.Context(), r.PathValue("inviteToken"))
	if err != nil {
		writeError(w, r, 404, "INVITE_NOT_FOUND", "Invite is invalid or expired.")
		return
	}
	if _, e := r.Cookie(auth.CSRFCookie); e != nil {
		token, _ := auth.NewToken()
		http.SetCookie(w, &http.Cookie{Name: auth.CSRFCookie, Value: token, Path: "/", Secure: s.Auth.Secure, SameSite: http.SameSiteLaxMode})
	}
	writeData(w, 200, map[string]any{"roomCode": room.Code, "roomTitle": room.Title})
}
func (s *Server) joinInvite(w http.ResponseWriter, r *http.Request) {
	if !s.originAllowed(r) {
		writeError(w, r, 403, "FORBIDDEN", "Invalid origin.")
		return
	}
	if s.ActionLimiter != nil && !s.ActionLimiter.Allow("invite-join:"+auth.RemoteIP(r)) {
		writeError(w, r, 429, "RATE_LIMITED", "Too many requests.")
		return
	}
	var in struct {
		Nickname string `json:"nickname"`
	}
	if !decode(w, r, &in) {
		return
	}
	if identity, csrf, err := s.Auth.Authenticate(r.Context(), r); err == nil && !identity.Guest {
		if !s.Auth.ValidCSRF(r, csrf) {
			writeError(w, r, 403, "FORBIDDEN", "CSRF validation failed.")
			return
		}
		room, err := s.Rooms.JoinInviteUser(r.Context(), r.PathValue("inviteToken"), identity)
		if err != nil {
			writeError(w, r, 400, "INVITE_INVALID", err.Error())
			return
		}
		writeData(w, 200, room)
		return
	}
	if !anonymousCSRF(r) {
		writeError(w, r, 403, "FORBIDDEN", "CSRF validation failed.")
		return
	}
	room, token, csrf, err := s.Rooms.JoinInviteGuest(r.Context(), r.PathValue("inviteToken"), in.Nickname, 24*time.Hour)
	if err != nil {
		writeError(w, r, 400, "INVITE_INVALID", err.Error())
		return
	}
	s.Auth.SetCookies(w, token, csrf, time.Now().Add(24*time.Hour), true)
	writeData(w, 200, room)
}

func (s *Server) listMedia(w http.ResponseWriter, r *http.Request) {
	i, ok := s.formal(w, r, false)
	if !ok {
		return
	}
	list, err := s.Store.MediaForUser(r.Context(), i.ID)
	if err != nil {
		writeError(w, r, 500, "INTERNAL_ERROR", "Unable to list media.")
		return
	}
	writeData(w, 200, list)
}
func (s *Server) initUpload(w http.ResponseWriter, r *http.Request) {
	i, ok := s.formal(w, r, true)
	if !ok {
		return
	}
	if s.ActionLimiter != nil && !s.ActionLimiter.Allow("media-presign:"+i.ID) {
		writeError(w, r, 429, "RATE_LIMITED", "Too many requests.")
		return
	}
	var in struct {
		Filename    string `json:"filename"`
		SizeBytes   int64  `json:"sizeBytes"`
		ContentType string `json:"contentType"`
	}
	if !decode(w, r, &in) {
		return
	}
	out, err := s.Media.Init(r.Context(), i.ID, in.Filename, in.ContentType, in.SizeBytes)
	if err != nil {
		writeError(w, r, 400, "UPLOAD_FAILED", err.Error())
		return
	}
	writeData(w, 201, out)
}
func (s *Server) uploadParts(w http.ResponseWriter, r *http.Request) {
	i, ok := s.formal(w, r, true)
	if !ok {
		return
	}
	if s.ActionLimiter != nil && !s.ActionLimiter.Allow("media-presign:"+i.ID) {
		writeError(w, r, 429, "RATE_LIMITED", "Too many requests.")
		return
	}
	var in struct {
		PartNumbers []int32 `json:"partNumbers"`
	}
	if !decode(w, r, &in) {
		return
	}
	urls, err := s.Media.PartURLs(r.Context(), i.ID, r.PathValue("uploadID"), in.PartNumbers)
	if err != nil {
		writeError(w, r, 400, "UPLOAD_FAILED", err.Error())
		return
	}
	type part struct {
		PartNumber int32  `json:"partNumber"`
		URL        string `json:"url"`
	}
	out := make([]part, 0, len(urls))
	for n, u := range urls {
		out = append(out, part{n, u})
	}
	writeData(w, 200, map[string]any{"parts": out})
}
func (s *Server) completeUpload(w http.ResponseWriter, r *http.Request) {
	i, ok := s.formal(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Parts []s3store.CompletedPart `json:"parts"`
	}
	if !decode(w, r, &in) {
		return
	}
	if err := s.Media.Complete(r.Context(), i.ID, r.PathValue("uploadID"), in.Parts); err != nil {
		writeError(w, r, 400, "UPLOAD_FAILED", err.Error())
		return
	}
	writeData(w, 200, map[string]bool{"ready": true})
}
func (s *Server) abortUpload(w http.ResponseWriter, r *http.Request) {
	i, ok := s.formal(w, r, true)
	if !ok {
		return
	}
	if err := s.Media.Abort(r.Context(), i.ID, r.PathValue("uploadID")); err != nil {
		writeError(w, r, 400, "UPLOAD_FAILED", err.Error())
		return
	}
	writeData(w, 200, map[string]bool{"aborted": true})
}
func (s *Server) deleteMedia(w http.ResponseWriter, r *http.Request) {
	i, ok := s.formal(w, r, true)
	if !ok {
		return
	}
	id := r.PathValue("mediaID")
	m, err := s.Store.MediaByID(r.Context(), id)
	if err != nil || m.OwnerUserID != i.ID {
		writeError(w, r, 404, "MEDIA_NOT_FOUND", "Media not found.")
		return
	}
	used, err := s.Store.MediaInUse(r.Context(), id)
	if err != nil || used {
		writeError(w, r, 409, "MEDIA_IN_USE", "Media is used by an open room.")
		return
	}
	if err = s.Store.SoftDeleteMedia(r.Context(), id, i.ID, time.Now().UnixMilli()); err != nil {
		writeError(w, r, 500, "INTERNAL_ERROR", "Unable to delete media.")
		return
	}
	if err = s.Objects.Delete(r.Context(), m.ObjectKey); err != nil {
		_ = s.Store.SetMediaDeleteStatus(r.Context(), id, "DELETE_FAILED", time.Now().UnixMilli())
		writeError(w, r, 502, "MEDIA_DELETE_FAILED", "Object storage delete failed.")
		return
	}
	_ = s.Store.SetMediaDeleteStatus(r.Context(), id, "DELETED", time.Now().UnixMilli())
	writeData(w, 200, map[string]bool{"deleted": true})
}
func (s *Server) setRoomMedia(w http.ResponseWriter, r *http.Request) {
	i, ok := s.formal(w, r, true)
	if !ok {
		return
	}
	var in struct {
		MediaID string `json:"mediaId"`
	}
	if !decode(w, r, &in) {
		return
	}
	m, err := s.Store.MediaByID(r.Context(), in.MediaID)
	if err != nil || m.OwnerUserID != i.ID || m.Status != "READY" {
		writeError(w, r, 404, "MEDIA_NOT_READY", "Media is unavailable.")
		return
	}
	duration := int64(0)
	if m.DurationMs != nil {
		duration = *m.DurationMs
	}
	if err = s.Rooms.Admin(r.Context(), r.PathValue("roomID"), i, "cmd.room.media", map[string]any{"mediaId": m.ID, "durationMs": duration}); err != nil {
		writeError(w, r, 403, "NOT_HOST", err.Error())
		return
	}
	writeData(w, 200, map[string]bool{"changed": true})
}
func (s *Server) mediaTicket(w http.ResponseWriter, r *http.Request) {
	i, ok := s.identity(w, r, true)
	if !ok {
		return
	}
	if s.ActionLimiter != nil && !s.ActionLimiter.Allow("media-ticket:"+i.ID) {
		writeError(w, r, 429, "RATE_LIMITED", "Too many requests.")
		return
	}
	room, err := s.Rooms.GetFor(r.Context(), r.PathValue("roomID"), i)
	if err != nil {
		writeError(w, r, 404, "ROOM_NOT_FOUND", "Room not found.")
		return
	}
	url, expires, err := s.Media.Ticket(r.Context(), i, room)
	if err != nil {
		writeError(w, r, 403, "MEDIA_NOT_READY", err.Error())
		return
	}
	writeData(w, 200, map[string]any{"url": url, "expiresAtMs": expires})
}
func (s *Server) messages(w http.ResponseWriter, r *http.Request) {
	i, ok := s.identity(w, r, false)
	if !ok {
		return
	}
	room, err := s.Rooms.GetFor(r.Context(), r.PathValue("roomID"), i)
	if err != nil {
		writeError(w, r, 404, "ROOM_NOT_FOUND", "Room not found.")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	list, err := s.Store.Messages(r.Context(), room.ID, before, limit)
	if err != nil {
		writeError(w, r, 500, "INTERNAL_ERROR", "Unable to load messages.")
		return
	}
	slices.Reverse(list)
	writeData(w, 200, list)
}
func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	if err := s.Store.Ready(r.Context()); err != nil || !s.Registry.Ready() {
		writeError(w, r, 503, "NOT_READY", "Service is not ready.")
		return
	}
	writeData(w, 200, map[string]string{"status": "ready"})
}
func (s *Server) diagnostics(w http.ResponseWriter, r *http.Request) {
	host := r.RemoteAddr
	if !strings.HasPrefix(host, "127.0.0.1:") && !strings.HasPrefix(host, "[::1]:") {
		writeError(w, r, 403, "FORBIDDEN", "Local access only.")
		return
	}
	writeData(w, 200, map[string]any{"activeRooms": s.Registry.ActiveRooms(), "activeWebSockets": s.Realtime.Active()})
}

var _ = fmt.Sprintf
