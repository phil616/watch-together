package auth

import "testing"

func TestPasswordHash(t *testing.T) {
	hash, err := HashPassword("a-secure-password")
	if err != nil {
		t.Fatal(err)
	}
	if hash == "a-secure-password" {
		t.Fatal("password stored in plaintext")
	}
	ok, err := VerifyPassword("a-secure-password", hash)
	if err != nil || !ok {
		t.Fatalf("verification failed: %v", err)
	}
	ok, _ = VerifyPassword("wrong-password", hash)
	if ok {
		t.Fatal("wrong password accepted")
	}
}
func TestTokenHashIsDeterministicAndOpaque(t *testing.T) {
	a := TokenHash("secret")
	if a == "secret" || a != TokenHash("secret") || a == TokenHash("other") {
		t.Fatal("unexpected token hash behavior")
	}
}
