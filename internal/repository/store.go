package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"movie-sync/internal/model"
)

var ErrNotFound = errors.New("not found")

type Store struct{ DB *sql.DB }

func New(db *sql.DB) *Store { return &Store{DB: db} }

func (s *Store) CreateUser(ctx context.Context, u model.User, hash string, now int64) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO users(id,username,password_hash,nickname,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?)`, u.ID, u.Username, hash, u.Nickname, now, now)
	return err
}

func (s *Store) UserByUsername(ctx context.Context, username string) (model.User, string, error) {
	var u model.User
	var hash string
	err := s.DB.QueryRowContext(ctx, `SELECT id,username,nickname,created_at_ms,password_hash FROM users WHERE username=?`, username).Scan(&u.ID, &u.Username, &u.Nickname, &u.CreatedAtMs, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return u, hash, err
}

func (s *Store) UserByID(ctx context.Context, id string) (model.User, error) {
	var u model.User
	err := s.DB.QueryRowContext(ctx, `SELECT id,username,nickname,created_at_ms FROM users WHERE id=?`, id).Scan(&u.ID, &u.Username, &u.Nickname, &u.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return u, err
}

func (s *Store) CreateSession(ctx context.Context, id, userID, tokenHash, csrfHash string, expires, now int64, ip, ua string) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO sessions(id,user_id,token_hash,csrf_hash,expires_at_ms,created_at_ms,last_seen_at_ms,ip_address,user_agent) VALUES(?,?,?,?,?,?,?,?,?)`, id, userID, tokenHash, csrfHash, expires, now, now, ip, ua)
	return err
}

func (s *Store) SessionIdentity(ctx context.Context, tokenHash string, now int64) (model.Identity, string, error) {
	var i model.Identity
	var csrf string
	err := s.DB.QueryRowContext(ctx, `SELECT u.id,u.nickname,s.csrf_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at_ms>?`, tokenHash, now).Scan(&i.ID, &i.Nickname, &csrf)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return i, csrf, err
}

func (s *Store) TouchSession(ctx context.Context, tokenHash string, now int64) {
	_, _ = s.DB.ExecContext(ctx, `UPDATE sessions SET last_seen_at_ms=? WHERE token_hash=?`, now, tokenHash)
}
func (s *Store) DeleteSession(ctx context.Context, tokenHash string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash=?`, tokenHash)
	return err
}

func (s *Store) CreateGuestSession(ctx context.Context, id, roomID, nickname, tokenHash, csrfHash string, expires, now int64) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO guest_sessions(id,room_id,nickname,token_hash,csrf_hash,expires_at_ms,created_at_ms) VALUES(?,?,?,?,?,?,?)`, id, roomID, nickname, tokenHash, csrfHash, expires, now)
	return err
}

