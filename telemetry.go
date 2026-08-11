package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Sanitized rate-limit telemetry: bounded operation reports from the
// browser, stored in one SQLite file. Nothing here may accept or retain
// tokens, account identity, playlist or track identity, raw URLs, or
// response text; the schema has room only for the bounded fields below.

const telemetrySchemaVersion = 1
const telemetryMaxBodyBytes = 64 * 1024
const telemetryMaxEvents = 256
const telemetryIntakePerMinute = 60

// 4096-byte pages capped at 65536 pages bound the main file at 256 MiB.
const telemetryPageSize = 4096
const telemetryMaxPageCount = 65536

var telemetryKinds = enumSet("playlist-list", "playlist-shuffle", "liked-shuffle")
var telemetryDispositions = enumSet(
	"playlist-cache-hit", "liked-fingerprint-hit", "network-read",
	"empty", "capacity-rejected", "not-applicable",
)
var telemetryTargets = enumSet("created", "replaced", "untouched")
var telemetryPhases = enumSet(
	"complete", "listing-failed", "load-failed", "no-tracks",
	"capacity-rejected", "scope-blocked", "write-failed", "abandoned",
)
var telemetryDeliveries = enumSet("one-shot", "indexeddb", "queue-unavailable")
var telemetryRoles = enumSet(
	"playlist-list-page", "playlist-snapshot-pin", "playlist-snapshot-verify",
	"playlist-items-page", "liked-fingerprint-open", "liked-items-page",
	"liked-fingerprint-verify", "target-create", "target-details-update", "target-replace",
	"target-append", "target-total-verify",
)
var telemetryEndpointClasses = enumSet(
	"playlists", "playlist-metadata", "playlist-items", "liked-tracks",
)
var telemetryMethods = enumSet("GET", "POST", "PUT")

// cooldown-blocked marks a request the browser refused locally during a
// stored cooldown; no Spotify request was sent, so it carries no status.
var telemetryResults = enumSet("ok", "http-error", "network-error", "invalid-response", "cooldown-blocked")
var telemetryRetryAfterStates = enumSet("absent", "valid", "invalid")

var hexIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
var policyPattern = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)
var reasonPattern = regexp.MustCompile(`^[A-Z0-9_]{1,40}$`)

func enumSet(values ...string) map[string]bool {
	set := make(map[string]bool, len(values))
	for _, value := range values {
		set[value] = true
	}
	return set
}

type telemetryEvent struct {
	Role              string  `json:"role"`
	EndpointClass     string  `json:"endpoint_class"`
	Method            string  `json:"method"`
	Attempt           int64   `json:"attempt"`
	ScheduledWaitMs   int64   `json:"scheduled_wait_ms"`
	StartedAt         int64   `json:"started_at"`
	StartOffsetMs     int64   `json:"start_offset_ms"`
	DurationMs        int64   `json:"duration_ms"`
	Result            string  `json:"result"`
	Status            *int64  `json:"status"`
	RetryAfterState   string  `json:"retry_after_state"`
	RetryAfterSeconds *int64  `json:"retry_after_seconds"`
	Reason            *string `json:"reason"`
	RequestItems      *int64  `json:"request_items"`
	ResponseItems     *int64  `json:"response_items"`
	PageOffset        *int64  `json:"page_offset"`
	PageLimit         *int64  `json:"page_limit"`
	ServerTotal       *int64  `json:"server_total"`
	WindowCount       int64   `json:"window_count"`
}

