# Plan: Rate-Limit Telemetry

Depends on `20260809-static-service-user.md` being executed before production
deployment.

## Summary

Record one sanitized telemetry report for every playlist-list or shuffle
operation and retain it in bounded SQLite storage. Each Spotify request carries
enough timing, role, workload, response, and local rolling-window context to
explain a later 429 without retaining Spotify or account identity. This plan
establishes the evidence and storage contract; acknowledged browser delivery is
the separate dependent `20260809-02-telemetry-delivery.md` plan.

## Problem

`requestSpotify` currently discards response headers and Spotify's structured
error reason, while the Go service stores nothing. A 429 therefore cannot show
the calls and workload that preceded it, distinguish rolling-window limiting
from development quota, or establish which part of the read/write protocol
spent the request budget.

Relative events scoped only to the current operation would still be
insufficient: Spotify's rolling window crosses listing and shuffle boundaries,
page loads can overlap, and a bounded report can discard old successes. The
evidence must preserve comparable request times and the already-computed local
30-second pressure while remaining bounded and non-identifying.

## Scope

In scope:

- Instrument every Spotify Web API call made through `requestSpotify`; exclude
  the OAuth token endpoint and telemetry submission itself.
- Group calls into `playlist-list`, `playlist-shuffle`, or `liked-shuffle`
  operations with random report and page-session identifiers, client epoch
  timestamps, monotonic relative timings, and page-lifetime rolling counts.
- Record precise request roles, endpoint class, method, attempt, scheduled wait,
  result, status, bounded workload counts, `Retry-After` state/value, and
  Spotify's structured error reason.
- Record sanitized operation context: source total, cache/read disposition,
  target disposition, terminal phase, request-policy values, duration, true
  request count, peak local 30-second count, truncation, and prior delivery
  drops plus delivery-storage state reserved for the dependent queue plan.
- Add exact `POST /api/telemetry` intake with strict validation, idempotent
  report IDs, origin checks, intake limits, and no read API.
- Store accepted reports transactionally in SQLite with schema versioning, a
  server-derived Spotify client-configuration fingerprint, diagnostic-aware
  retention, indexes, and a hard size cap.
- Submit each completed report once with same-origin `fetch` and `keepalive`,
  without allowing transport failure to affect the operation.
- Document collection, privacy, configuration, retention, deployment, and
  private operational queries.

Out of scope:

- Retrying or durably queueing failed telemetry submissions; the dependent
  delivery plan owns that outcome against this plan's idempotent contract.
- Pacing, concurrency changes, cooldown enforcement, retries of Spotify calls,
  or cancellation; those belong to the request-control plan.
- Instrumenting traffic from other applications. The current requested scope
  is TrueShuffle traffic, with Spotify's structured reason distinguishing
  development-quota failures.
- Sending bearer tokens, scopes, account identifiers, playlist identifiers or
  names, track URIs, raw URLs or query strings, response bodies or messages, IP
  addresses, or user-agent strings.
- Cookies, authenticated sessions, a public query endpoint, dashboard, metrics
  service, third-party analytics, or proof that a public browser report is an
  authenticated audit event.
- Streaming individual requests, backing up disposable telemetry, a generic
  database repository/migration framework, or adaptive request tuning.

## Design

**The operation owns its report; the page owns rolling context.**
`loadPlaylists` and `runShuffle` open the module-scope operation record already
made safe by the one-operation UI invariant. A random 128-bit `report_id`
supports later idempotent delivery. A separate random `page_session_id`
correlates operations from one page load without identifying an account or
surviving the page.

Operations record client epoch start/end plus monotonic duration. Requests
record epoch start, start offset, and monotonic duration. A module-scope deque
of request starts survives operation boundaries within the page; immediately
before dispatch it drops entries older than 30 seconds and records the count
including the new request. Each event retains that count and the operation
retains the peak, so a 429 keeps exact page-local pressure even if old successful
events are truncated. Absolute request times allow private SQL to combine
overlapping page sessions; server receipt time and operation duration let
queries flag implausible client clocks.

Reports retain at most 256 events and encode to at most 60 KiB. Truncation drops
oldest successes first, preferentially retains failures, and preserves the true
request count and flag. The computed 30-second count attached to every surviving
event is never recomputed from the truncated list.

