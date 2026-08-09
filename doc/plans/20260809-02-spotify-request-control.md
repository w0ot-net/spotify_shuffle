# Plan: Spotify Request Control

Depends on `20260809-01-rate-limit-telemetry.md`.

## Summary

Route every Spotify Web API call through one serial, paced request lane, honor
`Retry-After` with one bounded retry, and persist long cooldowns so reloads do
not hammer Spotify again. Stop unnecessary Liked Songs reads before they spend
the request budget, reuse a verified source already loaded in the tab, and
cancel the active lane on disconnect. The telemetry from the preceding plan
measures every wait, attempt, and remaining 429 so the conservative policy can
later be adjusted from evidence.

## Problem

A cold Liked Songs shuffle currently costs approximately
`ceil(N/50) + ceil(N/100) + 3` Spotify calls when it creates a target. For
4,000 tracks that is about 123 calls. Six read workers dispatch page requests
in bursts, then writes follow immediately; there is no pacing, `Retry-After`
handling, retry, or cooldown across reloads.

The flow also reads an entire Liked Songs library before rejecting totals above
the 10,000-track playlist capacity, and a second click reads the same library
again even when its verified URIs remain in `loadedTracks`. These behaviors
waste both rolling-window and development-mode quota. A development quota can
still reject a necessary request, but the browser should stop creating bursts,
avoid known waste, and obey Spotify when told to pause.

## Scope

In scope:

- Replace the six-worker page pool with ordered sequential page reads.
- Enforce one in-flight Web API request and at least 1,000 ms between request
  starts across listing, source reads, writes, and verification.
- On 429, record a safe cooldown from `Retry-After`, or 30 seconds when the
  header is missing or invalid; retry the same request at most once when the
  wait is no more than 60 seconds.
- Persist the cooldown deadline in browser `localStorage`, reject new Spotify
  calls locally during a longer cooldown, and render the retry time clearly.
- Retry only an explicit 429. Do not retry network failures, other statuses,
  malformed success responses, or indeterminate writes.
- Abort an active fetch or wait on disconnect and guarantee no later request
  from that chain is dispatched.
- Reject a Liked Songs total above 10,000 after page zero and before requesting
  another page; retain the existing no-write capacity guard.
- Reuse `loadedTracks` when the same source is selected again in the same tab,
  with a message that identifies the page-local reuse.
- Populate the preceding plan's attempt, wait, cancellation, and local-block
  telemetry fields.

Out of scope:

- A server-wide lease or coordination across browsers, users, applications, or
  other processes sharing Spotify's development quota.
- Claiming that a fixed pace can defeat an unpublished daily or endpoint quota;
  remaining 429s are expected evidence, not silent success.
- Persistently caching Liked Songs, adding a TTL or refresh button, or changing
  playlist snapshot-cache semantics.
- Retrying 5xx responses or network errors, automatically resuming after a
  cooldown longer than 60 seconds, or keeping a page alive for hours.
- Changing Spotify page sizes, 100-URI write batches, the derived-playlist
  protocol, OAuth scopes, or the server telemetry schema.
- Making pacing remotely configurable or adding adaptive tuning in this
  increment.

## Design

**Spend fewer calls first.** After the first Liked Songs page establishes
`total`, the read uses the existing 10,000 output capacity as its bound; a
larger total raises a distinct capacity error that the current user-facing cap
message handles. A successful read remains in module-scope `loadedTracks`.
Selecting that same source again uses those URIs with "already loaded in this
tab" wording instead of another Spotify read. Selecting another source or
disconnecting replaces or clears the state as today. This has the same
page-lifetime freshness boundary as the listing snapshot already used by
playlist cache hits and introduces no new persistent track store.

**One lane replaces the pool.** Delete `maxConcurrentTrackRequests` and the
worker dispatcher. Remaining offsets are read in order by a simple loop, while
`requestSpotify` owns a module-scope next-start time and an abortable delay.
Every Web API request, including listing and sequential write batches, passes
through that point. A fixed 1,000 ms minimum is deliberately conservative and
unconfigurable in the first increment: a 10,000-track cold Liked Songs shuffle
can still take about five minutes and make roughly 303 necessary calls, but it
does not launch a six-request burst.

**A 429 establishes one deadline.** The preceding plan's normalized
`Retry-After` value supplies a non-negative, safe integer delta. Missing or
invalid input becomes 30 seconds, matching Spotify's documented rolling-window
duration. The browser stores
`{until}` under `trueshuffle.spotify-cooldown.v1`; invalid or expired records
are removed, and storage failure degrades to the same deadline in page memory.
The cooldown is application-level rather than authorization state, so
disconnect does not clear it.

The request that received 429 may run once more after the deadline only when
the remaining wait is at most 60 seconds and it has not already retried. A
second 429 updates the deadline and fails. A longer deadline fails immediately
with the absolute local retry time; later operations fail locally without a
Spotify call until it expires. Only 429 is safe to replay here: all other
failures retain the current fail-fast behavior, avoiding duplicate mutations
after ambiguous network failures.

