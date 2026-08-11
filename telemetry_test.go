package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func validTestReport(id string) telemetryReport {
	status := int64(429)
	seconds := int64(7)
	reason := "QUOTA_EXCEEDED"
	limit := int64(50)
	return telemetryReport{
		ReportID:          id,
		PageSessionID:     "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Kind:              "liked-shuffle",
		ClientStartedAt:   1770000000000,
		ClientEndedAt:     1770000009000,
		DurationMs:        9000,
		SourceDisposition: "network-read",
		TargetDisposition: "created",
		TerminalPhase:     "complete",
		Policy:            "pool-6-v0",
		RequestCount:      2,
		PeakWindowCount:   2,
		DeliveryStorage:   "one-shot",
		Events: []telemetryEvent{
			{
				Role: "liked-fingerprint-open", EndpointClass: "liked-tracks",
				Method: "GET", Attempt: 1, StartedAt: 1770000000100,
				DurationMs: 120, Result: "ok", RetryAfterState: "absent",
				PageLimit: &limit, WindowCount: 1,
			},
			{
				Role: "target-create", EndpointClass: "playlists",
				Method: "POST", Attempt: 1, StartedAt: 1770000000400,
				StartOffsetMs: 300, DurationMs: 90, Result: "http-error",
				Status: &status, RetryAfterState: "valid",
				RetryAfterSeconds: &seconds, Reason: &reason, WindowCount: 2,
			},
		},
	}
}

func reportBody(t *testing.T, report telemetryReport) []byte {
	t.Helper()
	body, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal report: %v", err)
	}
	return body
}

func postReport(handler http.Handler, body []byte, adjust func(*http.Request)) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/api/telemetry", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if adjust != nil {
		adjust(request)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func operationCount(t *testing.T, store *telemetryStore) int {
	t.Helper()
	var count int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM operations").Scan(&count); err != nil {
		t.Fatalf("count operations: %v", err)
	}
	return count
}

func TestTelemetryStoreCreatesSecureDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "telemetry.sqlite")
	store, err := openTelemetryStore(path)
	if err != nil {
		t.Fatalf("openTelemetryStore() error = %v", err)
	}
	var version int
	if err := store.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatalf("user_version: %v", err)
	}
	if version != telemetrySchemaVersion {
		t.Errorf("user_version = %d, want %d", version, telemetrySchemaVersion)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat database: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("database mode = %o, want 0600", info.Mode().Perm())
	}
	store.db.Close()

	reopened, err := openTelemetryStore(path)
	if err != nil {
		t.Fatalf("reopen error = %v", err)
	}
	reopened.db.Close()
}

func TestTelemetryStoreRefusesBadConfiguration(t *testing.T) {
	if _, err := openTelemetryStore(""); err == nil {
		t.Error("empty path: error = nil, want configuration error")
	}
	if _, err := openTelemetryStore(filepath.Join(t.TempDir(), "missing", "t.sqlite")); err == nil {
		t.Error("missing parent: error = nil, want error")
	}

	insecure := filepath.Join(t.TempDir(), "t.sqlite")
	if err := os.WriteFile(insecure, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := openTelemetryStore(insecure); err == nil {
		t.Error("insecure mode: error = nil, want error")
	}

	future := filepath.Join(t.TempDir(), "t.sqlite")
	store, err := openTelemetryStore(future)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec("PRAGMA user_version = 9"); err != nil {
		t.Fatal(err)
	}
	store.db.Close()
	if _, err := openTelemetryStore(future); err == nil {
		t.Error("unknown schema version: error = nil, want error")
	}
}

func TestTelemetryIntakeStoresAndDeduplicates(t *testing.T) {
	store := testStore(t)
	handler, err := newHandler(testSpotifyClientID, store)
	if err != nil {
		t.Fatal(err)
	}
	body := reportBody(t, validTestReport("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"))

	first := postReport(handler, body, nil)
	if first.Code != http.StatusNoContent {
		t.Fatalf("first delivery status = %d (%s), want 204", first.Code, first.Body.String())
	}
	second := postReport(handler, body, nil)
	if second.Code != http.StatusNoContent {
		t.Fatalf("duplicate delivery status = %d, want 204", second.Code)
	}
	if got := operationCount(t, store); got != 1 {
		t.Errorf("operations rows = %d, want 1 after duplicate delivery", got)
	}

	var revision, fingerprint string
	var receivedAt int64
	var hasFailure bool
	err = store.db.QueryRow(
		"SELECT server_revision, client_fingerprint, received_at, has_spotify_failure FROM operations",
	).Scan(&revision, &fingerprint, &receivedAt, &hasFailure)
	if err != nil {
		t.Fatal(err)
	}
	if fingerprint != clientFingerprint(testSpotifyClientID) {
		t.Errorf("client_fingerprint = %q, want the SHA-256 of the configured client id", fingerprint)
	}
	if revision == "" {
		t.Error("server_revision is empty")
	}
	if receivedAt == 0 {
		t.Error("received_at is zero")
	}
	if !hasFailure {
		t.Error("has_spotify_failure = false, want true for a report with a 429 event")
	}
	var events int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM events").Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 2 {
		t.Errorf("events rows = %d, want 2", events)
	}
}

