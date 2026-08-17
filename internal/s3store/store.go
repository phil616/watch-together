package s3store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"movie-sync/internal/config"
)

var ErrNotConfigured = errors.New("object storage is not configured")

type CompletedPart struct {
	PartNumber int32  `json:"partNumber"`
	ETag       string `json:"etag"`
}
type Head struct {
	Size        int64
	ContentType string
}
type ObjectStore interface {
	PresignPut(context.Context, string, string, time.Duration) (string, error)
	CreateMultipart(context.Context, string, string) (string, error)
	PresignPart(context.Context, string, string, int32, time.Duration) (string, error)
	CompleteMultipart(context.Context, string, string, []CompletedPart) error
	AbortMultipart(context.Context, string, string) error
	Head(context.Context, string) (Head, error)
	PresignGet(context.Context, string, time.Duration) (string, error)
	Delete(context.Context, string) error
	Doctor(context.Context) error
}

type S3Store struct {
	client  *s3.Client
	presign *s3.PresignClient
	bucket  string
}

func New(ctx context.Context, c config.S3Config) (ObjectStore, error) {
	if c.Bucket == "" || c.AccessKeyID == "" || c.SecretAccessKey == "" {
		return Disabled{}, nil
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(c.Region), awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(c.AccessKeyID, c.SecretAccessKey, "")))
	if err != nil {
		return nil, err
	}
	newClient := func(endpoint string) *s3.Client {
		return s3.NewFromConfig(cfg, func(o *s3.Options) {
			o.UsePathStyle = c.PathStyle
			if endpoint != "" {
				o.BaseEndpoint = aws.String(endpoint)
			}
		})
	}
	client := newClient(c.Endpoint)
	presignClient := client
	if c.PublicEndpoint != "" {
		presignClient = newClient(c.PublicEndpoint)
	}
	return &S3Store{client: client, presign: s3.NewPresignClient(presignClient), bucket: c.Bucket}, nil
}
func (s *S3Store) PresignPut(ctx context.Context, key, contentType string, ttl time.Duration) (string, error) {
	r, err := s.presign.PresignPutObject(ctx, &s3.PutObjectInput{Bucket: &s.bucket, Key: &key, ContentType: &contentType}, func(o *s3.PresignOptions) { o.Expires = ttl })
	if err != nil {
		return "", err
	}
	return r.URL, nil
}
func (s *S3Store) CreateMultipart(ctx context.Context, key, contentType string) (string, error) {
	r, err := s.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{Bucket: &s.bucket, Key: &key, ContentType: &contentType})
	if err != nil {
		return "", err
	}
	return aws.ToString(r.UploadId), nil
}
func (s *S3Store) PresignPart(ctx context.Context, key, uploadID string, part int32, ttl time.Duration) (string, error) {
	r, err := s.presign.PresignUploadPart(ctx, &s3.UploadPartInput{Bucket: &s.bucket, Key: &key, UploadId: &uploadID, PartNumber: &part}, func(o *s3.PresignOptions) { o.Expires = ttl })
	if err != nil {
		return "", err
	}
	return r.URL, nil
}
func (s *S3Store) CompleteMultipart(ctx context.Context, key, uploadID string, parts []CompletedPart) error {
	completed := make([]types.CompletedPart, len(parts))
	for i, p := range parts {
		completed[i] = types.CompletedPart{PartNumber: &p.PartNumber, ETag: &p.ETag}
	}
	_, err := s.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{Bucket: &s.bucket, Key: &key, UploadId: &uploadID, MultipartUpload: &types.CompletedMultipartUpload{Parts: completed}})
	return err
}
func (s *S3Store) AbortMultipart(ctx context.Context, key, uploadID string) error {
	_, err := s.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{Bucket: &s.bucket, Key: &key, UploadId: &uploadID})
	return err
}
func (s *S3Store) Head(ctx context.Context, key string) (Head, error) {
	r, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &s.bucket, Key: &key})
	if err != nil {
		return Head{}, err
	}
	return Head{Size: aws.ToInt64(r.ContentLength), ContentType: aws.ToString(r.ContentType)}, nil
}
func (s *S3Store) PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error) {
	r, err := s.presign.PresignGetObject(ctx, &s3.GetObjectInput{Bucket: &s.bucket, Key: &key}, func(o *s3.PresignOptions) { o.Expires = ttl })
	if err != nil {
		return "", err
	}
	return r.URL, nil
}
func (s *S3Store) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &s.bucket, Key: &key})
	return err
}
func (s *S3Store) Doctor(ctx context.Context) error {
	_, err := s.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: &s.bucket})
	return err
}

type Disabled struct{}

func (Disabled) err() error { return ErrNotConfigured }
func (d Disabled) PresignPut(context.Context, string, string, time.Duration) (string, error) {
	return "", d.err()
}
func (d Disabled) CreateMultipart(context.Context, string, string) (string, error) {
	return "", d.err()
}
func (d Disabled) PresignPart(context.Context, string, string, int32, time.Duration) (string, error) {
	return "", d.err()
}
func (d Disabled) CompleteMultipart(context.Context, string, string, []CompletedPart) error {
	return d.err()
}
func (d Disabled) AbortMultipart(context.Context, string, string) error { return d.err() }
func (d Disabled) Head(context.Context, string) (Head, error)           { return Head{}, d.err() }
func (d Disabled) PresignGet(context.Context, string, time.Duration) (string, error) {
	return "", d.err()
}
func (d Disabled) Delete(context.Context, string) error { return d.err() }
func (d Disabled) Doctor(context.Context) error         { return fmt.Errorf("s3: %w", d.err()) }
