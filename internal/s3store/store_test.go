package s3store

import (
	"context"
	"fmt"
	"movie-sync/internal/config"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestBrowserPresignsDoNotSignEmptyBodyChecksum(t *testing.T) {
	store, err := New(context.Background(), config.S3Config{Endpoint: "https://objects.example", Region: "us-east-1", Bucket: "movies", AccessKeyID: "test", SecretAccessKey: "test", PathStyle: true})
	if err != nil {
		t.Fatal(err)
	}
	put, err := store.PresignPut(context.Background(), "movie", "video/mp4", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	part, err := store.PresignPart(context.Background(), "movie", "upload", 1, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	for _, signed := range []string{put, part} {
		u, err := url.Parse(signed)
		if err != nil {
			t.Fatal(err)
		}
		for key := range u.Query() {
			if strings.Contains(strings.ToLower(key), "checksum") {
				t.Errorf("browser upload unexpectedly requires %s=%s", key, u.Query().Get(key))
			}
		}
	}
}

func TestMultipartDoesNotNegotiateUnsupportedBrowserChecksum(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if algorithm := r.Header.Get("X-Amz-Checksum-Algorithm"); algorithm != "" {
			t.Errorf("unexpected multipart checksum requirement %s", algorithm)
		}
		w.Header().Set("Content-Type", "application/xml")
		fmt.Fprint(w, `<InitiateMultipartUploadResult><Bucket>movies</Bucket><Key>movie</Key><UploadId>upload</UploadId></InitiateMultipartUploadResult>`)
	}))
	defer server.Close()
	store, err := New(context.Background(), config.S3Config{Endpoint: server.URL, Region: "us-east-1", Bucket: "movies", AccessKeyID: "test", SecretAccessKey: "test", PathStyle: true})
	if err != nil {
		t.Fatal(err)
	}
	id, err := store.CreateMultipart(context.Background(), "movie", "video/mp4")
	if err != nil || id != "upload" {
		t.Fatalf("id=%s err=%v", id, err)
	}
}

func TestHealthReportsBucketResponsesWithoutSecrets(t *testing.T) {
	for _, code := range []int{200, 403, 404, 500} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(code) }))
			defer server.Close()
			store, err := New(context.Background(), config.S3Config{Endpoint: server.URL, Region: "us-east-1", Bucket: "movies", AccessKeyID: "private-key", SecretAccessKey: "secret", PathStyle: true})
			if err != nil {
				t.Fatal(err)
			}
			result := CheckHealth(context.Background(), store)
			want := map[int]string{200: "ok", 403: "access_denied", 404: "bucket_not_found", 500: "unavailable"}[code]
			if result.Status != want {
				t.Fatalf("got %+v want %s", result, want)
			}
			if strings.Contains(result.Message, "private-key") || strings.Contains(result.Message, "secret") {
				t.Fatal("health exposed credentials")
			}
		})
	}
	if result := CheckHealth(context.Background(), Disabled{}); result.Status != "not_configured" {
		t.Fatalf("%+v", result)
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	store, err := New(context.Background(), config.S3Config{Endpoint: "https://objects.invalid", Region: "us-east-1", Bucket: "movies", AccessKeyID: "test", SecretAccessKey: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if result := CheckHealth(ctx, store); result.Status != "timeout" {
		t.Fatalf("%+v", result)
	}
}
