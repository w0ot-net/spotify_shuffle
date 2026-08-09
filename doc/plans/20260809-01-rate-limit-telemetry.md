# Plan: Rate-Limit Telemetry

Depends on `20260809-static-service-user.md` being executed before production
deployment.

## Summary

Record one sanitized telemetry report for each playlist-list or shuffle
operation, submit it best-effort to a same-origin endpoint, and retain it in a
bounded SQLite database. The report captures request timing, endpoint class,
status, Spotify's `Retry-After` and machine-readable reason, and item counts,
but no token, account, playlist, or track identity. This plan observes existing
behavior; it does not pace or retry Spotify requests.

## Problem

`requestSpotify` currently discards response headers and Spotify's structured
error reason, while the Go service stores nothing. A 429 therefore tells the
page only which path failed: it cannot establish how many requests preceded
the failure, their timing, whether a particular endpoint class was involved,
or whether Spotify returned a rolling-window delay or a longer quota delay.

Browser console output would disappear with the tab, and journald cannot
reconstruct client-to-Spotify traffic that never passes through the server.
TrueShuffle needs durable, queryable evidence before its request policy can be
tuned responsibly.

## Scope

In scope:

- Instrument Spotify Web API calls made through `requestSpotify`; exclude the
  OAuth token endpoint and the telemetry submission itself.
- Group request events into `playlist-list`, `playlist-shuffle`, or
  `liked-shuffle` operations and submit one bounded report when each operation
  settles.
- Capture method, sanitized endpoint class, sequence and relative timing,
  result, status, item count, `Retry-After`, structured Spotify reason,
  attempt, and client wait time.
- Add exact `POST /api/telemetry` intake with strict validation and no read API.
- Store accepted reports transactionally in SQLite under the configured data
  path, with schema versioning, retention, intake limits, and a hard size cap.
- Keep telemetry failure completely outside the playlist-list and shuffle
  success paths.
- Document collection, privacy, configuration, retention, deployment, and
  private operational queries.

Out of scope:

- Pacing, concurrency changes, cooldown enforcement, retries, or cancellation;
  those belong to `20260809-02-spotify-request-control.md`.
- Sending bearer tokens, scopes, account identifiers, playlist identifiers or
  names, track URIs, raw URLs or query strings, response bodies or messages,
  IP addresses, or user-agent strings to SQLite.
- Authentication, cookies, sessions, a public telemetry-query endpoint, a
  dashboard, metrics service, or third-party analytics.
- Persistent browser queues or retrying a failed telemetry submission.
- Backing up disposable operational telemetry or adding a generic database
  repository or migration framework.

## Design

**One report uses the existing one-operation invariant.** `loadPlaylists` and
`runShuffle` open a module-scope operation record; `requestSpotify` appends to
the active record. This avoids threading a context through every read and
write function. The record retains at most 256 events and drops oldest
successful events first until the encoded report is at most 60 KiB, while
keeping the true request count and a `truncated` flag. Failures therefore remain
in the evidence after an unusually large read unless failures alone exceed the
bound, in which case the newest are retained. The report stays within the
browser's small keepalive body budget and is sent with a same-origin `fetch`
using `keepalive`; its promise is not awaited, and all submission failures are
swallowed.

**Only categorical and numeric evidence crosses the origin boundary.** An
operation carries its kind, duration, total request count, truncation flag, and
events. Each event carries sequence, start offset, duration, method, one of
`playlists`, `playlist-metadata`, `playlist-items`, or `liked-tracks`, result,
HTTP status when present, bounded item count, retry seconds, bounded structured
reason, attempt, and client wait milliseconds. Initial events use attempt 1
and wait 0; the next plan populates retries and waits. Result is one of
`success`, `http-error`, `network-error`, `invalid-response`, `cancelled`, or
`cooldown-blocked`. Pure classification and normalization code sees the raw
URL and payload only inside the browser and emits no identifying string.

**The server validates independently.** `POST /api/telemetry` requires JSON,
rejects unknown fields and invalid enums or bounds, limits the body to 64 KiB
and events to 256, and accepts at most 60 reports per process per minute. It
returns `204` after a committed insert, `400`/`413`/`415`/`429` for rejected
input, and `503` for a store failure. There is no CORS allowance and no read
route. Authentication would add server sessions without protecting a public
client; strict non-sensitive input, a fixed intake rate, retention, and a file
cap bound the actual risk.

**SQLite is concrete and single-purpose.** Add `modernc.org/sqlite` at a pinned
Go-1.22-compatible version so the existing `CGO_ENABLED=0` release build stays
valid. `telemetry.go` opens the required `TELEMETRY_DB_PATH`, uses one
`database/sql` connection and ordinary rollback journaling, and creates schema
version 1 directly when `PRAGMA user_version` is zero; any unknown version
fails startup. There are two tables: operations own server receipt time,
binary revision, kind, derived outcome, duration, true request count, and
truncation; request rows own the normalized event fields and cascade with the
operation. Index receipt time plus request status, endpoint, and reason.

The database file is mode `0600`. A transaction inserts each operation and its
events, deletes operations older than 30 days, and then removes oldest
operations above 2,000 retained rows. SQLite uses 4096-byte pages with
`max_page_count` set for a 256 MiB main-file ceiling; deleted pages are reused,
so no background vacuum or maintenance worker is needed. Startup creates a
missing database file, but fails if the configured path is empty, its parent is
absent or unwritable, the file has an unknown schema, or its mode cannot be
secured.
Runtime insert failure affects only the telemetry response and emits a
sanitized server log; `/healthz` and the browser operation remain available.

