package repository

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"
	"movie-sync/internal/model"
)

var ErrConflict = errors.New("resource has dependent records")
var ErrProtected = errors.New("super administrator is protected")

type Page[T any] struct {
	Items   []T `json:"items"`
	Total   int `json:"total"`
	Page    int `json:"page"`
	PerPage int `json:"perPage"`
}
type AdminUser struct {
	model.User
	RoomCount  int `json:"roomCount"`
	MediaCount int `json:"mediaCount"`
}
type AdminRoom struct {
	model.Room
	OwnerName string `json:"ownerName"`
}
type AdminMedia struct {
	model.Media
	OwnerName string `json:"ownerName"`
}
type AdminStats struct {
	Users         int   `json:"users"`
	DisabledUsers int   `json:"disabledUsers"`
	Rooms         int   `json:"rooms"`
	OpenRooms     int   `json:"openRooms"`
	Media         int   `json:"media"`
	StorageBytes  int64 `json:"storageBytes"`
}

func (s *Store) AdminStats(ctx context.Context) (v AdminStats, err error) {
	err = s.DB.QueryRowContext(ctx, `SELECT (SELECT COUNT(*) FROM users),(SELECT COUNT(*) FROM users WHERE disabled=1),(SELECT COUNT(*) FROM rooms),(SELECT COUNT(*) FROM rooms WHERE status!='CLOSED'),(SELECT COUNT(*) FROM media WHERE deleted_at_ms IS NULL),(SELECT COALESCE(SUM(size_bytes),0) FROM media WHERE deleted_at_ms IS NULL)`).Scan(&v.Users, &v.DisabledUsers, &v.Rooms, &v.OpenRooms, &v.Media, &v.StorageBytes)
	return
}
func (s *Store) AdminUsers(ctx context.Context, q string, page, per int) (Page[AdminUser], error) {
	out := Page[AdminUser]{Items: []AdminUser{}, Page: page, PerPage: per}
	like := "%" + q + "%"
	if err := s.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE username LIKE ? OR nickname LIKE ?`, like, like).Scan(&out.Total); err != nil {
		return out, err
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT u.id,u.username,u.nickname,u.role,u.disabled,u.created_at_ms,(SELECT COUNT(*) FROM rooms WHERE host_user_id=u.id),(SELECT COUNT(*) FROM media WHERE owner_user_id=u.id AND deleted_at_ms IS NULL) FROM users u WHERE username LIKE ? OR nickname LIKE ? ORDER BY u.role='SUPER_ADMIN' DESC,u.created_at_ms DESC,u.id LIMIT ? OFFSET ?`, like, like, per, (page-1)*per)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var u AdminUser
		if err = rows.Scan(&u.ID, &u.Username, &u.Nickname, &u.Role, &u.Disabled, &u.CreatedAtMs, &u.RoomCount, &u.MediaCount); err != nil {
			return out, err
		}
		out.Items = append(out.Items, u)
	}
	return out, rows.Err()
}
func (s *Store) AdminRooms(ctx context.Context, q string, page, per int) (Page[AdminRoom], error) {
	out := Page[AdminRoom]{Items: []AdminRoom{}, Page: page, PerPage: per}
	like := "%" + q + "%"
	if err := s.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM rooms WHERE title LIKE ? OR code LIKE ?`, like, like).Scan(&out.Total); err != nil {
		return out, err
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT `+prefix("r.", roomCols)+`,u.nickname FROM rooms r JOIN users u ON u.id=r.host_user_id WHERE r.title LIKE ? OR r.code LIKE ? ORDER BY r.updated_at_ms DESC,r.id LIMIT ? OFFSET ?`, like, like, per, (page-1)*per)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var v AdminRoom
		if err = rows.Scan(&v.ID, &v.Code, &v.Title, &v.HostUserID, &v.MediaID, &v.Status, &v.JoinPolicy, &v.MaxMembers, &v.CreatedAtMs, &v.UpdatedAtMs, &v.ClosedAtMs, &v.OwnerName); err != nil {
			return out, err
		}
		out.Items = append(out.Items, v)
	}
	return out, rows.Err()
}
func (s *Store) AdminMedia(ctx context.Context, q string, page, per int) (Page[AdminMedia], error) {
	out := Page[AdminMedia]{Items: []AdminMedia{}, Page: page, PerPage: per}
	like := "%" + q + "%"
	if err := s.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM media WHERE deleted_at_ms IS NULL AND original_filename LIKE ?`, like).Scan(&out.Total); err != nil {
		return out, err
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT `+prefix("m.", mediaCols)+`,u.nickname FROM media m JOIN users u ON u.id=m.owner_user_id WHERE m.deleted_at_ms IS NULL AND m.original_filename LIKE ? ORDER BY m.created_at_ms DESC,m.id LIMIT ? OFFSET ?`, like, per, (page-1)*per)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var v AdminMedia
		if err = rows.Scan(&v.ID, &v.OwnerUserID, &v.ObjectKey, &v.OriginalFilename, &v.MIMEType, &v.SizeBytes, &v.DurationMs, &v.VideoWidth, &v.VideoHeight, &v.Status, &v.CreatedAtMs, &v.UpdatedAtMs, &v.OwnerName); err != nil {
			return out, err
		}
		out.Items = append(out.Items, v)
	}
	return out, rows.Err()
}

