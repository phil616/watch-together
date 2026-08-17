package rooms

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"movie-sync/internal/auth"
	"movie-sync/internal/model"
	"movie-sync/internal/repository"
)

type Service struct {
	Store      *repository.Store
	Registry   *Registry
	MaxMembers int
	Now        func() time.Time
}

func NewService(store *repository.Store, registry *Registry, max int) *Service {
	return &Service{Store: store, Registry: registry, MaxMembers: max, Now: time.Now}
}
func (s *Service) Create(ctx context.Context, host model.Identity, title string, max int) (model.Room, error) {
	if host.Guest {
		return model.Room{}, ErrNotMember
	}
	title = strings.TrimSpace(title)
	if utf8.RuneCountInString(title) < 1 || utf8.RuneCountInString(title) > 100 {
		return model.Room{}, errors.New("room title must be 1-100 characters")
	}
	if max == 0 {
		max = s.MaxMembers
	}
	if max < 2 || max > s.MaxMembers {
		return model.Room{}, errors.New("invalid max members")
	}
	now := s.Now().UnixMilli()
	for range 5 {
		code, err := roomCode()
		if err != nil {
			return model.Room{}, err
		}
		r := model.Room{ID: uuid.NewString(), Code: code, Title: title, HostUserID: host.ID, Status: "OPEN", JoinPolicy: "INVITE", MaxMembers: max, CreatedAtMs: now, UpdatedAtMs: now}
		if err = s.Store.CreateRoom(ctx, r, now); err == nil {
			return r, nil
		} else if !repository.IsUniqueViolation(err) {
			return model.Room{}, err
		}
	}
	return model.Room{}, errors.New("could not allocate room code")
}
func roomCode() (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, 8)
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	for i := range b {
		b[i] = alphabet[int(raw[i])%len(alphabet)]
	}
	return string(b), nil
}
func (s *Service) GetFor(ctx context.Context, roomRef string, i model.Identity) (model.Room, error) {
	r, err := s.room(ctx, roomRef)
	if err != nil {
		return r, err
	}
	ok, err := s.Store.IsMember(ctx, r.ID, i.ID, i.Guest)
	if err != nil || !ok || (i.Guest && i.RoomID != r.ID) {
		return model.Room{}, ErrNotMember
	}
	return r, nil
}
func (s *Service) room(ctx context.Context, ref string) (model.Room, error) {
	if _, err := uuid.Parse(ref); err == nil {
		return s.Store.RoomByID(ctx, ref)
	}
	return s.Store.RoomByCode(ctx, strings.ToUpper(ref))
}
func (s *Service) Join(ctx context.Context, roomID string, i model.Identity) error {
	if i.Guest {
		return ErrNotMember
	}
	r, err := s.Store.RoomByID(ctx, roomID)
	if err != nil {
		return err
	}
	if r.Status == "CLOSED" {
		return ErrRoomClosed
	}
	if r.JoinPolicy != "OPEN" {
		return errors.New("INVITE_REQUIRED")
	}
	return s.Store.AddMember(ctx, roomID, i.ID, s.Now().UnixMilli())
}
func (s *Service) Leave(ctx context.Context, roomID string, i model.Identity) error {
	r, err := s.GetFor(ctx, roomID, i)
	if err != nil {
		return err
	}
	if r.HostUserID == i.ID {
		return errors.New("HOST_CANNOT_LEAVE")
	}
	if a, e := s.Registry.Get(ctx, r.ID); e == nil {
		a.Leave(i.ID)
	}
	if i.Guest {
		return s.Store.DeleteGuestSession(ctx, r.ID, i.ID)
	}
	return s.Store.LeaveMember(ctx, r.ID, i.ID, s.Now().UnixMilli())
}

func (s *Service) Reopen(ctx context.Context, roomRef string, i model.Identity) (model.Room, error) {
	if i.Guest {
		return model.Room{}, ErrNotMember
	}
	r, err := s.GetFor(ctx, roomRef, i)
	if err != nil {
		return model.Room{}, err
	}
	if r.HostUserID != i.ID {
		return model.Room{}, ErrNotHost
	}
	if r.Status != "CLOSED" {
		return r, nil
	}
	actor, err := s.Registry.Get(ctx, r.ID)
	if err != nil {
		return model.Room{}, err
	}
	if err = actor.Reopen(ctx); err != nil {
		return model.Room{}, err
	}
	return s.Store.RoomByID(ctx, r.ID)
}