func TestTelemetryIntakeRejectsInvalidInput(t *testing.T) {
	store := testStore(t)
	handler, err := newHandler(testSpotifyClientID, store)
	if err != nil {
		t.Fatal(err)
	}

	valid := validTestReport("cccccccccccccccccccccccccccccccc")
	cases := []struct {
		name   string
		body   []byte
		adjust func(*http.Request)
		want   int
	}{
		{"unknown field", []byte(`{"report_id":"x","surprise":1}`), nil, http.StatusBadRequest},
		{"not json", []byte("report"), nil, http.StatusBadRequest},
		{"trailing content", append(reportBody(t, valid), []byte("{}")...), nil, http.StatusBadRequest},
		{"invalid enum", reportBody(t, func() telemetryReport {
			report := validTestReport("dddddddddddddddddddddddddddddddd")
			report.Kind = "unexpected"
			return report
		}()), nil, http.StatusBadRequest},
		{"retry seconds without valid state", reportBody(t, func() telemetryReport {
			report := validTestReport("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")
			report.Events[0].RetryAfterSeconds = report.Events[1].RetryAfterSeconds
			return report
		}()), nil, http.StatusBadRequest},
		{"wrong content type", reportBody(t, valid), func(request *http.Request) {
			request.Header.Set("Content-Type", "text/plain")
		}, http.StatusUnsupportedMediaType},
		{"oversized body", []byte(`{"report_id":"` + strings.Repeat("a", telemetryMaxBodyBytes) + `"}`), nil, http.StatusRequestEntityTooLarge},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := postReport(handler, testCase.body, testCase.adjust)
			if recorder.Code != testCase.want {
				t.Errorf("status = %d, want %d", recorder.Code, testCase.want)
			}
		})
	}
	if got := operationCount(t, store); got != 0 {
		t.Errorf("operations rows = %d, want 0 after rejected input", got)
	}

	// A 257-event report cannot fit under the 64 KiB body cap over the wire,
	// so the event-count ceiling is defense in depth checked directly.
	tooManyEvents := validTestReport("ffffffffffffffffffffffffffffffff")
	for len(tooManyEvents.Events) <= telemetryMaxEvents {
		tooManyEvents.Events = append(tooManyEvents.Events, tooManyEvents.Events[0])
	}
	if err := validateTelemetryReport(&tooManyEvents); err == nil ||
		!strings.Contains(err.Error(), "too many events") {
		t.Errorf("too many events: error = %v, want rejection", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/telemetry", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET /api/telemetry status = %d, want 405", recorder.Code)
	}

	blocked := validTestReport("0123456789abcdef0123456789abcdef")
	blocked.Events[0].Result = "cooldown-blocked"
	if err := validateTelemetryReport(&blocked); err != nil {
		t.Errorf("cooldown-blocked event rejected: %v", err)
	}

	details := validTestReport("1123456789abcdef0123456789abcdef")
	details.Events[1].Role = "target-details-update"
	details.Events[1].EndpointClass = "playlist-metadata"
	details.Events[1].Method = http.MethodPut
	if err := validateTelemetryReport(&details); err != nil {
		t.Errorf("target-details-update event rejected: %v", err)
	}
}

