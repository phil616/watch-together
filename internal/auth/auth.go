package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/argon2"
	"movie-sync/internal/model"
	"movie-sync/internal/repository"
)

const SessionCookie = "wt_session"
const GuestCookie = "wt_guest"
const CSRFCookie = "wt_csrf"

type Service struct {
	Store  *repository.Store
	TTL    time.Duration
	Secure bool
	Now    func() time.Time
}

func New(store *repository.Store, ttl time.Duration, secure bool) *Service {
	return &Service{Store: store, TTL: ttl, Secure: secure, Now: time.Now}
}

func (s *Service) Register(ctx context.Context, username, password, nickname string) (model.User, error) {
	username = strings.ToLower(strings.TrimSpace(username))
	nickname = strings.TrimSpace(nickname)
	if len(username) < 3 || len(username) > 40 || !identifier(username) {
		return model.User{}, errors.New("username must be 3-40 letters, numbers, dots, dashes or underscores")
	}
	if len([]rune(nickname)) < 1 || len([]rune(nickname)) > 60 {
		return model.User{}, errors.New("nickname must be 1-60 characters")
	}
	if len(password) < 10 || len(password) > 256 {
		return model.User{}, errors.New("password must be 10-256 characters")
	}
	hash, err := HashPassword(password)
	if err != nil {
		return model.User{}, err
	}
	now := s.Now().UnixMilli()
	u := model.User{ID: uuid.NewString(), Username: username, Nickname: nickname, CreatedAtMs: now}
	if err = s.Store.CreateUser(ctx, u, hash, now); err != nil {
		return model.User{}, err
	}
	return u, nil
}
func identifier(s string) bool {
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' || r == '-' || r == '.') {
			return false
		}
	}
	return true
}

func (s *Service) Login(ctx context.Context, username, password, ip, ua string) (model.User, string, string, error) {
	u, hash, err := s.Store.UserByUsername(ctx, strings.ToLower(strings.TrimSpace(username)))
	if err != nil {
		return model.User{}, "", "", errors.New("invalid credentials")
	}
	ok, err := VerifyPassword(password, hash)
	if err != nil || !ok {
		return model.User{}, "", "", errors.New("invalid credentials")
	}
	token, err := randomToken(32)
	if err != nil {
		return model.User{}, "", "", err
	}
	csrf, err := randomToken(32)
	if err != nil {
		return model.User{}, "", "", err
	}
	now := s.Now().UnixMilli()
	if err = s.Store.CreateSession(ctx, uuid.NewString(), u.ID, TokenHash(token), TokenHash(csrf), now+s.TTL.Milliseconds(), now, ip, ua); err != nil {
		return model.User{}, "", "", err
	}
	return u, token, csrf, nil
}
func (s *Service) Authenticate(ctx context.Context, r *http.Request) (model.Identity, string, error) {
	if c, err := r.Cookie(SessionCookie); err == nil {
		identity, csrf, e := s.Store.SessionIdentity(ctx, TokenHash(c.Value), s.Now().UnixMilli())
		if e == nil {
			s.Store.TouchSession(ctx, TokenHash(c.Value), s.Now().UnixMilli())
			return identity, csrf, nil
		}
	}
	if c, err := r.Cookie(GuestCookie); err == nil {
		return s.Store.GuestIdentity(ctx, TokenHash(c.Value), s.Now().UnixMilli())
	}
	return model.Identity{}, "", repository.ErrNotFound
}
func (s *Service) Logout(ctx context.Context, r *http.Request) error {
	c, err := r.Cookie(SessionCookie)
	if err != nil {
		return nil
	}
	return s.Store.DeleteSession(ctx, TokenHash(c.Value))
}
func (s *Service) SetCookies(w http.ResponseWriter, token, csrf string, expires time.Time, guest bool) {
	name := SessionCookie
	if guest {
		name = GuestCookie
	}
	http.SetCookie(w, &http.Cookie{Name: name, Value: token, Path: "/", Expires: expires, MaxAge: int(time.Until(expires).Seconds()), HttpOnly: true, Secure: s.Secure, SameSite: http.SameSiteLaxMode})
	http.SetCookie(w, &http.Cookie{Name: CSRFCookie, Value: csrf, Path: "/", Expires: expires, MaxAge: int(time.Until(expires).Seconds()), HttpOnly: false, Secure: s.Secure, SameSite: http.SameSiteLaxMode})
}
func (s *Service) ClearCookies(w http.ResponseWriter) {
	for _, n := range []string{SessionCookie, GuestCookie, CSRFCookie} {
		http.SetCookie(w, &http.Cookie{Name: n, Value: "", Path: "/", MaxAge: -1, HttpOnly: n != CSRFCookie, Secure: s.Secure, SameSite: http.SameSiteLaxMode})
	}
}
func (s *Service) ValidCSRF(r *http.Request, storedHash string) bool {
	cookie, err := r.Cookie(CSRFCookie)
	if err != nil {
		return false
	}
	header := r.Header.Get("X-CSRF-Token")
	return header != "" && subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(header)) == 1 && subtle.ConstantTimeCompare([]byte(TokenHash(header)), []byte(storedHash)) == 1
}

func HashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash := argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32)
	return fmt.Sprintf("$argon2id$v=19$m=65536,t=3,p=2$%s$%s", base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(hash)), nil
}
func VerifyPassword(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errors.New("invalid password hash")
	}
	var memory uint32
	var iterations uint32
	var parallelism uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &parallelism); err != nil {
		return false, err
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, err
	}
	expected, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, err
	}
	actual := argon2.IDKey([]byte(password), salt, iterations, memory, parallelism, uint32(len(expected)))
	return subtle.ConstantTimeCompare(actual, expected) == 1, nil
}
func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func NewToken() (string, error) { return randomToken(32) }
func TokenHash(token string) string {
	h := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(h[:])
}
func RemoteIP(r *http.Request) string {
	v := r.RemoteAddr
	if h := r.Header.Get("X-Forwarded-For"); h != "" {
		v = strings.TrimSpace(strings.Split(h, ",")[0])
	}
	if i := strings.LastIndex(v, ":"); i > 0 {
		if _, e := strconv.Atoi(v[i+1:]); e == nil {
			return strings.Trim(v[:i], "[]")
		}
	}
	return v
}