func (s *Store) GuestIdentity(ctx context.Context, tokenHash string, now int64) (model.Identity, string, error) {
	var i model.Identity
	var csrf string
	i.Guest = true
	err := s.DB.QueryRowContext(ctx, `SELECT id,nickname,room_id,csrf_hash FROM guest_sessions WHERE token_hash=? AND expires_at_ms>?`, tokenHash, now).Scan(&i.ID, &i.Nickname, &i.RoomID, &csrf)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return i, csrf, err
}
func (s *Store) DeleteGuestSession(ctx context.Context, roomID, id string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM guest_sessions WHERE room_id=? AND id=?`, roomID, id)
	return err
}

func (s *Store) CreateRoom(ctx context.Context, r model.Room, now int64) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO rooms(id,code,title,host_user_id,media_id,status,join_policy,max_members,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)`, r.ID, r.Code, r.Title, r.HostUserID, r.MediaID, r.Status, r.JoinPolicy, r.MaxMembers, now, now)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO room_members(room_id,user_id,role,joined_at_ms) VALUES(?,?,?,?)`, r.ID, r.HostUserID, "HOST", now)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func scanRoom(row interface{ Scan(...any) error }) (model.Room, error) {
	var r model.Room
	err := row.Scan(&r.ID, &r.Code, &r.Title, &r.HostUserID, &r.MediaID, &r.Status, &r.JoinPolicy, &r.MaxMembers, &r.CreatedAtMs, &r.UpdatedAtMs, &r.ClosedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return r, err
}

const roomCols = `id,code,title,host_user_id,media_id,status,join_policy,max_members,created_at_ms,updated_at_ms,closed_at_ms`

func (s *Store) RoomByID(ctx context.Context, id string) (model.Room, error) {
	return scanRoom(s.DB.QueryRowContext(ctx, `SELECT `+roomCols+` FROM rooms WHERE id=?`, id))
}
func (s *Store) RoomByCode(ctx context.Context, code string) (model.Room, error) {
	return scanRoom(s.DB.QueryRowContext(ctx, `SELECT `+roomCols+` FROM rooms WHERE code=?`, strings.ToUpper(code)))
}

func (s *Store) RoomsForUser(ctx context.Context, userID string) ([]model.Room, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+prefix("r.", roomCols)+` FROM rooms r JOIN room_members m ON m.room_id=r.id WHERE m.user_id=? AND m.left_at_ms IS NULL ORDER BY r.updated_at_ms DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.Room
	for rows.Next() {
		r, err := scanRoom(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
func prefix(p, cols string) string {
	parts := strings.Split(cols, ",")
	for i := range parts {
		parts[i] = p + parts[i]
	}
	return strings.Join(parts, ",")
}

func (s *Store) IsMember(ctx context.Context, roomID, userID string, guest bool) (bool, error) {
	if guest {
		var n int
		err := s.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM guest_sessions WHERE id=? AND room_id=?`, userID, roomID).Scan(&n)
		return n > 0, err
	}
	var n int
	err := s.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM room_members WHERE room_id=? AND user_id=? AND left_at_ms IS NULL`, roomID, userID).Scan(&n)
	return n > 0, err
}
func (s *Store) AddMember(ctx context.Context, roomID, userID string, now int64) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO room_members(room_id,user_id,role,joined_at_ms,left_at_ms) VALUES(?,?, 'MEMBER',?,NULL) ON CONFLICT(room_id,user_id) DO UPDATE SET role='MEMBER',joined_at_ms=excluded.joined_at_ms,left_at_ms=NULL`, roomID, userID, now)
	return err
}
func (s *Store) LeaveMember(ctx context.Context, roomID, userID string, now int64) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE room_members SET left_at_ms=? WHERE room_id=? AND user_id=?`, now, roomID, userID)
	return err
}
func (s *Store) Members(ctx context.Context, roomID string) ([]model.Member, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT u.id,u.nickname,rm.role,rm.joined_at_ms FROM room_members rm JOIN users u ON u.id=rm.user_id WHERE rm.room_id=? AND rm.left_at_ms IS NULL ORDER BY rm.joined_at_ms`, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.Member
	for rows.Next() {
		var m model.Member
		m.Kind = "user"
		if err := rows.Scan(&m.ID, &m.Nickname, &m.Role, &m.JoinedAtMs); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
func (s *Store) TransferHost(ctx context.Context, roomID, oldID, newID string, now int64) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE room_members SET role='HOST' WHERE room_id=? AND user_id=? AND left_at_ms IS NULL`, roomID, newID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		return ErrNotFound
	}
	if _, err = tx.ExecContext(ctx, `UPDATE room_members SET role='MEMBER' WHERE room_id=? AND user_id=?`, roomID, oldID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE rooms SET host_user_id=?,status='OPEN',updated_at_ms=? WHERE id=? AND host_user_id=?`, newID, now, roomID, oldID); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) CloseRoom(ctx context.Context, roomID string, now int64) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE rooms SET status='CLOSED',closed_at_ms=?,updated_at_ms=? WHERE id=?`, now, now, roomID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM guest_sessions WHERE room_id=?`, roomID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ReopenRoom(ctx context.Context, roomID string, now int64) error {
	res, err := s.DB.ExecContext(ctx, `UPDATE rooms SET status='HOST_DISCONNECTED',closed_at_ms=NULL,updated_at_ms=? WHERE id=? AND status='CLOSED'`, now, roomID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrNotFound
	}
	return nil
}
func (s *Store) SetRoomMedia(ctx context.Context, roomID, mediaID string, now int64) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE rooms SET media_id=?,updated_at_ms=? WHERE id=?`, mediaID, now, roomID)
	return err
}
func (s *Store) UpdateRoomTitle(ctx context.Context, roomID, title string, now int64) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE rooms SET title=?,updated_at_ms=? WHERE id=?`, title, now, roomID)
	return err
}
func (s *Store) UpdateRoomStatus(ctx context.Context, roomID, status string, now int64) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE rooms SET status=?,updated_at_ms=? WHERE id=?`, status, now, roomID)
	return err
}

