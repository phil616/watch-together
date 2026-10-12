package httpapi

import (
	"movie-sync/internal/s3store"
	"net/http"
)

func (s *Server) storageHealth(w http.ResponseWriter, r *http.Request) {
	identity, ok := s.formal(w, r, false)
	if !ok {
		return
	}
	if s.ActionLimiter != nil && !s.ActionLimiter.Allow("storage-health:"+identity.ID) {
		writeError(w, r, http.StatusTooManyRequests, "RATE_LIMITED", "检测过于频繁，请稍后重试")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	result := s3store.CheckHealth(r.Context(), s.Objects)
	// The check itself succeeded even when the dependency is unavailable. Keep
	// its structured status available to authenticated clients.
	writeData(w, http.StatusOK, result)
}