type telemetryReport struct {
	ReportID             string           `json:"report_id"`
	PageSessionID        string           `json:"page_session_id"`
	Kind                 string           `json:"kind"`
	ClientStartedAt      int64            `json:"client_started_at"`
	ClientEndedAt        int64            `json:"client_ended_at"`
	DurationMs           int64            `json:"duration_ms"`
	SourceTotal          *int64           `json:"source_total"`
	SourceDisposition    string           `json:"source_disposition"`
	TargetDisposition    string           `json:"target_disposition"`
	TerminalPhase        string           `json:"terminal_phase"`
	Policy               string           `json:"policy"`
	PolicyMinGapMs       int64            `json:"policy_min_gap_ms"`
	PolicyRetryCeiling   int64            `json:"policy_retry_ceiling"`
	RequestCount         int64            `json:"request_count"`
	PeakWindowCount      int64            `json:"peak_window_count"`
	Truncated            bool             `json:"truncated"`
	DeliveryStorage      string           `json:"delivery_storage"`
	ReportsDroppedBefore int64            `json:"reports_dropped_before"`
	Events               []telemetryEvent `json:"events"`
}

func boundedCount(value *int64) bool {
	return value == nil || (*value >= 0 && *value <= 1000000)
}

func validateTelemetryReport(report *telemetryReport) error {
	switch {
	case !hexIDPattern.MatchString(report.ReportID):
		return errors.New("invalid report_id")
	case !hexIDPattern.MatchString(report.PageSessionID):
		return errors.New("invalid page_session_id")
	case !telemetryKinds[report.Kind]:
		return errors.New("invalid kind")
	case report.ClientStartedAt <= 0 || report.ClientEndedAt <= 0:
		return errors.New("invalid client times")
	case report.DurationMs < 0 || report.DurationMs > 24*60*60*1000:
		return errors.New("invalid duration")
	case !boundedCount(report.SourceTotal):
		return errors.New("invalid source_total")
	case !telemetryDispositions[report.SourceDisposition]:
		return errors.New("invalid source_disposition")
	case !telemetryTargets[report.TargetDisposition]:
		return errors.New("invalid target_disposition")
	case !telemetryPhases[report.TerminalPhase]:
		return errors.New("invalid terminal_phase")
	case !policyPattern.MatchString(report.Policy):
		return errors.New("invalid policy")
	case report.PolicyMinGapMs < 0 || report.PolicyMinGapMs > 600000:
		return errors.New("invalid policy_min_gap_ms")
	case report.PolicyRetryCeiling < 0 || report.PolicyRetryCeiling > 10:
		return errors.New("invalid policy_retry_ceiling")
	case report.RequestCount < 0 || report.RequestCount > 1000000:
		return errors.New("invalid request_count")
	case report.PeakWindowCount < 0 || report.PeakWindowCount > 1000000:
		return errors.New("invalid peak_window_count")
	case !telemetryDeliveries[report.DeliveryStorage]:
		return errors.New("invalid delivery_storage")
	case report.ReportsDroppedBefore < 0 || report.ReportsDroppedBefore > 1000:
		return errors.New("invalid reports_dropped_before")
	case len(report.Events) > telemetryMaxEvents:
		return errors.New("too many events")
	}
	for index := range report.Events {
		event := &report.Events[index]
		switch {
		case !telemetryRoles[event.Role]:
			return errors.New("invalid event role")
		case !telemetryEndpointClasses[event.EndpointClass]:
			return errors.New("invalid event endpoint_class")
		case !telemetryMethods[event.Method]:
			return errors.New("invalid event method")
		case event.Attempt < 1 || event.Attempt > 10:
			return errors.New("invalid event attempt")
		case event.ScheduledWaitMs < 0 || event.ScheduledWaitMs > 600000:
			return errors.New("invalid event scheduled_wait_ms")
		case event.StartedAt <= 0:
			return errors.New("invalid event started_at")
		case event.StartOffsetMs < 0 || event.StartOffsetMs > 24*60*60*1000:
			return errors.New("invalid event start_offset_ms")
		case event.DurationMs < 0 || event.DurationMs > 24*60*60*1000:
			return errors.New("invalid event duration_ms")
		case !telemetryResults[event.Result]:
			return errors.New("invalid event result")
		case event.Status != nil && (*event.Status < 100 || *event.Status > 599):
			return errors.New("invalid event status")
		case !telemetryRetryAfterStates[event.RetryAfterState]:
			return errors.New("invalid event retry_after_state")
		case event.RetryAfterSeconds != nil && event.RetryAfterState != "valid":
			return errors.New("retry_after_seconds without a valid state")
		case event.RetryAfterSeconds != nil && (*event.RetryAfterSeconds < 0 || *event.RetryAfterSeconds > 999999):
			return errors.New("invalid event retry_after_seconds")
		case event.Reason != nil && !reasonPattern.MatchString(*event.Reason):
			return errors.New("invalid event reason")
		case !boundedCount(event.RequestItems) || !boundedCount(event.ResponseItems) ||
			!boundedCount(event.PageOffset) || !boundedCount(event.PageLimit) ||
			!boundedCount(event.ServerTotal):
			return errors.New("invalid event workload count")
		case event.WindowCount < 1 || event.WindowCount > 1000000:
			return errors.New("invalid event window_count")
		}
	}
	return nil
}