func (s *Store) CreateInvite(ctx context.Context, i model.Invite, tokenHash string) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO room_invites(id,room_id,token_hash,created_by,expires_at_ms,max_uses,used_count,created_at_ms) VALUES(?,?,?,?,?,?,?,?)`, i.ID, i.RoomID, tokenHash, i.CreatedBy, i.ExpiresAtMs, i.MaxUses, i.UsedCount, i.CreatedAtMs)
	return err
}
func (s *Store) InviteByHash(ctx context.Context, hash string, now int64) (model.Invite, error) {
	var i model.Invite
	err := s.DB.QueryRowContext(ctx, `SELECT id,room_id,created_by,expires_at_ms,max_uses,used_count,created_at_ms FROM room_invites WHERE token_hash=? AND (expires_at_ms IS NULL OR expires_at_ms>?) AND (max_uses IS NULL OR used_count<max_uses)`, hash, now).Scan(&i.ID, &i.RoomID, &i.CreatedBy, &i.ExpiresAtMs, &i.MaxUses, &i.UsedCount, &i.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return i, err
}
func (s *Store) ConsumeInvite(ctx context.Context, id string) error {
	res, err := s.DB.ExecContext(ctx, `UPDATE room_invites SET used_count=used_count+1 WHERE id=? AND (max_uses IS NULL OR used_count<max_uses)`, id)
	if err == nil {
		n, _ := res.RowsAffected()
		if n != 1 {
			return ErrNotFound
		}
	}
	return err
}

func (s *Store) CreateMediaUpload(ctx context.Context, m model.Media, u model.Upload) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO media(id,owner_user_id,object_key,original_filename,mime_type,size_bytes,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?)`, m.ID, m.OwnerUserID, m.ObjectKey, m.OriginalFilename, m.MIMEType, m.SizeBytes, m.Status, m.CreatedAtMs, m.UpdatedAtMs)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO media_uploads(id,media_id,s3_upload_id,mode,status,created_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?,?)`, u.ID, u.MediaID, u.S3UploadID, u.Mode, u.Status, u.CreatedAtMs, u.ExpiresAtMs)
	if err != nil {
		return err
	}
	return tx.Commit()
}
func scanMedia(row interface{ Scan(...any) error }) (model.Media, error) {
	var m model.Media
	err := row.Scan(&m.ID, &m.OwnerUserID, &m.ObjectKey, &m.OriginalFilename, &m.MIMEType, &m.SizeBytes, &m.DurationMs, &m.VideoWidth, &m.VideoHeight, &m.Status, &m.CreatedAtMs, &m.UpdatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return m, err
}

const mediaCols = `id,owner_user_id,object_key,original_filename,mime_type,size_bytes,duration_ms,video_width,video_height,status,created_at_ms,updated_at_ms`

func (s *Store) MediaByID(ctx context.Context, id string) (model.Media, error) {
	return scanMedia(s.DB.QueryRowContext(ctx, `SELECT `+mediaCols+` FROM media WHERE id=? AND deleted_at_ms IS NULL`, id))
}
func (s *Store) MediaForUser(ctx context.Context, userID string) ([]model.Media, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+mediaCols+` FROM media WHERE owner_user_id=? AND deleted_at_ms IS NULL ORDER BY created_at_ms DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.Media
	for rows.Next() {
		m, e := scanMedia(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
func (s *Store) UploadByID(ctx context.Context, id string) (model.Upload, model.Media, error) {
	var u model.Upload
	var m model.Media
	err := s.DB.QueryRowContext(ctx, `SELECT u.id,u.media_id,u.s3_upload_id,u.mode,u.status,u.created_at_ms,u.expires_at_ms,`+prefix("m.", mediaCols)+` FROM media_uploads u JOIN media m ON m.id=u.media_id WHERE u.id=?`, id).Scan(&u.ID, &u.MediaID, &u.S3UploadID, &u.Mode, &u.Status, &u.CreatedAtMs, &u.ExpiresAtMs, &m.ID, &m.OwnerUserID, &m.ObjectKey, &m.OriginalFilename, &m.MIMEType, &m.SizeBytes, &m.DurationMs, &m.VideoWidth, &m.VideoHeight, &m.Status, &m.CreatedAtMs, &m.UpdatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return u, m, err
}
func (s *Store) SetUploadS3ID(ctx context.Context, id, s3id string) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE media_uploads SET s3_upload_id=? WHERE id=?`, s3id, id)
	return err
}
func (s *Store) CompleteUpload(ctx context.Context, id string, now int64) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var mediaID string
	if err = tx.QueryRowContext(ctx, `SELECT media_id FROM media_uploads WHERE id=?`, id).Scan(&mediaID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE media_uploads SET status='COMPLETED' WHERE id=?`, id); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE media SET status='READY',updated_at_ms=? WHERE id=?`, now, mediaID); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) DeleteUpload(ctx context.Context, id string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM media_uploads WHERE id=?`, id)
	return err
}
func (s *Store) StaleUploads(ctx context.Context, now int64) ([]model.Upload, []model.Media, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT u.id,u.media_id,u.s3_upload_id,u.mode,u.status,u.created_at_ms,u.expires_at_ms,`+prefix("m.", mediaCols)+` FROM media_uploads u JOIN media m ON m.id=u.media_id WHERE u.status='OPEN' AND u.expires_at_ms<=?`, now)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var uploads []model.Upload
	var mediaItems []model.Media
	for rows.Next() {
		var u model.Upload
		var m model.Media
		if err = rows.Scan(&u.ID, &u.MediaID, &u.S3UploadID, &u.Mode, &u.Status, &u.CreatedAtMs, &u.ExpiresAtMs, &m.ID, &m.OwnerUserID, &m.ObjectKey, &m.OriginalFilename, &m.MIMEType, &m.SizeBytes, &m.DurationMs, &m.VideoWidth, &m.VideoHeight, &m.Status, &m.CreatedAtMs, &m.UpdatedAtMs); err != nil {
			return nil, nil, err
		}
		uploads = append(uploads, u)
		mediaItems = append(mediaItems, m)
	}
	return uploads, mediaItems, rows.Err()
}
func (s *Store) FailUpload(ctx context.Context, id string, now int64) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var mediaID string
	if err = tx.QueryRowContext(ctx, `SELECT media_id FROM media_uploads WHERE id=?`, id).Scan(&mediaID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE media_uploads SET status='ABORTED' WHERE id=?`, id); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE media SET status='FAILED',updated_at_ms=? WHERE id=?`, now, mediaID); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) MediaInUse(ctx context.Context, id string) (bool, error) {
	var n int
	err := s.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM rooms WHERE media_id=? AND status!='CLOSED'`, id).Scan(&n)
	return n > 0, err
}
func (s *Store) SoftDeleteMedia(ctx context.Context, id, owner string, now int64) error {
	res, err := s.DB.ExecContext(ctx, `UPDATE media SET status='DELETING',deleted_at_ms=?,updated_at_ms=? WHERE id=? AND owner_user_id=? AND deleted_at_ms IS NULL`, now, now, id, owner)
	if err == nil {
		n, _ := res.RowsAffected()
		if n != 1 {
			return ErrNotFound
		}
	}
	return err
}
func (s *Store) SetMediaDeleteStatus(ctx context.Context, id, status string, now int64) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE media SET status=?,updated_at_ms=? WHERE id=?`, status, now, id)
	return err
}
func (s *Store) PendingMediaDeletes(ctx context.Context) ([]model.Media, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+mediaCols+` FROM media WHERE deleted_at_ms IS NOT NULL AND status IN ('DELETING','DELETE_FAILED')`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.Media
	for rows.Next() {
		m, e := scanMedia(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
func (s *Store) UpdateMediaMetadata(ctx context.Context, id string, durationMs int64, width, height int, now int64) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE media SET duration_ms=?,video_width=?,video_height=?,updated_at_ms=? WHERE id=? AND status='READY'`, durationMs, width, height, now, id)
	return err
}

