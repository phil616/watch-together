package media

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"movie-sync/internal/model"
	"movie-sync/internal/repository"
	"movie-sync/internal/s3store"
)

const PartSizeBytes int64 = 32 * 1024 * 1024
const MultipartThreshold int64 = 64 * 1024 * 1024

type Service struct {
	Store               *repository.Store
	Objects             s3store.ObjectStore
	MaxSize             int64
	UploadTTL, MediaTTL time.Duration
	Now                 func() time.Time
}
type InitResult struct {
	MediaID       string `json:"mediaId"`
	UploadID      string `json:"uploadId"`
	Mode          string `json:"mode"`
	PartSizeBytes int64  `json:"partSizeBytes,omitempty"`
	URL           string `json:"url,omitempty"`
	ExpiresAtMs   int64  `json:"expiresAtMs,omitempty"`
}

func New(store *repository.Store, objects s3store.ObjectStore, max int64, uploadTTL, mediaTTL time.Duration) *Service {
	return &Service{Store: store, Objects: objects, MaxSize: max, UploadTTL: uploadTTL, MediaTTL: mediaTTL, Now: time.Now}
}
func (s *Service) Init(ctx context.Context, owner, filename, contentType string, size int64) (InitResult, error) {
	filename = cleanFilename(filename)
	if filename == "" || len([]rune(filename)) > 255 {
		return InitResult{}, errors.New("invalid filename")
	}
	if size <= 0 || size > s.MaxSize {
		return InitResult{}, errors.New("invalid media size")
	}
	if !strings.HasPrefix(strings.ToLower(contentType), "video/") {
		return InitResult{}, errors.New("content type must be video/*")
	}
	mediaID, uploadID := uuid.NewString(), uuid.NewString()
	key := fmt.Sprintf("media/%s/%s/source", owner, mediaID)
	now := s.Now()
	mode := "single"
	if size >= MultipartThreshold {
		mode = "multipart"
	}
	m := model.Media{ID: mediaID, OwnerUserID: owner, ObjectKey: key, OriginalFilename: filename, MIMEType: contentType, SizeBytes: size, Status: "UPLOADING", CreatedAtMs: now.UnixMilli(), UpdatedAtMs: now.UnixMilli()}
	u := model.Upload{ID: uploadID, MediaID: mediaID, Mode: mode, Status: "OPEN", CreatedAtMs: now.UnixMilli(), ExpiresAtMs: now.Add(24 * time.Hour).UnixMilli()}
	var url string
	var err error
	if mode == "single" {
		url, err = s.Objects.PresignPut(ctx, key, contentType, s.UploadTTL)
	} else {
		var sid string
		sid, err = s.Objects.CreateMultipart(ctx, key, contentType)
		if err == nil {
			u.S3UploadID = &sid
		}
	}
	if err != nil {
		return InitResult{}, err
	}
	if err = s.Store.CreateMediaUpload(ctx, m, u); err != nil {
		if u.S3UploadID != nil {
			_ = s.Objects.AbortMultipart(ctx, key, *u.S3UploadID)
		}
		return InitResult{}, err
	}
	r := InitResult{MediaID: mediaID, UploadID: uploadID, Mode: mode, URL: url, ExpiresAtMs: now.Add(s.UploadTTL).UnixMilli()}
	if mode == "multipart" {
		r.PartSizeBytes = PartSizeBytes
	}
	return r, nil
}
func cleanFilename(v string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '/' || r == '\\' {
			return -1
		}
		return r
	}, v))
}
func (s *Service) PartURLs(ctx context.Context, owner, uploadID string, parts []int32) (map[int32]string, error) {
	u, m, err := s.Store.UploadByID(ctx, uploadID)
	if err != nil {
		return nil, err
	}
	if m.OwnerUserID != owner {
		return nil, errors.New("FORBIDDEN")
	}
	if u.Mode != "multipart" || u.S3UploadID == nil || u.Status != "OPEN" {
		return nil, errors.New("invalid upload")
	}
	if len(parts) == 0 || len(parts) > 100 {
		return nil, errors.New("invalid parts")
	}
	out := map[int32]string{}
	for _, p := range parts {
		if p < 1 || p > 10000 {
			return nil, errors.New("invalid part number")
		}
		url, e := s.Objects.PresignPart(ctx, m.ObjectKey, *u.S3UploadID, p, s.UploadTTL)
		if e != nil {
			return nil, e
		}
		out[p] = url
	}
	return out, nil
}
func (s *Service) Complete(ctx context.Context, owner, uploadID string, parts []s3store.CompletedPart) error {
	u, m, err := s.Store.UploadByID(ctx, uploadID)
	if err != nil {
		return err
	}
	if m.OwnerUserID != owner {
		return errors.New("FORBIDDEN")
	}
	if u.Mode == "multipart" {
		if u.S3UploadID == nil {
			return errors.New("invalid upload")
		}
		expectedParts := int((m.SizeBytes + PartSizeBytes - 1) / PartSizeBytes)
		if len(parts) != expectedParts {
			return fmt.Errorf("expected %d parts", expectedParts)
		}
		seen := make(map[int32]struct{}, len(parts))
		for _, part := range parts {
			if part.PartNumber < 1 || int(part.PartNumber) > expectedParts || strings.TrimSpace(part.ETag) == "" {
				return errors.New("invalid completed part")
			}
			if _, duplicate := seen[part.PartNumber]; duplicate {
				return errors.New("duplicate completed part")
			}
			seen[part.PartNumber] = struct{}{}
		}
		slices.SortFunc(parts, func(a, b s3store.CompletedPart) int { return int(a.PartNumber - b.PartNumber) })
		if err = s.Objects.CompleteMultipart(ctx, m.ObjectKey, *u.S3UploadID, parts); err != nil {
			return err
		}
	}
	head, err := s.Objects.Head(ctx, m.ObjectKey)
	if err != nil {
		return err
	}
	if head.Size != m.SizeBytes {
		_ = s.Objects.Delete(ctx, m.ObjectKey)
		_ = s.Store.FailUpload(ctx, uploadID, s.Now().UnixMilli())
		return fmt.Errorf("size mismatch: expected %d got %d", m.SizeBytes, head.Size)
	}
	return s.Store.CompleteUpload(ctx, uploadID, s.Now().UnixMilli())
}
func (s *Service) Abort(ctx context.Context, owner, uploadID string) error {
	u, m, err := s.Store.UploadByID(ctx, uploadID)
	if err != nil {
		return err
	}
	if m.OwnerUserID != owner {
		return errors.New("FORBIDDEN")
	}
	if u.S3UploadID != nil {
		if err = s.Objects.AbortMultipart(ctx, m.ObjectKey, *u.S3UploadID); err != nil {
			return err
		}
	}
	if err = s.Objects.Delete(ctx, m.ObjectKey); err != nil {
		return err
	}
	return s.Store.FailUpload(ctx, uploadID, s.Now().UnixMilli())
}
func (s *Service) Ticket(ctx context.Context, identity model.Identity, room model.Room) (string, int64, error) {
	if room.MediaID == nil {
		return "", 0, repository.ErrNotFound
	}
	member, err := s.Store.IsMember(ctx, room.ID, identity.ID, identity.Guest)
	if err != nil || !member {
		return "", 0, errors.New("FORBIDDEN")
	}
	if identity.Guest && identity.RoomID != room.ID {
		return "", 0, errors.New("FORBIDDEN")
	}
	m, err := s.Store.MediaByID(ctx, *room.MediaID)
	if err != nil {
		return "", 0, err
	}
	if m.Status != "READY" {
		return "", 0, errors.New("MEDIA_NOT_READY")
	}
	url, err := s.Objects.PresignGet(ctx, m.ObjectKey, s.MediaTTL)
	if err != nil {
		return "", 0, err
	}
	return url, s.Now().Add(s.MediaTTL).UnixMilli(), nil
}