type InviteResult struct {
	Token  string       `json:"token"`
	Invite model.Invite `json:"invite"`
	URL    string       `json:"url,omitempty"`
}

func (s *Service) CreateInvite(ctx context.Context, roomID string, i model.Identity, expiresIn time.Duration, maxUses *int) (InviteResult, error) {
	r, err := s.GetFor(ctx, roomID, i)
	if err != nil {
		return InviteResult{}, err
	}
	if r.HostUserID != i.ID {
		return InviteResult{}, ErrNotHost
	}
	if expiresIn <= 0 {
		expiresIn = 24 * time.Hour
	}
	if expiresIn > 30*24*time.Hour {
		return InviteResult{}, errors.New("invite expiry too long")
	}
	if maxUses != nil && (*maxUses < 1 || *maxUses > 1000) {
		return InviteResult{}, errors.New("invalid max uses")
	}
	raw := make([]byte, 32)
	if _, err = rand.Read(raw); err != nil {
		return InviteResult{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	expiry := s.Now().Add(expiresIn).UnixMilli()
	invite := model.Invite{ID: uuid.NewString(), RoomID: r.ID, CreatedBy: i.ID, ExpiresAtMs: &expiry, MaxUses: maxUses, CreatedAtMs: s.Now().UnixMilli()}
	if err = s.Store.CreateInvite(ctx, invite, auth.TokenHash(token)); err != nil {
		return InviteResult{}, err
	}
	return InviteResult{Token: token, Invite: invite}, nil
}
func (s *Service) InviteInfo(ctx context.Context, token string) (model.Invite, model.Room, error) {
	i, err := s.Store.InviteByHash(ctx, auth.TokenHash(token), s.Now().UnixMilli())
	if err != nil {
		return i, model.Room{}, err
	}
	r, err := s.Store.RoomByID(ctx, i.RoomID)
	return i, r, err
}
func (s *Service) JoinInviteUser(ctx context.Context, token string, user model.Identity) (model.Room, error) {
	if user.Guest {
		return model.Room{}, ErrNotMember
	}
	invite, r, err := s.InviteInfo(ctx, token)
	if err != nil {
		return model.Room{}, err
	}
	if r.Status == "CLOSED" {
		return model.Room{}, ErrRoomClosed
	}
	if err = s.Store.ConsumeInvite(ctx, invite.ID); err != nil {
		return model.Room{}, err
	}
	if err = s.Store.AddMember(ctx, r.ID, user.ID, s.Now().UnixMilli()); err != nil {
		return model.Room{}, err
	}
	return r, nil
}
func (s *Service) JoinInviteGuest(ctx context.Context, token, nickname string, ttl time.Duration) (model.Room, string, string, error) {
	nickname = strings.TrimSpace(nickname)
	if utf8.RuneCountInString(nickname) < 1 || utf8.RuneCountInString(nickname) > 60 {
		return model.Room{}, "", "", errors.New("nickname must be 1-60 characters")
	}
	invite, r, err := s.InviteInfo(ctx, token)
	if err != nil {
		return model.Room{}, "", "", err
	}
	if r.Status == "CLOSED" {
		return model.Room{}, "", "", ErrRoomClosed
	}
	if err = s.Store.ConsumeInvite(ctx, invite.ID); err != nil {
		return model.Room{}, "", "", err
	}
	sessionToken, err := auth.NewToken()
	if err != nil {
		return model.Room{}, "", "", err
	}
	csrf, err := auth.NewToken()
	if err != nil {
		return model.Room{}, "", "", err
	}
	now := s.Now()
	if err = s.Store.CreateGuestSession(ctx, uuid.NewString(), r.ID, nickname, auth.TokenHash(sessionToken), auth.TokenHash(csrf), now.Add(ttl).UnixMilli(), now.UnixMilli()); err != nil {
		return model.Room{}, "", "", err
	}
	return r, sessionToken, csrf, nil
}
func (s *Service) Admin(ctx context.Context, roomID string, i model.Identity, command string, payload any) error {
	r, err := s.GetFor(ctx, roomID, i)
	if err != nil {
		return err
	}
	if r.HostUserID != i.ID {
		return ErrNotHost
	}
	body, err := jsonMarshal(payload)
	if err != nil {
		return err
	}
	actor, err := s.Registry.Get(ctx, r.ID)
	if err != nil {
		return err
	}
	_, err = actor.Command(ctx, i, Command{Type: command, Payload: body})
	return err
}
func jsonMarshal(v any) ([]byte, error) { return json.Marshal(v) }
