package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthz(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	recorder := httptest.NewRecorder()

	newHandler().ServeHTTP(recorder, req)

	if got, want := recorder.Code, http.StatusOK; got != want {
		t.Fatalf("status code = %d, want %d", got, want)
	}
	if got, want := recorder.Header().Get("Content-Type"), "text/plain; charset=utf-8"; got != want {
		t.Errorf("Content-Type = %q, want %q", got, want)
	}
	if got, want := recorder.Body.String(), "ok\n"; got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}