func reportHasSpotifyFailure(report *telemetryReport) bool {
	for index := range report.Events {
		if report.Events[index].Result != "ok" {
			return true
		}
	}
	return false
}

type telemetryStore struct {
	db *sql.DB
	// Retention ceilings are fields so tests can tighten them; the defaults
	// are the production policy.
	routineMaxAge     time.Duration
	routineMaxRows    int
	diagnosticMaxAge  time.Duration
	diagnosticMaxRows int
}

const telemetrySchema = `
CREATE TABLE operations (
  report_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  server_revision TEXT NOT NULL,
  client_fingerprint TEXT NOT NULL,
  page_session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  client_started_at INTEGER NOT NULL,
  client_ended_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  source_total INTEGER,
  source_disposition TEXT NOT NULL,
  target_disposition TEXT NOT NULL,
  terminal_phase TEXT NOT NULL,
  policy TEXT NOT NULL,
  policy_min_gap_ms INTEGER NOT NULL,
  policy_retry_ceiling INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  peak_window_count INTEGER NOT NULL,
  truncated INTEGER NOT NULL,
  delivery_storage TEXT NOT NULL,
  reports_dropped_before INTEGER NOT NULL,
  has_spotify_failure INTEGER NOT NULL
);
CREATE TABLE events (
  report_id TEXT NOT NULL REFERENCES operations(report_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  endpoint_class TEXT NOT NULL,
  method TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  scheduled_wait_ms INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  start_offset_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  result TEXT NOT NULL,
  status INTEGER,
  retry_after_state TEXT NOT NULL,
  retry_after_seconds INTEGER,
  reason TEXT,
  request_items INTEGER,
  response_items INTEGER,
  page_offset INTEGER,
  page_limit INTEGER,
  server_total INTEGER,
  window_count INTEGER NOT NULL,
  PRIMARY KEY (report_id, seq)
);
CREATE INDEX operations_received_at ON operations(received_at);
CREATE INDEX operations_client_started_at ON operations(client_started_at);
CREATE INDEX events_status ON events(status);
CREATE INDEX events_role ON events(role);
CREATE INDEX events_endpoint_class ON events(endpoint_class);
CREATE INDEX events_reason ON events(reason);
`

func openTelemetryStore(path string) (*telemetryStore, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("TELEMETRY_DB_PATH is required")
	}
	parent := filepath.Dir(path)
	parentInfo, err := os.Stat(parent)
	if err != nil {
		return nil, fmt.Errorf("telemetry database parent: %w", err)
	}
	if !parentInfo.IsDir() {
		return nil, fmt.Errorf("telemetry database parent %s is not a directory", parent)
	}
	existing, err := os.Stat(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("telemetry database: %w", err)
	}
	if err == nil && existing.Mode().Perm() != 0o600 {
		return nil, fmt.Errorf("telemetry database %s must be mode 0600", path)
	}

	db, err := sql.Open("sqlite",
		"file:"+path+"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	store := &telemetryStore{
		db:                db,
		routineMaxAge:     30 * 24 * time.Hour,
		routineMaxRows:    2000,
		diagnosticMaxAge:  90 * 24 * time.Hour,
		diagnosticMaxRows: 500,
	}
	if err := store.initialize(); err != nil {
		db.Close()
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		db.Close()
		return nil, fmt.Errorf("telemetry database mode: %w", err)
	}
	return store, nil
}

