package chat

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"movie-sync/internal/model"
	"movie-sync/internal/repository"
	"movie-sync/internal/rooms"
	"movie-sync/internal/security"
)

type Service struct {
	Store    *repository.Store
	Rooms    *rooms.Service
	Registry *rooms.Registry
	Limiter  *security.Limiter
	Now      func() time.Time
}

func New(store *repository.Store, roomService *rooms.Service, registry *rooms.Registry) *Service {
	return &Service{Store: store, Rooms: roomService, Registry: registry, Limiter: security.NewLimiter(5, 5*time.Second, 10), Now: time.Now}
}
func (s *Service) Send(ctx context.Context, roomID string, i model.Identity, content string) (model.ChatMessage, error) {
	room, err := s.Rooms.GetFor(ctx, roomID, i)
	if err != nil {
		return model.ChatMessage{}, err
	}
	content = strings.TrimSpace(content)
	n := utf8.RuneCountInString(content)
	if n < 1 || n > 2000 {
		return model.ChatMessage{}, errors.New("MESSAGE_TOO_LARGE")
	}
	if !s.Limiter.Allow(room.ID + ":" + i.ID) {
		return model.ChatMessage{}, errors.New("RATE_LIMITED")
	}
	actor, err := s.Registry.Get(ctx, room.ID)
	if err != nil {
		return model.ChatMessage{}, err
	}
	snap := actor.Snapshot(ctx)
	var position *int64
	if p, ok := snap["playback"].(rooms.PlaybackState); ok {
		v := p.Expected(s.Now().UnixMilli())
		position = &v
	}
	kind := "user"
	if i.Guest {
		kind = "guest"
	}
	m := model.ChatMessage{ID: uuid.NewString(), RoomID: room.ID, SenderID: i.ID, SenderNickname: i.Nickname, SenderKind: kind, Content: content, MediaPositionMs: position, CreatedAtMs: s.Now().UnixMilli()}
	if err = s.Store.SaveChat(ctx, m); err != nil {
		return model.ChatMessage{}, err
	}
	actor.Broadcast(rooms.Envelope{Type: "event.chat.message", Payload: m})
	return m, nil
}
func (s *Service) Typing(ctx context.Context, roomID string, i model.Identity, typing bool) error {
	room, err := s.Rooms.GetFor(ctx, roomID, i)
	if err != nil {
		return err
	}
	actor, err := s.Registry.Get(ctx, room.ID)
	if err != nil {
		return err
	}
	actor.Broadcast(rooms.Envelope{Type: "event.chat.typing", Payload: map[string]any{"memberId": i.ID, "nickname": i.Nickname, "typing": typing, "expiresInMs": 3000}})
	return nil
}