**Call sites state purpose; normalization emits categories and numbers.** Every
`requestSpotify` call supplies one role:

- `playlist-list-page`;
- `playlist-snapshot-pin` or `playlist-snapshot-verify`;
- `playlist-items-page`;
- `liked-fingerprint-open`, `liked-items-page`, or
  `liked-fingerprint-verify`;
- `target-create`, `target-replace`, `target-append`, or
  `target-total-verify`.

Events independently retain method and endpoint class (`playlists`,
`playlist-metadata`, `playlist-items`, or `liked-tracks`). Numeric evidence uses
separate nullable fields for request items, response items, page offset, page
limit, and server-reported total. `Retry-After` is `absent`, `valid`, or
`invalid`; seconds exist only for a valid bounded value. The bounded structured
reason retains values such as `QUOTA_EXCEEDED` without retaining response text.

Operation context records whether the source was a playlist cache hit, Liked
Songs fingerprint hit, verified network read, empty, capacity-rejected, or not
applicable; whether the target was created, replaced, or untouched; source
total; terminal phase; and a bounded request-policy label with numeric minimum
start gap and retry ceiling -- initially `pool-6-v0` with gap zero and retry
ceiling zero, naming today's six-worker dispatcher so this plan executes
standalone and the request-control plan later changes only the values. It
also reserves delivery-storage state
(`one-shot`, `indexeddb`, or `queue-unavailable`) and a bounded prior-drop count,
initially `one-shot` and zero. The request-control and delivery plans can
populate those fields without changing the SQLite schema. Raw URLs and payloads
exist only inside the browser normalizer.

**The server validates independently and inserts idempotently.** Exact
`POST /api/telemetry` requires JSON, rejects unknown fields and invalid enums or
bounds, limits the body to 64 KiB and events to 256, checks same-origin browser
provenance when relevant headers are present, and accepts at most 60 reports per
process per minute. It returns `204` after a committed insert and also for an
already-stored `report_id`; rejected input gets `400`/`413`/`415`/`429`, and
store failure gets `503`. There is no CORS allowance or read route. These checks
bound accidental and browser-originated pollution but do not pretend a public
client is authenticated.

**SQLite is concrete and single-purpose.** Add `modernc.org/sqlite` at a pinned
Go-1.22-compatible version so `CGO_ENABLED=0` remains valid. `telemetry.go`
opens the required `TELEMETRY_DB_PATH`, uses one `database/sql` connection and
ordinary rollback journaling, and creates schema version 1 only when
`PRAGMA user_version` is zero; an unknown version fails startup.

Operations own the unique report ID, server receipt time, embedded binary
revision, SHA-256 fingerprint of the configured Spotify Client ID, operation
context, client timing, policy, counts, outcome, truncation, and client delivery
drop count. Request rows own normalized events and cascade with the operation.
Indexes cover receipt/client request time plus status, role, endpoint, and
reason.

Each insert transaction removes routine success operations older than 30 days
or above 2,000 rows, while operations containing a Spotify failure have a
separate 90-day/500-row ceiling. Routine traffic cannot evict rare 429 evidence.
The mode-`0600` database uses 4096-byte pages and `max_page_count` for a 256 MiB
main-file ceiling. Startup creates a missing file but fails on missing config,
an absent/unwritable parent, unknown schema, or insecure mode. Runtime insertion
failure affects only telemetry transport and emits a sanitized log; health and
ordinary routes remain available.

**State is operational and rollback-safe.** After the prerequisite plan
establishes ownership, production configuration sets `TELEMETRY_DB_PATH` to
`/opt/trueshuffle/data/telemetry.sqlite`, inside the stable service account's
sole writable data directory. Requiring the path at startup is deliberate
fail-fast -- a misdeployed service is loud at activation, never silently
telemetry-less -- which makes ordering load-bearing: the environment edit (a
separately authorized configuration change under the runbook) happens first,
is ignored by the running release, and only then is the new release
activated. Rollback reverts the binary alone; the added variable is harmless
to the prior release. Local examples use an OS temporary directory. A
rollback leaves the database untouched and harmless. Telemetry is disposable,
with retention and corruption recovery but no backup requirement.