func (store *telemetryStore) initialize() error {
	if _, err := store.db.Exec(fmt.Sprintf("PRAGMA page_size = %d", telemetryPageSize)); err != nil {
		return err
	}
	if _, err := store.db.Exec(fmt.Sprintf("PRAGMA max_page_count = %d", telemetryMaxPageCount)); err != nil {
		return err
	}
	var version int
	if err := store.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	switch version {
	case 0:
		transaction, err := store.db.Begin()
		if err != nil {
			return err
		}
		if _, err := transaction.Exec(telemetrySchema); err != nil {
			transaction.Rollback()
			return err
		}
		if _, err := transaction.Exec(fmt.Sprintf("PRAGMA user_version = %d", telemetrySchemaVersion)); err != nil {
			transaction.Rollback()
			return err
		}
		return transaction.Commit()
	case telemetrySchemaVersion:
		return nil
	default:
		return fmt.Errorf("telemetry database has unknown schema version %d", version)
	}
}

// insert stores one report atomically with retention applied in the same
// transaction: routine successes cannot evict retained Spotify failures.
// A duplicate report_id is acknowledged without a second row.
func (store *telemetryStore) insert(report *telemetryReport, receivedAt time.Time, revision, fingerprint string) (bool, error) {
	transaction, err := store.db.Begin()
	if err != nil {
		return false, err
	}
	defer transaction.Rollback()

	var exists int
	err = transaction.QueryRow(
		"SELECT COUNT(*) FROM operations WHERE report_id = ?", report.ReportID,
	).Scan(&exists)
	if err != nil {
		return false, err
	}
	if exists > 0 {
		return true, nil
	}

	failure := reportHasSpotifyFailure(report)
	_, err = transaction.Exec(`INSERT INTO operations (
      report_id, received_at, server_revision, client_fingerprint,
      page_session_id, kind, client_started_at, client_ended_at, duration_ms,
      source_total, source_disposition, target_disposition, terminal_phase,
      policy, policy_min_gap_ms, policy_retry_ceiling, request_count,
      peak_window_count, truncated, delivery_storage, reports_dropped_before,
      has_spotify_failure
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		report.ReportID, receivedAt.UnixMilli(), revision, fingerprint,
		report.PageSessionID, report.Kind, report.ClientStartedAt,
		report.ClientEndedAt, report.DurationMs, report.SourceTotal,
		report.SourceDisposition, report.TargetDisposition, report.TerminalPhase,
		report.Policy, report.PolicyMinGapMs, report.PolicyRetryCeiling,
		report.RequestCount, report.PeakWindowCount, report.Truncated,
		report.DeliveryStorage, report.ReportsDroppedBefore, failure,
	)
	if err != nil {
		return false, err
	}
	for index := range report.Events {
		event := &report.Events[index]
		_, err = transaction.Exec(`INSERT INTO events (
        report_id, seq, role, endpoint_class, method, attempt,
        scheduled_wait_ms, started_at, start_offset_ms, duration_ms, result,
        status, retry_after_state, retry_after_seconds, reason, request_items,
        response_items, page_offset, page_limit, server_total, window_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			report.ReportID, index, event.Role, event.EndpointClass, event.Method,
			event.Attempt, event.ScheduledWaitMs, event.StartedAt,
			event.StartOffsetMs, event.DurationMs, event.Result, event.Status,
			event.RetryAfterState, event.RetryAfterSeconds, event.Reason,
			event.RequestItems, event.ResponseItems, event.PageOffset,
			event.PageLimit, event.ServerTotal, event.WindowCount,
		)
		if err != nil {
			return false, err
		}
	}

	for _, retention := range []struct {
		failure bool
		maxAge  time.Duration
		maxRows int
	}{
		{false, store.routineMaxAge, store.routineMaxRows},
		{true, store.diagnosticMaxAge, store.diagnosticMaxRows},
	} {
		_, err = transaction.Exec(`DELETE FROM operations
      WHERE has_spotify_failure = ? AND (received_at < ? OR report_id IN (
        SELECT report_id FROM operations WHERE has_spotify_failure = ?
        ORDER BY received_at DESC, report_id DESC LIMIT -1 OFFSET ?))`,
			retention.failure, receivedAt.Add(-retention.maxAge).UnixMilli(),
			retention.failure, retention.maxRows,
		)
		if err != nil {
			return false, err
		}
	}
	return false, transaction.Commit()
}

