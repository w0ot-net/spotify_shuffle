package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testSpotifyClientID = "test-client-id"

func testHandler(t *testing.T) http.Handler {
	t.Helper()

	handler, err := newHandler(testSpotifyClientID)
	if err != nil {
		t.Fatalf("newHandler() error = %v", err)
	}
	return handler
}

func TestNewHandlerRequiresSpotifyClientID(t *testing.T) {
	for _, clientID := range []string{"", " \t\n"} {
		if _, err := newHandler(clientID); err == nil {
			t.Errorf("newHandler(%q) error = nil, want configuration error", clientID)
		}
	}
}

func TestAppPage(t *testing.T) {
	for _, path := range []string{"/", "/callback"} {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			recorder := httptest.NewRecorder()

			testHandler(t).ServeHTTP(recorder, req)

			if got, want := recorder.Code, http.StatusOK; got != want {
				t.Fatalf("status code = %d, want %d", got, want)
			}
			if got, want := recorder.Header().Get("Content-Type"), "text/html; charset=utf-8"; got != want {
				t.Errorf("Content-Type = %q, want %q", got, want)
			}
			assertBrowserSecurityHeaders(t, recorder.Header())
			for _, marker := range []string{
				`<meta name="viewport" content="width=device-width, initial-scale=1">`,
				"<h1>TrueShuffle</h1>",
				`id="connect"`,
				`id="logout"`,
				`id="playlists"`,
				`id="track-status"`,
				`id="track-progress"`,
			} {
				if !strings.Contains(recorder.Body.String(), marker) {
					t.Errorf("body does not contain %q", marker)
				}
			}
			// app.js reads the TrueShuffle global while loading, so pure.js
			// must be present and loaded first; both tags existing in the
			// wrong order would pass a containment-only check.
			pureIndex := strings.Index(recorder.Body.String(), `<script src="/pure.js" defer></script>`)
			appIndex := strings.Index(recorder.Body.String(), `<script src="/app.js" defer></script>`)
			if pureIndex == -1 || appIndex == -1 || pureIndex > appIndex {
				t.Errorf("script tags out of order: pure.js index = %d, app.js index = %d", pureIndex, appIndex)
			}
			if strings.Contains(recorder.Body.String(), "<script>") {
				t.Error("body contains an inline script")
			}
		})
	}
}

func TestAppJavaScript(t *testing.T) {
	for path, markers := range map[string][]string{
		"/pure.js": {
			"var TrueShuffle",
			"https://api.spotify.com/v1/me/playlists",
		},
		"/app.js": {
			"spotify_shuffle.oauth.v1",
			"code_challenge_method",
			"https://accounts.spotify.com/api/token",
		},
	} {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			recorder := httptest.NewRecorder()

			testHandler(t).ServeHTTP(recorder, req)

			if got, want := recorder.Code, http.StatusOK; got != want {
				t.Fatalf("status code = %d, want %d", got, want)
			}
			if got, want := recorder.Header().Get("Content-Type"), "text/javascript; charset=utf-8"; got != want {
				t.Errorf("Content-Type = %q, want %q", got, want)
			}
			assertBrowserSecurityHeaders(t, recorder.Header())
			for _, marker := range markers {
				if !strings.Contains(recorder.Body.String(), marker) {
					t.Errorf("body does not contain %q", marker)
				}
			}
		})
	}
}

func TestPublicConfig(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	recorder := httptest.NewRecorder()

	testHandler(t).ServeHTTP(recorder, req)

	if got, want := recorder.Code, http.StatusOK; got != want {
		t.Fatalf("status code = %d, want %d", got, want)
	}
	if got, want := recorder.Header().Get("Content-Type"), "application/json; charset=utf-8"; got != want {
		t.Errorf("Content-Type = %q, want %q", got, want)
	}
	if got, want := recorder.Header().Get("Cache-Control"), "no-store"; got != want {
		t.Errorf("Cache-Control = %q, want %q", got, want)
	}
	assertBrowserSecurityHeaders(t, recorder.Header())

	var config struct {
		SpotifyClientID string `json:"spotify_client_id"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &config); err != nil {
		t.Fatalf("decode config: %v", err)
	}
	if got, want := config.SpotifyClientID, testSpotifyClientID; got != want {
		t.Errorf("spotify_client_id = %q, want %q", got, want)
	}
}

func TestAppRoutesAreExact(t *testing.T) {
	for _, path := range []string{"/callback/", "/pure.js/", "/app.js/", "/api/config/"} {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			recorder := httptest.NewRecorder()

			testHandler(t).ServeHTTP(recorder, req)

			if got, want := recorder.Code, http.StatusNotFound; got != want {
				t.Errorf("status code = %d, want %d", got, want)
			}
		})
	}
}

func TestHealthz(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	recorder := httptest.NewRecorder()

	testHandler(t).ServeHTTP(recorder, req)

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

// The header assertion below compares against the policy constant, so it
// cannot detect a wrong value. Pin the connection sources the browser app
// actually requires.
func TestContentSecurityPolicyConnectSources(t *testing.T) {
	const want = "connect-src 'self' https://accounts.spotify.com https://api.spotify.com;"
	if !strings.Contains(contentSecurityPolicy, want) {
		t.Errorf("Content-Security-Policy = %q, want it to contain %q", contentSecurityPolicy, want)
	}
}

func assertBrowserSecurityHeaders(t *testing.T, header http.Header) {
	t.Helper()

	if got, want := header.Get("Content-Security-Policy"), contentSecurityPolicy; got != want {
		t.Errorf("Content-Security-Policy = %q, want %q", got, want)
	}
	if got, want := header.Get("Referrer-Policy"), "no-referrer"; got != want {
		t.Errorf("Referrer-Policy = %q, want %q", got, want)
	}
	if got, want := header.Get("X-Content-Type-Options"), "nosniff"; got != want {
		t.Errorf("X-Content-Type-Options = %q, want %q", got, want)
	}
}
