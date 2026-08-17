package security

import (
	"testing"
	"time"
)

func TestLimiter(t *testing.T) {
	now := time.Unix(0, 0)
	l := NewLimiter(1, time.Second, 2)
	l.now = func() time.Time { return now }
	if !l.Allow("u") || !l.Allow("u") || l.Allow("u") {
		t.Fatal("burst limit incorrect")
	}
	now = now.Add(time.Second)
	if !l.Allow("u") {
		t.Fatal("token did not refill")
	}
}
