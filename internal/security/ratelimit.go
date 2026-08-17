package security

import (
	"sync"
	"time"
)

type bucket struct {
	tokens float64
	last   time.Time
}
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	rate    float64
	burst   float64
	now     func() time.Time
}

func NewLimiter(events int, per time.Duration, burst int) *Limiter {
	return &Limiter{buckets: map[string]*bucket{}, rate: float64(events) / per.Seconds(), burst: float64(burst), now: time.Now}
}
func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b := l.buckets[key]
	if b == nil {
		l.buckets[key] = &bucket{tokens: l.burst - 1, last: now}
		return true
	}
	b.tokens += now.Sub(b.last).Seconds() * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
func (l *Limiter) Cleanup(maxIdle time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	cut := l.now().Add(-maxIdle)
	for k, b := range l.buckets {
		if b.last.Before(cut) {
			delete(l.buckets, k)
		}
	}
}
