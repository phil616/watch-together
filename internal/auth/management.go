package auth

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"movie-sync/internal/model"
)

// NormalizeAccount is shared by the local bootstrap command and admin APIs.
func NormalizeAccount(username, nickname string) (string, string, error) {
	username = strings.ToLower(strings.TrimSpace(username))
	nickname = strings.TrimSpace(nickname)
	if len(username) < 3 || len(username) > 40 || !identifier(username) {
		return "", "", errors.New("用户名需为 3–40 位英文字母、数字、点、横线或下划线")
	}
	if len([]rune(nickname)) < 1 || len([]rune(nickname)) > 60 {
		return "", "", errors.New("昵称需为 1–60 个字符")
	}
	return username, nickname, nil
}
func ValidatePassword(password string) error {
	if len(password) < 10 || len(password) > 256 {
		return errors.New("密码需为 10–256 字节")
	}
	return nil
}

// BootstrapAdmin never promotes an existing account or replaces an existing admin.
// The database's partial unique index also enforces this under concurrent starts.
func (s *Service) BootstrapAdmin(ctx context.Context, username, password, nickname string) (model.User, error) {
	username, nickname, err := NormalizeAccount(username, nickname)
	if err != nil {
		return model.User{}, err
	}
	if err = ValidatePassword(password); err != nil {
		return model.User{}, err
	}
	hash, err := HashPassword(password)
	if err != nil {
		return model.User{}, err
	}
	u := model.User{ID: uuid.NewString(), Username: username, Nickname: nickname, Role: model.RoleSuperAdmin, CreatedAtMs: s.Now().UnixMilli()}
	err = s.Store.CreateUser(ctx, u, hash, u.CreatedAtMs)
	return u, err
}