// A transaction makes account edits and session invalidation indivisible.
func (s *Store) UpdateUser(ctx context.Context, id, username, nickname, hash string, disabled bool, now int64) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var role string
	if err = tx.QueryRowContext(ctx, `SELECT role FROM users WHERE id=?`, id).Scan(&role); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if role == model.RoleSuperAdmin && disabled {
		return ErrProtected
	}
	_, err = tx.ExecContext(ctx, `UPDATE users SET username=?,nickname=?,disabled=?,password_hash=CASE WHEN ?='' THEN password_hash ELSE ? END,updated_at_ms=? WHERE id=?`, username, nickname, disabled, hash, hash, now, id)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id=?`, id); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) DeleteUser(ctx context.Context, id, adminID string) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var role string
	if err = tx.QueryRowContext(ctx, `SELECT role FROM users WHERE id=?`, id).Scan(&role); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if role == model.RoleSuperAdmin {
		return ErrProtected
	}
	var n int
	if err = tx.QueryRowContext(ctx, `SELECT (SELECT COUNT(*) FROM rooms WHERE host_user_id=?)+(SELECT COUNT(*) FROM media WHERE owner_user_id=? AND deleted_at_ms IS NULL)`, id, id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return ErrConflict
	}
	// Keep object cleanup retries and history valid after an account is removed.
	if _, err = tx.ExecContext(ctx, `UPDATE media SET owner_user_id=? WHERE owner_user_id=?`, adminID, id); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `DELETE FROM users WHERE id=?`, id)
	if err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) DeleteRoom(ctx context.Context, id string) error {
	res, err := s.DB.ExecContext(ctx, `DELETE FROM rooms WHERE id=? AND status='CLOSED'`, id)
	if err == nil {
		n, _ := res.RowsAffected()
		if n != 1 {
			return ErrConflict
		}
	}
	return err
}
func (s *Store) RenameMedia(ctx context.Context, id, name string, now int64) error {
	res, err := s.DB.ExecContext(ctx, `UPDATE media SET original_filename=?,updated_at_ms=? WHERE id=? AND deleted_at_ms IS NULL`, name, now, id)
	if err == nil {
		n, _ := res.RowsAffected()
		if n != 1 {
			return ErrNotFound
		}
	}
	return err
}
func (s *Store) Audit(ctx context.Context, actor, event, target string) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO audit_events(id,actor_id,event_type,created_at_ms,details_json) VALUES(?,?,?,?,json_object('targetId',?))`, uuid.NewString(), actor, event, time.Now().UnixMilli(), target)
	return err
}

// Commit a login only while the credentials that were verified still apply.
// This closes the race between an expensive Argon2 check and an admin reset.
func (s *Store) CreateSessionForPassword(ctx context.Context, id, userID, passwordHash, tokenHash, csrfHash string, expires, now int64, ip, ua string) error {
	res, err := s.DB.ExecContext(ctx, `INSERT INTO sessions(id,user_id,token_hash,csrf_hash,expires_at_ms,created_at_ms,last_seen_at_ms,ip_address,user_agent) SELECT ?,id,?,?,?,?,?,?,? FROM users WHERE id=? AND password_hash=? AND disabled=0`, id, tokenHash, csrfHash, expires, now, now, ip, ua, userID, passwordHash)
	if err == nil {
		n, _ := res.RowsAffected()
		if n != 1 {
			return ErrNotFound
		}
	}
	return err
}