func serverRevision() string {
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, setting := range info.Settings {
			if setting.Key == "vcs.revision" {
				return setting.Value
			}
		}
	}
	return "unknown"
}

func clientFingerprint(spotifyClientID string) string {
	digest := sha256.Sum256([]byte(spotifyClientID))
	return hex.EncodeToString(digest[:])
}

// sameOriginViolation applies the provenance checks that browser-supplied
// headers allow: they bound accidental and browser-originated pollution but
// do not pretend a public client is authenticated.
func sameOriginViolation(request *http.Request) bool {
	if site := request.Header.Get("Sec-Fetch-Site"); site != "" &&
		site != "same-origin" && site != "none" {
		return true
	}
	if origin := request.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Host != request.Host {
			return true
		}
	}
	return false
}

type telemetryIntake struct {
	store       *telemetryStore
	revision    string
	fingerprint string

	mu          sync.Mutex
	windowStart time.Time
	accepted    int
}

func (intake *telemetryIntake) overRate(now time.Time) bool {
	intake.mu.Lock()
	defer intake.mu.Unlock()
	if now.Sub(intake.windowStart) >= time.Minute {
		intake.windowStart = now
		intake.accepted = 0
	}
	if intake.accepted >= telemetryIntakePerMinute {
		return true
	}
	intake.accepted++
	return false
}

func (intake *telemetryIntake) handle(writer http.ResponseWriter, request *http.Request) {
	if sameOriginViolation(request) {
		http.Error(writer, "cross-origin telemetry is not accepted", http.StatusForbidden)
		return
	}
	contentType := request.Header.Get("Content-Type")
	if contentType != "application/json" && !strings.HasPrefix(contentType, "application/json;") {
		http.Error(writer, "telemetry must be application/json", http.StatusUnsupportedMediaType)
		return
	}
	if intake.overRate(time.Now()) {
		http.Error(writer, "telemetry intake limit reached", http.StatusTooManyRequests)
		return
	}

	request.Body = http.MaxBytesReader(writer, request.Body, telemetryMaxBodyBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var report telemetryReport
	if err := decoder.Decode(&report); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(writer, "telemetry report too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(writer, "telemetry report is not valid JSON", http.StatusBadRequest)
		return
	}
	if decoder.More() {
		http.Error(writer, "telemetry report has trailing content", http.StatusBadRequest)
		return
	}
	if err := validateTelemetryReport(&report); err != nil {
		http.Error(writer, "telemetry report rejected: "+err.Error(), http.StatusBadRequest)
		return
	}

	_, err := intake.store.insert(&report, time.Now(), intake.revision, intake.fingerprint)
	if err != nil {
		// The message is sanitized; the database error stays in the journal.
		log.Printf("telemetry store failure: %v", err)
		http.Error(writer, "telemetry storage unavailable", http.StatusServiceUnavailable)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func newTelemetryIntake(store *telemetryStore, spotifyClientID string) *telemetryIntake {
	return &telemetryIntake{
		store:       store,
		revision:    serverRevision(),
		fingerprint: clientFingerprint(spotifyClientID),
	}
}