func TestTelemetryIntakeChecksBrowserProvenance(t *testing.T) {
	handler, err := newHandler(testSpotifyClientID, testStore(t))
	if err != nil {
		t.Fatal(err)
	}
	body := reportBody(t, validTestReport("abababababababababababababababab"))

	crossOrigin := postReport(handler, body, func(request *http.Request) {
		request.Header.Set("Origin", "https://evil.example")
	})
	if crossOrigin.Code != http.StatusForbidden {
		t.Errorf("cross-origin status = %d, want 403", crossOrigin.Code)
	}
	crossSite := postReport(handler, body, func(request *http.Request) {
		request.Header.Set("Sec-Fetch-Site", "cross-site")
	})
	if crossSite.Code != http.StatusForbidden {
		t.Errorf("cross-site status = %d, want 403", crossSite.Code)
	}
	sameOrigin := postReport(handler, body, func(request *http.Request) {
		request.Header.Set("Origin", "http://"+request.Host)
		request.Header.Set("Sec-Fetch-Site", "same-origin")
	})
	if sameOrigin.Code != http.StatusNoContent {
		t.Errorf("same-origin status = %d, want 204", sameOrigin.Code)
	}
}

func TestTelemetryIntakeRateLimit(t *testing.T) {
	handler, err := newHandler(testSpotifyClientID, testStore(t))
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < telemetryIntakePerMinute; index++ {
		report := validTestReport(fmt.Sprintf("%032x", index))
		if recorder := postReport(handler, reportBody(t, report), nil); recorder.Code != http.StatusNoContent {
			t.Fatalf("delivery %d status = %d, want 204", index, recorder.Code)
		}
	}
	over := postReport(handler, reportBody(t, validTestReport(fmt.Sprintf("%032x", telemetryIntakePerMinute))), nil)
	if over.Code != http.StatusTooManyRequests {
		t.Errorf("over-limit status = %d, want 429", over.Code)
	}
}

func TestTelemetryRetentionKeepsDiagnostics(t *testing.T) {
	store := testStore(t)
	store.routineMaxRows = 2
	store.diagnosticMaxRows = 2
	base := time.UnixMilli(1770000000000)

	failure := validTestReport(strings.Repeat("0", 32))
	if _, err := store.insert(&failure, base, "rev", "fp"); err != nil {
		t.Fatal(err)
	}
	for index := 1; index <= 4; index++ {
		routine := validTestReport(fmt.Sprintf("%032x", index))
		routine.Events = []telemetryEvent{failure.Events[0]} // ok-only
		if _, err := store.insert(&routine, base.Add(time.Duration(index)*time.Second), "rev", "fp"); err != nil {
			t.Fatal(err)
		}
	}

	var routineRows, diagnosticRows int
	if err := store.db.QueryRow(
		"SELECT COUNT(*) FROM operations WHERE has_spotify_failure = 0",
	).Scan(&routineRows); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(
		"SELECT COUNT(*) FROM operations WHERE has_spotify_failure = 1",
	).Scan(&diagnosticRows); err != nil {
		t.Fatal(err)
	}
	if routineRows != 2 {
		t.Errorf("routine rows = %d, want 2 after eviction", routineRows)
	}
	if diagnosticRows != 1 {
		t.Errorf("diagnostic rows = %d, want the failure report retained", diagnosticRows)
	}

	aged := validTestReport(strings.Repeat("9", 32))
	aged.Events = []telemetryEvent{failure.Events[0]}
	if _, err := store.insert(&aged, base.Add(40*24*time.Hour), "rev", "fp"); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(
		"SELECT COUNT(*) FROM operations WHERE has_spotify_failure = 0",
	).Scan(&routineRows); err != nil {
		t.Fatal(err)
	}
	if routineRows != 1 {
		t.Errorf("routine rows = %d, want only the fresh report after age eviction", routineRows)
	}

	var orphanEvents int
	if err := store.db.QueryRow(
		"SELECT COUNT(*) FROM events WHERE report_id NOT IN (SELECT report_id FROM operations)",
	).Scan(&orphanEvents); err != nil {
		t.Fatal(err)
	}
	if orphanEvents != 0 {
		t.Errorf("orphan event rows = %d, want cascade deletion", orphanEvents)
	}
}

func TestTelemetryStoreFailureIsolation(t *testing.T) {
	store := testStore(t)
	handler, err := newHandler(testSpotifyClientID, store)
	if err != nil {
		t.Fatal(err)
	}
	store.db.Close()

	recorder := postReport(handler, reportBody(t, validTestReport("cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd")), nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Errorf("store-failure status = %d, want 503", recorder.Code)
	}

	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if health.Code != http.StatusOK {
		t.Errorf("healthz status = %d, want 200 while telemetry storage is down", health.Code)
	}
}