func (s *Store) SaveChat(ctx context.Context, m model.ChatMessage) error {
	var uid, gid any
	if m.SenderKind == "guest" {
		gid = m.SenderID
	} else {
		uid = m.SenderID
	}
	_, err := s.DB.ExecContext(ctx, `INSERT INTO chat_messages(id,room_id,sender_user_id,sender_guest_id,sender_nickname,content,media_position_ms,created_at_ms) VALUES(?,?,?,?,?,?,?,?)`, m.ID, m.RoomID, uid, gid, m.SenderNickname, m.Content, m.MediaPositionMs, m.CreatedAtMs)
	return err
}
func (s *Store) Messages(ctx context.Context, roomID string, before int64, limit int) ([]model.ChatMessage, error) {
	if before == 0 {
		before = 1 << 62
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT id,COALESCE(sender_user_id,sender_guest_id),CASE WHEN sender_guest_id IS NULL THEN 'user' ELSE 'guest' END,sender_nickname,content,media_position_ms,created_at_ms FROM chat_messages WHERE room_id=? AND created_at_ms<? ORDER BY created_at_ms DESC LIMIT ?`, roomID, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.ChatMessage
	for rows.Next() {
		var m model.ChatMessage
		m.RoomID = roomID
		if err := rows.Scan(&m.ID, &m.SenderID, &m.SenderKind, &m.SenderNickname, &m.Content, &m.MediaPositionMs, &m.CreatedAtMs); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) SaveCheckpoint(ctx context.Context, c model.Checkpoint) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO room_playback_checkpoints(room_id,media_id,position_ms,playback_rate,phase,updated_at_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET media_id=excluded.media_id,position_ms=excluded.position_ms,playback_rate=excluded.playback_rate,phase=excluded.phase,updated_at_ms=excluded.updated_at_ms`, c.RoomID, c.MediaID, c.PositionMs, c.PlaybackRate, c.Phase, c.UpdatedAtMs)
	return err
}
func (s *Store) Checkpoint(ctx context.Context, roomID string) (model.Checkpoint, error) {
	var c model.Checkpoint
	err := s.DB.QueryRowContext(ctx, `SELECT room_id,media_id,position_ms,playback_rate,phase,updated_at_ms FROM room_playback_checkpoints WHERE room_id=?`, roomID).Scan(&c.RoomID, &c.MediaID, &c.PositionMs, &c.PlaybackRate, &c.Phase, &c.UpdatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return c, err
}
func (s *Store) Cleanup(ctx context.Context, now int64) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at_ms<=?; DELETE FROM guest_sessions WHERE expires_at_ms<=?; DELETE FROM room_invites WHERE expires_at_ms IS NOT NULL AND expires_at_ms<=?`, now, now, now)
	return err
}

func IsUniqueViolation(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "unique")
}
func (s *Store) Ready(ctx context.Context) error {
	var one int
	if err := s.DB.QueryRowContext(ctx, "SELECT 1").Scan(&one); err != nil {
		return fmt.Errorf("sqlite: %w", err)
	}
	return nil
}
