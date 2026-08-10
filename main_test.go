package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

const testSpotifyClientID = "test-client-id"

func testStore(t *testing.T) *telemetryStore {
	t.Helper()

	store, err := openTelemetryStore(filepath.Join(t.TempDir(), "telemetry.sqlite"))
	if err != nil {
		t.Fatalf("openTelemetryStore() error = %v", err)
	}
	t.Cleanup(func() { store.db.Close() })
	return store
}

func testHandler(t *testing.T) http.Handler {
	t.Helper()

	handler, err := newHandler(testSpotifyClientID, testStore(t))
	if err != nil {
		t.Fatalf("newHandler() error = %v", err)
	}
	return handler
}

func TestNewHandlerRequiresSpotifyClientID(t *testing.T) {
	for _, clientID := range []string{"", " \t\n"} {
		if _, err := newHandler(clientID, testStore(t)); err == nil {
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
				`<link rel="stylesheet" href="/styles.css">`,
				"<h1>TrueShuffle</h1>",
				`class="banner"`,
				`id="connect"`,
				`id="background"`,
				`<option value="weave">Weave</option>`,
				`<option value="veil">Veil</option>`,
				`<option value="orbit">Orbit</option>`,
				`<option value="tide">Tide</option>`,
				`<option value="prism">Prism</option>`,
				`id="logout"`,
				`id="playlists"`,
				`id="track-status"`,
				`id="track-progress"`,
				`sees your account.`,
				`Originals are never`,
				`id="wait-status"`,
				`id="cancel"`,
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
			// style-src 'self' forbids inline style; the page keeps its
			// styling in the served sheet, matching the no-inline-script
			// posture above.
			if strings.Contains(recorder.Body.String(), "<style") ||
				strings.Contains(recorder.Body.String(), "style=") {
				t.Error("body contains inline style")
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

func TestStylesheet(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/styles.css", nil)
	recorder := httptest.NewRecorder()

	testHandler(t).ServeHTTP(recorder, req)

	if got, want := recorder.Code, http.StatusOK; got != want {
		t.Fatalf("status code = %d, want %d", got, want)
	}
	if got, want := recorder.Header().Get("Content-Type"), "text/css; charset=utf-8"; got != want {
		t.Errorf("Content-Type = %q, want %q", got, want)
	}
	assertBrowserSecurityHeaders(t, recorder.Header())
	if recorder.Body.Len() == 0 {
		t.Error("stylesheet body is empty")
	}
	for _, marker := range []string{
		`url("/background-weave.jpg")`,
		`url("/background-veil.jpg")`,
		`url("/background-orbit.jpg")`,
		`url("/background-tide.jpg")`,
		`url("/background-prism.jpg")`,
	} {
		if !strings.Contains(recorder.Body.String(), marker) {
			t.Errorf("stylesheet does not contain %q", marker)
		}
	}
}

func TestBackgroundSVG(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/background.svg", nil)
	recorder := httptest.NewRecorder()

	testHandler(t).ServeHTTP(recorder, req)

	if got, want := recorder.Code, http.StatusOK; got != want {
		t.Fatalf("status code = %d, want %d", got, want)
	}
	if got, want := recorder.Header().Get("Content-Type"), "image/svg+xml; charset=utf-8"; got != want {
		t.Errorf("Content-Type = %q, want %q", got, want)
	}
	assertBrowserSecurityHeaders(t, recorder.Header())
	if !strings.Contains(recorder.Body.String(), "<svg") {
		t.Error("body is not an SVG document")
	}
}

func TestBackgroundJPEGs(t *testing.T) {
	for _, path := range []string{
		"/background-weave.jpg",
		"/background-veil.jpg",
		"/background-orbit.jpg",
		"/background-tide.jpg",
		"/background-prism.jpg",
	} {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			recorder := httptest.NewRecorder()

			testHandler(t).ServeHTTP(recorder, req)

			if got, want := recorder.Code, http.StatusOK; got != want {
				t.Fatalf("status code = %d, want %d", got, want)
			}
			if got, want := recorder.Header().Get("Content-Type"), "image/jpeg"; got != want {
				t.Errorf("Content-Type = %q, want %q", got, want)
			}
			assertBrowserSecurityHeaders(t, recorder.Header())
			if !bytes.HasPrefix(recorder.Body.Bytes(), []byte{0xff, 0xd8, 0xff}) {
				t.Error("body does not have a JPEG signature")
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
	for _, path := range []string{
		"/callback/",
		"/pure.js/",
		"/app.js/",
		"/styles.css/",
		"/background.svg/",
		"/background-weave.jpg/",
		"/background-veil.jpg/",
		"/background-orbit.jpg/",
		"/background-tide.jpg/",
		"/background-prism.jpg/",
		"/api/config/",
	} {
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

func TestContentSecurityPolicyStyleSource(t *testing.T) {
	// The first-party stylesheet loads only with an explicit style-src; no
	// inline style or third-party origin is permitted.
	if !strings.Contains(contentSecurityPolicy, "style-src 'self';") {
		t.Errorf("Content-Security-Policy = %q, want it to contain %q", contentSecurityPolicy, "style-src 'self';")
	}
}

func TestContentSecurityPolicyImageSource(t *testing.T) {
	// The first-party background image loads only with an explicit img-src
	// restricted to this origin; no third-party or data: image is permitted.
	if !strings.Contains(contentSecurityPolicy, "img-src 'self';") {
		t.Errorf("Content-Security-Policy = %q, want it to contain %q", contentSecurityPolicy, "img-src 'self';")
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