**State is operational and rollback-safe.** Production config points
`TELEMETRY_DB_PATH` at `/opt/trueshuffle/data/telemetry.sqlite`, after the
stable-user plan establishes ownership. Local examples use an OS temporary
directory, never the repository. The server records its own embedded Git
revision rather than trusting a browser value. Rolling back to the current
stateless binary leaves the database untouched and harmless; telemetry is
disposable, so it has retention and corruption-recovery guidance but no backup
requirement.

## Affected Components

- `go.mod` and new `go.sum`: pin the CGo-free SQLite driver and its module
  graph.
- `main.go`: require the database path, open/close the store, attach the exact
  intake route, and obtain the binary revision.
- New `telemetry.go`: own schema creation, validation, retention, insert
  transactions, file limits, and the HTTP intake handler.
- `main_test.go` and new `telemetry_test.go`: use temporary databases and cover
  the route, validation, persistence, retention, limits, and startup failures.
- `web/pure.js` and `web/pure_test.js`: normalize endpoint and response evidence
  without retaining identifying inputs.
- `web/app.js` and `web/app_test.js`: own the operation record, request timing,
  header/reason extraction, best-effort report, and captured-report harness.
- `README.md`: add the required local database path and disclose the sanitized
  first-party operational telemetry.
- `doc/architecture/README.md`,
  `doc/architecture/service/SERVICE_MODEL.md`, and
  `doc/architecture/security/SECURITY_MODEL.md`: replace the stateless-service
  invariant with the bounded telemetry store, route, and privacy boundary.
- `doc/architecture/browser/APPLICATION_MODEL.md`,
  `doc/architecture/integration/SPOTIFY_INTEGRATION.md`, and
  `doc/architecture/testing/TESTING_MODEL.md`: document operation ownership,
  captured response evidence, and the new test layer.
- `doc/architecture/deployment/DEPLOYMENT_MODEL.md`: name the database file and
  protected writable-state ownership after the prerequisite migration.
- Private `/root/ops/trueshuffle/RUNBOOK.md`: add database validation,
  read-only diagnostic queries, retention checks, and explicit corruption
  recovery without mirroring private details into Git.

No page element or Spotify scope change is expected.

## Implementation Sequence

1. Add pure endpoint classification and bounded reason/`Retry-After` parsing
   with direct tests; extend `SpotifyRequestError` with the normalized evidence
   without changing current rendered messages.
2. Add the one-operation recorder around listing and shuffle flows, instrument
   `requestSpotify`, and submit reports best-effort. Extend the harness response
   headers and give telemetry its own capture path so Spotify orchestration
   assertions remain explicit.
3. Add the pinned SQLite dependency, concrete store, schema, retention and
   size limits, intake limiter, and exact route. Prove them through temporary
   database tests rather than a store fake.
4. Wire required startup configuration and clean shutdown; update local run
   commands and the nearest architecture pages.
5. Validate, commit, and push the repository changes. Before production
   deployment, execute and verify the stable-service-user plan if it remains
   open.
6. Only with explicit live-operation direction, configure the protected
   production path, deploy with rollback available, verify database ownership
   and schema without exposing contents, then update the private runbook with
   the verified state.

## Validation

```sh
gofmt -l main.go main_test.go telemetry.go telemetry_test.go
go test ./...
go vet ./...
build_dir=$(mktemp -d)
CGO_ENABLED=0 go build -trimpath -o "$build_dir/trueshuffle" .
rm -r "$build_dir"
node --check web/pure.js
node --check web/app.js
node --test web/pure_test.js web/app_test.js
git diff --check
! grep -nE 'document|window|fetch|localStorage|sessionStorage|crypto|location|history' web/pure.js
```

The focused tests must prove a success and a 429 report, exact header/reason
capture, network and malformed-response classification, event truncation that
retains failures while dropping old successes, and zero token/URI/id/name
leakage in the encoded report. Go tests must prove atomic inserts, independent server timestamps and
revision, strict rejection without partial rows, retention, the intake gate,
and that a telemetry write failure cannot change ordinary application routes.
No live Spotify account is needed.

After an explicitly authorized deployment, verify the service starts with a
mode-`0600` database inside the sole writable data directory, its schema and
page cap are correct through read-only inspection, normal routes remain
healthy, and rollback leaves the database intact. Do not retain raw browser,
HTTP, database, or journal captures in Git.

## Success Criteria

- Every completed list or shuffle operation attempts exactly one bounded
  first-party report, and report failure never changes its UI result or Spotify
  request sequence.
- A stored 429 shows how many requests preceded it, their relative timing and
  endpoint classes, the status, retry delay, structured reason when supplied,
  and the running server revision.
- The database contains no credential, account, playlist, or track identity
  and is unavailable through HTTP.
- Strict input, intake, retention, row-count, and file-size bounds prevent the
  public endpoint from growing memory or disk without limit.
- The pure-Go release still builds with `CGO_ENABLED=0`; local runs create no
  repository artifact; production state stays under `/opt/trueshuffle/data`.
- Documentation and the private runbook accurately describe the new stateful
  boundary without exposing private operations context.