**The active operation owns cancellation.** Listing and shuffle operations
each create an `AbortController`; `requestSpotify` passes its signal to fetch
and the delay helper. Disconnect aborts the controller before clearing page
state. Sequential dispatch checks the signal before every wait and request, so
no page or write batch begins after cancellation. Abort errors are swallowed
only when the operation is no longer active; ordinary failures keep their
current scoped messages.

**Telemetry is the tuning surface.** Each actual attempt records its sequence,
scheduled client wait, start time, result, status, retry delay, and reason. A
request refused locally by a persisted cooldown records `local cooldown
blocking` without pretending Spotify returned a status. No new server endpoint
or database column is needed. The initial 1-second interval changes only in a
future evidence-backed commit, not dynamically inside this plan.

## Affected Components

- `web/pure.js`: add capacity and cooldown error types, cooldown-record and
  decision logic, and the page-local reuse message.
- `web/app.js`: replace the worker pool with sequential reads; add the paced
  request lane, bounded 429 retry, stored cooldown, per-operation abort
  controller, early Liked Songs cap, loaded-source reuse, and telemetry fields.
- `web/pure_test.js`: cover retry-header parsing, cooldown validation and
  decisions, capacity classification, and reuse wording.
- `web/app_test.js`: add a deterministic fake clock and cancellation support;
  replace the bounded-pool case and cover pacing, retries, persistence, local
  blocking, early cap, reuse, and disconnect.
- `README.md`: describe the conservative request policy and honest large-source
  duration.
- `doc/architecture/browser/APPLICATION_MODEL.md` and
  `doc/architecture/browser/DATA_MODEL.md`: document loaded-source reuse,
  cancellation, and the non-sensitive persisted cooldown.
- `doc/architecture/integration/SPOTIFY_INTEGRATION.md`: replace the six-worker
  and fail-fast-429 contracts with serialization, pacing, retry, and limits.
- `doc/architecture/testing/TESTING_MODEL.md`: document deterministic clock and
  abort coverage.

No Go source, server route, SQLite schema, page element, or Spotify scope
change is expected.

## Implementation Sequence

1. Add the pure capacity, cooldown, and message logic with direct tests, reusing
   the telemetry plan's normalized retry-header value.
2. Extend the harness with a manually advanced clock and abortable fetch/wait
   behavior; keep the existing `settle` helper for unrelated tests.
3. Replace the page worker pool with the sequential loop and central 1-second
   request spacing. Rewrite the former out-of-order pool test to prove ordered,
   non-overlapping dispatch and minimum start gaps.
4. Add 429 deadline persistence, fallback, one short retry, long local block,
   and exact user messages; prove non-429 and network failures are never
   retried.
5. Add operation cancellation, first-page Liked Songs capacity rejection, and
   same-source reuse. Prove disconnect issues no later read or write and a
   repeat click spends zero source-read calls.
6. Assert the telemetry reports attempts, waits, cancellation, and local blocks;
   update the nearest architecture pages and README.
7. Validate, commit, and push. Deploy only with separate explicit direction
   after the telemetry plan is running, so any remaining rate-limit response
   produces durable evidence.

## Validation

```sh
node --check web/pure.js
node --check web/app.js
node --test web/pure_test.js web/app_test.js
git diff --check
! grep -nE 'document|window|fetch|localStorage|sessionStorage|crypto|location|history' web/pure.js
```

The deterministic harness must prove one in-flight request, at least 1,000 ms
between starts, ordered offsets, and unchanged page/write completeness. It must
also prove one short 429 retry after the advertised delay, the 30-second
fallback, no second retry, no retry of any other failure, persistence and
expiry of a long cooldown, and zero Spotify calls while locally blocked.

The Liked Songs cap case must issue only page zero and no write. A repeat click
on the same loaded source must issue no new source read but must still reshuffle
and safely overwrite the derived target. Disconnect cases must abort a pending
delay and an in-flight fetch and prove no subsequent write batch was dispatched.
Telemetry assertions must distinguish waits, attempts, cancellation, and local
blocking. No live Spotify account or slow wall-clock test is required.

After explicitly authorized deployment, use ordinary browser behavior only if
the user separately authorizes live Spotify validation. Compare sanitized
SQLite operation rows before and after the change: request starts should be
serialized, retry waits should match response guidance, and any remaining 429
must retain its reason and deadline. Do not tune the 1-second interval during
this execution unless a new reviewed plan authorizes that behavior change.

## Success Criteria

- No TrueShuffle browser operation has more than one Spotify Web API request in
  flight or starts requests less than 1,000 ms apart.
- A short 429 delay is honored and retried once; repeated, missing-header, and
  long-delay cases stop predictably without a request storm or hours-long page
  timer.
- Reloading during a long cooldown causes no Spotify call until the stored
  deadline expires, while disconnecting leaves that app-level protection intact.
- A Liked Songs library above playlist capacity stops after one page, and a
  repeat shuffle in the same tab reuses its verified loaded source instead of
  reading it again.
- Disconnect cancels active transport and prevents every subsequent request in
  that operation, including write batches.
- Existing completeness, snapshot, target-ownership, batching, token, and
  one-operation invariants remain intact, and telemetry makes the new request
  policy observable without server changes.
