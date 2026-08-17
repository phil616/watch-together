package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"movie-sync/internal/auth"
	"movie-sync/internal/chat"
	"movie-sync/internal/config"
	"movie-sync/internal/database"
	"movie-sync/internal/httpapi"
	"movie-sync/internal/media"
	"movie-sync/internal/realtime"
	"movie-sync/internal/repository"
	"movie-sync/internal/rooms"
	"movie-sync/internal/s3store"
	"movie-sync/internal/security"
	"movie-sync/internal/webui"
)

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "error", err)
		os.Exit(1)
	}
}
func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	level := slog.LevelInfo
	if strings.EqualFold(cfg.LogLevel, "debug") {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)
	command := "serve"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	ctx := context.Background()
	db, err := database.Open(ctx, cfg.DatabasePath)
	if err != nil {
		return fmt.Errorf("database: %w", err)
	}
	defer db.Close()
	store := repository.New(db)
	if command == "migrate" {
		log.Info("migrations_complete")
		return nil
	}
	objects, err := s3store.New(ctx, cfg.S3)
	if err != nil {
		return fmt.Errorf("object store: %w", err)
	}
	if command == "doctor" {
		if err = store.Ready(ctx); err != nil {
			return err
		}
		if err = objects.Doctor(ctx); err != nil {
			return err
		}
		log.Info("doctor_ok", "database", cfg.DatabasePath, "s3Bucket", cfg.S3.Bucket)
		return nil
	}
	if command != "serve" {
		return fmt.Errorf("unknown command %q (use serve, migrate, or doctor)", command)
	}
	secure := cfg.Environment == "production" || strings.HasPrefix(cfg.BaseURL, "https://")
	authService := auth.New(store, cfg.SessionTTL, secure)
	registry := rooms.NewRegistry(store, cfg.HostReconnectGrace)
	roomService := rooms.NewService(store, registry, cfg.RoomMaxMembers)
	mediaService := media.New(store, objects, cfg.MaxMediaSize, cfg.S3.UploadURLTTL, cfg.S3.MediaURLTTL)
	chatService := chat.New(store, roomService, registry)
	wsHandler := &realtime.Handler{Auth: authService, Rooms: roomService, Registry: registry, Chat: chatService, Origins: cfg.AllowedOrigins, Log: log}
	api := &httpapi.Server{Auth: authService, Store: store, Rooms: roomService, Registry: registry, Media: mediaService, Chat: chatService, Realtime: wsHandler, Objects: objects, Origins: cfg.AllowedOrigins, BaseURL: cfg.BaseURL, Log: log, LoginLimiter: security.NewLimiter(10, time.Minute, 15), ActionLimiter: security.NewLimiter(30, time.Minute, 40)}
	server := &http.Server{Addr: cfg.ListenAddr, Handler: api.Handler(webui.Handler()), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 1 << 20}
	rootCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go maintenance(rootCtx, store, objects, log)
	errCh := make(chan error, 1)
	go func() {
		log.Info("server_started", "address", cfg.ListenAddr, "environment", cfg.Environment)
		errCh <- server.ListenAndServe()
	}()
	select {
	case err = <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-rootCtx.Done():
		log.Info("server_shutdown_started")
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	registry.Shutdown()
	if e := server.Shutdown(shutdownCtx); e != nil {
		return e
	}
	log.Info("server_stopped")
	return nil
}
func maintenance(ctx context.Context, store *repository.Store, objects s3store.ObjectStore, log *slog.Logger) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case now := <-ticker.C:
			if err := store.Cleanup(ctx, now.UnixMilli()); err != nil {
				log.Error("maintenance_failed", "error", err)
			} else {
				log.Info("maintenance_complete")
			}
			uploads, mediaItems, err := store.StaleUploads(ctx, now.UnixMilli())
			if err != nil {
				log.Error("upload_cleanup_query_failed", "error", err)
			} else {
				for i, u := range uploads {
					m := mediaItems[i]
					if u.S3UploadID != nil {
						_ = objects.AbortMultipart(ctx, m.ObjectKey, *u.S3UploadID)
					}
					_ = objects.Delete(ctx, m.ObjectKey)
					if e := store.FailUpload(ctx, u.ID, now.UnixMilli()); e != nil {
						log.Error("upload_cleanup_failed", "uploadId", u.ID, "error", e)
					}
				}
			}
			deletes, err := store.PendingMediaDeletes(ctx)
			if err != nil {
				log.Error("media_delete_query_failed", "error", err)
			} else {
				for _, m := range deletes {
					if e := objects.Delete(ctx, m.ObjectKey); e != nil {
						_ = store.SetMediaDeleteStatus(ctx, m.ID, "DELETE_FAILED", now.UnixMilli())
						log.Error("media_delete_retry_failed", "mediaId", m.ID, "error", e)
					} else {
						_ = store.SetMediaDeleteStatus(ctx, m.ID, "DELETED", now.UnixMilli())
					}
				}
			}
		case <-ctx.Done():
			return
		}
	}
}
