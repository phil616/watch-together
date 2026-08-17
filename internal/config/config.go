package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Environment        string
	BaseURL            string
	ListenAddr         string
	DatabasePath       string
	SessionTTL         time.Duration
	RoomMaxMembers     int
	HostReconnectGrace time.Duration
	MaxMediaSize       int64
	AllowedOrigins     []string
	LogLevel           string
	S3                 S3Config
}

type S3Config struct {
	Endpoint, PublicEndpoint, Region, Bucket, AccessKeyID, SecretAccessKey string
	PathStyle                                                              bool
	UploadURLTTL, MediaURLTTL                                              time.Duration
}

func Load() (Config, error) {
	c := Config{
		Environment: env("APP_ENV", "development"), BaseURL: env("APP_BASE_URL", "http://localhost:8080"),
		ListenAddr: env("HTTP_LISTEN_ADDR", "127.0.0.1:8080"), DatabasePath: env("DATABASE_PATH", "data/application.db"),
		SessionTTL: duration("SESSION_TTL", 30*24*time.Hour), RoomMaxMembers: integer("ROOM_MAX_MEMBERS", 20),
		HostReconnectGrace: time.Duration(integer("HOST_RECONNECT_GRACE_MS", 30000)) * time.Millisecond,
		MaxMediaSize:       int64(integer64("MAX_MEDIA_SIZE_BYTES", 20*1024*1024*1024)), LogLevel: env("LOG_LEVEL", "info"),
		AllowedOrigins: split(env("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:8080")),
		S3: S3Config{Endpoint: os.Getenv("S3_ENDPOINT"), PublicEndpoint: os.Getenv("S3_PUBLIC_ENDPOINT"), Region: env("S3_REGION", "us-east-1"), Bucket: os.Getenv("S3_BUCKET"),
			AccessKeyID: os.Getenv("S3_ACCESS_KEY_ID"), SecretAccessKey: os.Getenv("S3_SECRET_ACCESS_KEY"),
			PathStyle: boolean("S3_PATH_STYLE", false), UploadURLTTL: duration("S3_UPLOAD_URL_TTL", time.Hour), MediaURLTTL: duration("S3_MEDIA_URL_TTL", 6*time.Hour)},
	}
	if _, err := url.ParseRequestURI(c.BaseURL); err != nil {
		return Config{}, fmt.Errorf("APP_BASE_URL: %w", err)
	}
	if c.DatabasePath == "" {
		return Config{}, errors.New("DATABASE_PATH is required")
	}
	if c.RoomMaxMembers < 2 || c.RoomMaxMembers > 100 {
		return Config{}, errors.New("ROOM_MAX_MEMBERS must be between 2 and 100")
	}
	return c, nil
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
func split(v string) []string {
	var out []string
	for _, x := range strings.Split(v, ",") {
		if x = strings.TrimSpace(x); x != "" {
			out = append(out, x)
		}
	}
	return out
}
func integer(key string, fallback int) int {
	v, err := strconv.Atoi(env(key, strconv.Itoa(fallback)))
	if err != nil {
		return fallback
	}
	return v
}
func integer64(key string, fallback int64) int64 {
	v, err := strconv.ParseInt(env(key, strconv.FormatInt(fallback, 10)), 10, 64)
	if err != nil {
		return fallback
	}
	return v
}
func boolean(key string, fallback bool) bool {
	v, err := strconv.ParseBool(env(key, strconv.FormatBool(fallback)))
	if err != nil {
		return fallback
	}
	return v
}
func duration(key string, fallback time.Duration) time.Duration {
	v, err := time.ParseDuration(env(key, fallback.String()))
	if err != nil {
		return fallback
	}
	return v
}
