package media

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"movie-sync/internal/database"
	"movie-sync/internal/model"
	"movie-sync/internal/repository"
	"movie-sync/internal/s3store"
)

type fakeObjects struct {
	size                                 int64
	created, completed, aborted, deleted bool
	completedParts                       []s3store.CompletedPart
}

func (f *fakeObjects) PresignPut(context.Context, string, string, time.Duration) (string, error) {
	return "https://objects.test/put", nil
}
func (f *fakeObjects) CreateMultipart(context.Context, string, string) (string, error) {
	f.created = true
	return "s3-upload", nil
}
func (f *fakeObjects) PresignPart(context.Context, string, string, int32, time.Duration) (string, error) {
	return "https://objects.test/part", nil
}
func (f *fakeObjects) CompleteMultipart(_ context.Context, _, _ string, parts []s3store.CompletedPart) error {
	f.completed = true
	f.completedParts = append([]s3store.CompletedPart(nil), parts...)
	return nil
}
func (f *fakeObjects) AbortMultipart(context.Context, string, string) error {
	f.aborted = true
	return nil
}
func (f *fakeObjects) Head(context.Context, string) (s3store.Head, error) {
	return s3store.Head{Size: f.size}, nil
}
func (f *fakeObjects) PresignGet(context.Context, string, time.Duration) (string, error) {
	return "https://objects.test/get", nil
}
func (f *fakeObjects) Delete(context.Context, string) error { f.deleted = true; return nil }
func (f *fakeObjects) Doctor(context.Context) error         { return nil }
func mediaStore(t *testing.T) *repository.Store {
	t.Helper()
	db, err := database.Open(context.Background(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	s := repository.New(db)
	now := time.Now().UnixMilli()
	if err = s.CreateUser(context.Background(), model.User{ID: "owner", Username: "owner", Nickname: "Owner"}, "hash", now); err != nil {
		t.Fatal(err)
	}
	return s
}
func TestSingleUploadCompletesOnlyAfterHeadSizeMatches(t *testing.T) {
	store := mediaStore(t)
	objects := &fakeObjects{size: 1024}
	svc := New(store, objects, 1<<30, time.Hour, 6*time.Hour)
	init, err := svc.Init(context.Background(), "owner", "movie.mp4", "video/mp4", 1024)
	if err != nil {
		t.Fatal(err)
	}
	if init.Mode != "single" || init.URL == "" {
		t.Fatalf("unexpected init: %+v", init)
	}
	if err = svc.Complete(context.Background(), "owner", init.UploadID, nil); err != nil {
		t.Fatal(err)
	}
	m, err := store.MediaByID(context.Background(), init.MediaID)
	if err != nil || m.Status != "READY" {
		t.Fatalf("media=%+v err=%v", m, err)
	}
}
func TestMultipartUpload(t *testing.T) {
	store := mediaStore(t)
	objects := &fakeObjects{size: MultipartThreshold}
	svc := New(store, objects, 1<<30, time.Hour, 6*time.Hour)
	init, err := svc.Init(context.Background(), "owner", "large.mp4", "video/mp4", MultipartThreshold)
	if err != nil {
		t.Fatal(err)
	}
	if init.Mode != "multipart" || !objects.created {
		t.Fatalf("unexpected init: %+v", init)
	}
	urls, err := svc.PartURLs(context.Background(), "owner", init.UploadID, []int32{1, 2})
	if err != nil || len(urls) != 2 {
		t.Fatalf("urls=%v err=%v", urls, err)
	}
	if err = svc.Complete(context.Background(), "owner", init.UploadID, []s3store.CompletedPart{{PartNumber: 2, ETag: "second"}, {PartNumber: 1, ETag: "first"}}); err != nil || !objects.completed {
		t.Fatalf("complete err=%v", err)
	}
	if objects.completedParts[0].PartNumber != 1 || objects.completedParts[1].PartNumber != 2 {
		t.Fatalf("multipart completion was not sorted: %+v", objects.completedParts)
	}
}

func TestAbortCleansObjectAndMarksUploadFailed(t *testing.T) {
	store := mediaStore(t)
	objects := &fakeObjects{}
	svc := New(store, objects, 1<<30, time.Hour, time.Hour)
	init, err := svc.Init(context.Background(), "owner", "movie.mp4", "video/mp4", 1024)
	if err != nil {
		t.Fatal(err)
	}
	if err = svc.Abort(context.Background(), "owner", init.UploadID); err != nil {
		t.Fatal(err)
	}
	if !objects.deleted {
		t.Fatal("aborted single upload object was not deleted")
	}
	upload, mediaItem, err := store.UploadByID(context.Background(), init.UploadID)
	if err != nil || upload.Status != "ABORTED" || mediaItem.Status != "FAILED" {
		t.Fatalf("upload=%+v media=%+v err=%v", upload, mediaItem, err)
	}
}
func TestUploadRejectsUnsafeInput(t *testing.T) {
	svc := New(mediaStore(t), &fakeObjects{}, 100, time.Hour, time.Hour)
	if _, err := svc.Init(context.Background(), "owner", "../movie.mp4", "video/mp4", 101); err == nil {
		t.Fatal("oversized upload accepted")
	}
	if _, err := svc.Init(context.Background(), "owner", "movie.html", "text/html", 10); err == nil {
		t.Fatal("non-video accepted")
	}
}

func TestUploadOwnershipAndUnrelatedRoomTicket(t *testing.T) {
	store := mediaStore(t)
	ctx := context.Background()
	now := time.Now().UnixMilli()
	if err := store.CreateUser(ctx, model.User{ID: "other", Username: "other", Nickname: "Other"}, "hash", now); err != nil {
		t.Fatal(err)
	}
	objects := &fakeObjects{size: 1024}
	svc := New(store, objects, 1<<30, time.Hour, 6*time.Hour)
	init, err := svc.Init(ctx, "owner", "movie.mp4", "video/mp4", 1024)
	if err != nil {
		t.Fatal(err)
	}
	if err = svc.Complete(ctx, "other", init.UploadID, nil); err == nil || err.Error() != "FORBIDDEN" {
		t.Fatalf("foreign upload completion error=%v", err)
	}
	if err = svc.Complete(ctx, "owner", init.UploadID, nil); err != nil {
		t.Fatal(err)
	}
	mediaID := init.MediaID
	otherRoom := model.Room{ID: "unrelated-room", MediaID: &mediaID}
	if _, _, err = svc.Ticket(ctx, model.Identity{ID: "owner"}, otherRoom); err == nil || err.Error() != "FORBIDDEN" {
		t.Fatalf("unrelated room ticket error=%v", err)
	}
}
