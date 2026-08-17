package httpapi

import (
	"net/http/httptest"
	"testing"
)

func TestOriginAllowedAcceptsActualSameOriginHost(t *testing.T) {
	server := &Server{Origins: []string{"http://localhost:8080"}}

	sameOrigin := httptest.NewRequest("POST", "http://127.0.0.1:8080/api", nil)
	sameOrigin.Host = "127.0.0.1:8080"
	sameOrigin.Header.Set("Origin", "http://127.0.0.1:8080")
	if !server.originAllowed(sameOrigin) {
		t.Fatal("actual same-origin request was rejected because it was not in the configured aliases")
	}

	crossOrigin := httptest.NewRequest("POST", "http://127.0.0.1:8080/api", nil)
	crossOrigin.Host = "127.0.0.1:8080"
	crossOrigin.Header.Set("Origin", "https://evil.example")
	if server.originAllowed(crossOrigin) {
		t.Fatal("unconfigured cross-origin request was accepted")
	}
}