## Affected Components

- `web/pure.js` and `web/pure_test.js`: own bounded telemetry enums,
  classification, normalization, and failure-preserving report truncation.
- `web/app.js` and `web/app_test.js`: attach explicit request roles/workload,
  maintain operation/page timing and context, and capture one-shot reports.
- `go.mod`, new `go.sum`, `main.go`, and new `telemetry.go`: pin SQLite, require
  the data path, derive server-owned identity, and implement exact intake,
  validation, idempotent storage, retention, and shutdown.
- `main_test.go` and new `telemetry_test.go`: materially cover route provenance,
  validation, duplicate delivery, persistence, diagnostic retention, limits,
  fingerprints, and startup/store failures with temporary databases.
- `README.md`: document the required local database path and sanitized
  first-party telemetry.
- `doc/architecture/README.md`, `doc/architecture/service/SERVICE_MODEL.md`, and
  `doc/architecture/security/SECURITY_MODEL.md`: update the state and privacy
  boundaries.
- `doc/architecture/browser/APPLICATION_MODEL.md`,
  `doc/architecture/integration/SPOTIFY_INTEGRATION.md`, and
  `doc/architecture/testing/TESTING_MODEL.md`: document operation evidence and
  its tests.
- `doc/architecture/deployment/DEPLOYMENT_MODEL.md`: add the database and
  protected writable-state contract after the prerequisite migration.
- Private `/root/ops/trueshuffle/RUNBOOK.md`: add database validation,
  rolling-window queries, retention checks, and corruption recovery without
  copying private context into Git.

No page element or Spotify scope change is expected.

## Implementation Sequence

1. Add and directly test bounded role, response, workload, and report value
   logic in `pure.js`.
2. Instrument callers and `requestSpotify`; add page-lifetime start history,
   operation context, timestamps, truncation, and one-shot submission. Prove
   listing-to-shuffle and over-256-request window evidence without changing
   Spotify request order.
3. Add SQLite, the concrete store/schema, diagnostic retention, size limits,
   intake gate, origin checks, and exact route, tested against temporary files.
4. Wire required startup configuration and clean shutdown; update local commands
   and the nearest authoritative documentation.
5. Validate, commit, and push. Before production deployment, execute and verify
   the stable-service-user plan if it remains open.
6. Only with separate explicit live-operation direction: first add the
   database path to the protected environment (a separately authorized
   configuration change the active binary ignores), then deploy the new
   release with rollback available, verify schema/ownership without
   exposing contents, and update the private runbook. A rollback reverts
   the binary alone.

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

Focused browser tests must prove success, rolling-window 429, quota reason,
network and malformed-response cases, cache hits, every write role, exact
header state, numeric page/batch evidence, listing-to-shuffle continuity,
failure-preserving truncation, and zero token/URI/id/name leakage. Go tests must
prove atomic insert, server-owned receipt/revision/client fingerprint, strict
rejection without partial rows, duplicate `204`, diagnostic retention, gates,
file bounds, and store-failure isolation. No live Spotify account is needed.

After an explicitly authorized deployment, verify a mode-`0600` database inside
the sole writable data directory, schema/page cap, ordinary health, and rollback
compatibility through read-only inspection. Retain no raw captures in Git.

## Success Criteria

- A stored 429 identifies exact request role/workload, status, `Retry-After`
  state/value, structured reason, local prior-30-second count, comparable time,
  overlapping page session, request policy, Spotify client configuration, and
  running server revision.
- Truncation cannot erase the computed local-window count attached to a retained
  failure; private queries combine overlapping reports and flag implausible
  client clocks.
- Routine successes cannot evict retained Spotify failures, and duplicate
  report IDs cannot create duplicate operations.
- No credential, account, playlist, or track identity enters the report or
  database, and no database read surface exists over HTTP.
- Input, intake, retention, row, and file bounds prevent unbounded growth;
  telemetry failure never changes Spotify requests, UI, or authorization.
- The pure-Go release still builds with `CGO_ENABLED=0`, local runs create no
  repository artifact, and production state stays in the application data
  directory.
