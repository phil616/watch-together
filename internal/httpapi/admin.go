package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"movie-sync/internal/auth"
	"movie-sync/internal/model"
	"movie-sync/internal/repository"
	"movie-sync/internal/rooms"
)

func (s *Server) adminRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/admin/stats", s.adminStats)
	mux.HandleFunc("GET /api/v1/admin/users", s.adminUsers)
	mux.HandleFunc("POST /api/v1/admin/users", s.adminCreateUser)
	mux.HandleFunc("GET /api/v1/admin/users/{userID}", s.adminGetUser)
	mux.HandleFunc("PATCH /api/v1/admin/users/{userID}", s.adminUpdateUser)
	mux.HandleFunc("DELETE /api/v1/admin/users/{userID}", s.adminDeleteUser)
	mux.HandleFunc("GET /api/v1/admin/rooms", s.adminRooms)
	mux.HandleFunc("POST /api/v1/admin/rooms", s.adminCreateRoom)
	mux.HandleFunc("GET /api/v1/admin/rooms/{roomID}", s.adminGetRoom)
	mux.HandleFunc("PATCH /api/v1/admin/rooms/{roomID}", s.adminUpdateRoom)
	mux.HandleFunc("DELETE /api/v1/admin/rooms/{roomID}", s.adminDeleteRoom)
	mux.HandleFunc("POST /api/v1/admin/rooms/{roomID}/close", s.adminRoomStatus)
	mux.HandleFunc("POST /api/v1/admin/rooms/{roomID}/reopen", s.adminRoomStatus)
	mux.HandleFunc("GET /api/v1/admin/media", s.adminMedia)
	mux.HandleFunc("GET /api/v1/admin/media/{mediaID}", s.adminGetMedia)
	mux.HandleFunc("PATCH /api/v1/admin/media/{mediaID}", s.adminUpdateMedia)
	mux.HandleFunc("DELETE /api/v1/admin/media/{mediaID}", s.adminDeleteMedia)
}
func (s *Server) superAdmin(w http.ResponseWriter, r *http.Request) (model.Identity, bool) {
	i, ok := s.formal(w, r, r.Method != "GET")
	if !ok {
		return i, false
	}
	if i.Role != model.RoleSuperAdmin {
		writeError(w, r, 403, "ADMIN_REQUIRED", "仅超级管理员可访问管理后台。")
		return model.Identity{}, false
	}
	return i, true
}
func pagination(r *http.Request) (string, int, int) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	per, _ := strconv.Atoi(r.URL.Query().Get("perPage"))
	if page < 1 {
		page = 1
	}
	if page > 1000000 {
		page = 1000000
	}
	if per < 1 {
		per = 20
	}
	if per > 100 {
		per = 100
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len([]rune(q)) > 100 {
		q = string([]rune(q)[:100])
	}
	return q, page, per
}
func (s *Server) adminError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, repository.ErrNotFound):
		writeError(w, r, 404, "NOT_FOUND", "资源不存在。")
	case errors.Is(err, repository.ErrProtected):
		writeError(w, r, 409, "ADMIN_PROTECTED", "超级管理员不能被禁用或删除。")
	case errors.Is(err, repository.ErrConflict):
		writeError(w, r, 409, "RESOURCE_IN_USE", "资源仍有关联记录，请先关闭并删除房间、处理影片；也可禁用账户。")
	case repository.IsUniqueViolation(err):
		writeError(w, r, 409, "USERNAME_TAKEN", "用户名已存在。")
	default:
		s.Log.Error("admin_operation_failed", "error", err)
		writeError(w, r, 500, "INTERNAL_ERROR", "操作失败，请稍后重试。")
	}
}
func (s *Server) audited(r *http.Request, i model.Identity, event, id string) {
	if err := s.Store.Audit(r.Context(), i.ID, event, id); err != nil {
		s.Log.Error("audit_failed", "event", event, "error", err)
	}
}
func (s *Server) adminStats(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.superAdmin(w, r); !ok {
		return
	}
	v, e := s.Store.AdminStats(r.Context())
	if e != nil {
		s.adminError(w, r, e)
		return
	}
	writeData(w, 200, v)
}
func (s *Server) adminUsers(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.superAdmin(w, r); !ok {
		return
	}
	q, p, n := pagination(r)
	v, e := s.Store.AdminUsers(r.Context(), q, p, n)
	if e != nil {
		s.adminError(w, r, e)
		return
	}
	writeData(w, 200, v)
}
func (s *Server) adminGetUser(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.superAdmin(w, r); !ok {
		return
	}
	v, e := s.Store.UserByID(r.Context(), r.PathValue("userID"))
	if e != nil {
		s.adminError(w, r, e)
		return
	}
	writeData(w, 200, v)
}
func (s *Server) adminCreateUser(w http.ResponseWriter, r *http.Request) {
	i, ok := s.superAdmin(w, r)
	if !ok {
		return
	}
	var in struct{ Username, Password, Nickname string }
	if !decode(w, r, &in) {
		return
	}
	var e error
	in.Username, in.Nickname, e = auth.NormalizeAccount(in.Username, in.Nickname)
	if e == nil {
		e = auth.ValidatePassword(in.Password)
	}
	if e != nil {
		writeError(w, r, 400, "INVALID_REQUEST", e.Error())
		return
	}
	u, e := s.Auth.CreateUser(r.Context(), in.Username, in.Password, in.Nickname)
	if e != nil {
		s.adminError(w, r, e)
		return
	}
	s.audited(r, i, "admin.user.create", u.ID)
	writeData(w, 201, u)
}
func (s *Server) adminUpdateUser(w http.ResponseWriter, r *http.Request) {
	i, ok := s.superAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("userID")
	u, e := s.Store.UserByID(r.Context(), id)
	if e != nil {
		s.adminError(w, r, e)
		return
	}
	var in struct {
		Username, Nickname, Password *string
		Disabled                     *bool
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Username != nil {
		u.Username = *in.Username
	}
	if in.Nickname != nil {
		u.Nickname = *in.Nickname
	}
	if in.Disabled != nil {
		u.Disabled = *in.Disabled
	}
	u.Username, u.Nickname, e = auth.NormalizeAccount(u.Username, u.Nickname)
	if e != nil {
		writeError(w, r, 400, "INVALID_REQUEST", e.Error())
		return
	}
	hash := ""
	if in.Password != nil {
		if e = auth.ValidatePassword(*in.Password); e != nil {
			writeError(w, r, 400, "INVALID_REQUEST", e.Error())
			return
		}
		hash, e = auth.HashPassword(*in.Password)
		if e != nil {
			s.adminError(w, r, e)
			return
		}
	}
	if e = s.Store.UpdateUser(r.Context(), id, u.Username, u.Nickname, hash, u.Disabled, time.Now().UnixMilli()); e != nil {
		s.adminError(w, r, e)
		return
	}
	if s.Realtime != nil {
		s.Realtime.RevokeUser(id)
	}
	s.audited(r, i, "admin.user.update", id)
	writeData(w, 200, u)
}
func (s *Server) adminDeleteUser(w http.ResponseWriter, r *http.Request) {
	i, ok := s.superAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("userID")
	if e := s.Store.DeleteUser(r.Context(), id, i.ID); e != nil {
		s.adminError(w, r, e)
		return
	}
	if s.Realtime != nil {
		s.Realtime.RevokeUser(id)
	}
	s.audited(r, i, "admin.user.delete", id)
	writeData(w, 200, map[string]bool{"deleted": true})
}
func (s *Server) adminRooms(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.superAdmin(w, r); !ok {
		return
	}
	q, p, n := pagination(r)
	v, e := s.Store.AdminRooms(r.Context(), q, p, n)
	if e != nil {
		s.adminError(w, r, e)
		return
	}
	writeData(w, 200, v)
}
func (s *Server) adminGetRoom(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.superAdmin(w, r); !ok {
		return
	}
	v, e := s.Store.RoomByID(r.Context(), r.PathValue("roomID"))
	if e != nil {
		s.adminError(w, r, e)
		return
	}
	writeData(w, 200, v)
}
func (s *Server) adminCreateRoom(w http.ResponseWriter, r *http.Request) {
	i, ok := s.superAdmin(w, r)
	if !ok {
		return
	}
	var in struct {
		Title      string
		MaxMembers int
	}
	if !decode(w, r, &in) {
		return
	}
	v, e := s.Rooms.Create(r.Context(), i, in.Title, in.MaxMembers)
	if e != nil {
		writeError(w, r, 400, "INVALID_REQUEST", e.Error())
		return
	}
	s.audited(r, i, "admin.room.create", v.ID)
	writeData(w, 201, v)
}
func (s *Server) adminUpdateRoom(w http.ResponseWriter, r *http.Request) {
	i, ok := s.superAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("roomID")
	var in struct{ Title string }
	if !decode(w, r, &in) {
		return
	}
	in.Title = strings.TrimSpace(in.Title)
	if len([]rune(in.Title)) < 1 || len([]rune(in.Title)) > 100 {
		writeError(w, r, 400, "INVALID_REQUEST", "房间标题需为 1–100 个字符。")
		return
	}
	a, e := s.Registry.Get(r.Context(), id)
	if e == nil {
		e = a.Rename(r.Context(), in.Title)
	}
	if e != nil {
		s.adminError(w, r, e)
		return
	}
	s.audited(r, i, "admin.room.update", id)
	writeData(w, 200, map[string]bool{"updated": true})
}
func (s *Server) adminRoomStatus(w http.ResponseWriter, r *http.Request) {
	i, ok := s.superAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("roomID")
	a, e := s.Registry.Get(r.Context(), id)
	action := "close"
	if strings.HasSuffix(r.URL.Path, "/reopen") {
		action = "reopen"
	}
	if e == nil {
		if action == "reopen" {
			e = a.Reopen(r.Context())
		} else {
			_, e = a.Command(r.Context(), i, rooms.Command{Type: "cmd.room.close", Payload: []byte(`{}`)})
		}
	}
	if e != nil {
		s.adminError(w, r, e)
		return
	}
	s.audited(r, i, "admin.room."+action, id)
	writeData(w, 200, map[string]bool{"updated": true})
}
func (s *Server) adminDeleteRoom(w http.ResponseWriter, r *http.Request) {
	i, ok := s.superAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("roomID")
	if e := s.Registry.Delete(r.Context(), id); e != nil {
		s.adminError(w, r, e)
		return
	}
	s.audited(r, i, "admin.room.delete", id)
	writeData(w, 200, map[string]bool{"deleted": true})
}
func (s *Server) adminMedia(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.superAdmin(w, r); !ok {
		return
	}
	q, p, n := pagination(r)
	v, e := s.Store.AdminMedia(r.Context(), q, p, n)
	if e != nil {
		s.adminError(w, r, e)
		return
	}
	writeData(w, 200, v)
}
func (s *Server) adminGetMedia(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.superAdmin(w, r); !ok {
		return
	}
	v, e := s.Store.MediaByID(r.Context(), r.PathValue("mediaID"))
	if e != nil {
		s.adminError(w, r, e)
		return
	}
	writeData(w, 200, v)
}
func (s *Server) adminUpdateMedia(w http.ResponseWriter, r *http.Request) {
	i, ok := s.superAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("mediaID")
	var in struct{ OriginalFilename string }
	if !decode(w, r, &in) {
		return
	}
	name := strings.TrimSpace(in.OriginalFilename)
	if len([]rune(name)) < 1 || len([]rune(name)) > 255 || strings.ContainsAny(name, "/\\") || strings.ContainsFunc(name, unicode.IsControl) {
		writeError(w, r, 400, "INVALID_REQUEST", "影片名称需为 1–255 个字符，且不能包含路径或控制字符。")
		return
	}
	if e := s.Store.RenameMedia(r.Context(), id, name, time.Now().UnixMilli()); e != nil {
		s.adminError(w, r, e)
		return
	}
	s.audited(r, i, "admin.media.update", id)
	writeData(w, 200, map[string]bool{"updated": true})
}
func (s *Server) adminDeleteMedia(w http.ResponseWriter, r *http.Request) {
	i, ok := s.superAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("mediaID")
	m, e := s.Store.MediaByID(r.Context(), id)
	if e != nil {
		s.adminError(w, r, e)
		return
	}
	if m.Status == "UPLOADING" {
		writeError(w, r, 409, "UPLOAD_IN_PROGRESS", "影片仍在上传，请等待上传结束或取消上传。")
		return
	}
	used, e := s.Store.MediaInUse(r.Context(), id)
	if e != nil {
		s.adminError(w, r, e)
		return
	}
	if used {
		writeError(w, r, 409, "MEDIA_IN_USE", "影片正在房间中使用，请先关闭关联房间或切换影片。")
		return
	}
	if e = s.Store.SoftDeleteMedia(r.Context(), id, m.OwnerUserID, time.Now().UnixMilli()); e != nil {
		s.adminError(w, r, e)
		return
	}
	s.audited(r, i, "admin.media.delete", id)
	if e = s.Objects.Delete(r.Context(), m.ObjectKey); e != nil {
		_ = s.Store.SetMediaDeleteStatus(r.Context(), id, "DELETE_FAILED", time.Now().UnixMilli())
		writeError(w, r, 502, "MEDIA_DELETE_FAILED", "影片已移出片库，对象存储清理失败，系统将定期重试。")
		return
	}
	_ = s.Store.SetMediaDeleteStatus(r.Context(), id, "DELETED", time.Now().UnixMilli())
	writeData(w, 200, map[string]bool{"deleted": true})
}
