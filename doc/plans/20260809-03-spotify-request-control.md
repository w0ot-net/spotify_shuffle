# Plan: Spotify Request Control

Depends on `20260809-02-telemetry-delivery.md`.

## Summary

Route every Spotify Web API call through one serial, paced request lane, honor
`Retry-After` with one bounded retry, and persist long cooldowns so reloads do
not hammer Spotify again. Stop an oversized Liked Songs read after its first
page and cancel the active lane on disconnect. The preceding telemetry plan
records the policy, waits, attempts, local blocks, and remaining 429s so the
conservative settings can later be changed from evidence.

## Problem

A cold Liked Songs cache miss costs approximately
`ceil(N/50) + ceil(N/100) + 3` Spotify calls when it creates a target. For 4,000
tracks that is about 123 calls. Six read workers dispatch page requests in
bursts, then writes follow immediately; there is no pacing, `Retry-After`
handling, retry, or cooldown across reloads.

The fingerprint cache now makes an unchanged repeat Liked Songs shuffle spend
only one validation-page request before writing, so a second reuse mechanism is
neither needed nor desirable. One waste remains: page zero already reveals when
Liked Songs exceeds the 10,000-track playlist capacity, but the current read
still fetches the entire library before the existing write guard rejects it.
A development quota can still refuse a necessary request; the browser should
avoid bursts and known waste, obey Spotify's deadline, and leave concrete
evidence when that is insufficient.

This proceeds ahead of the deliberate rate-limit probe the repository's
notes defer to, and supersedes the recorded stance that a governor waits
for recorded observations: live quota refusals already interrupt real use,
the telemetry plans deploy first so every wait and remaining 429 is
measured from day one, and the fixed policy is deliberately conservative
and unconfigurable precisely because no evidence exists yet to tune it.
The documentation this plan migrates owns retiring that recorded deferral.

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
- Populate the telemetry schema's request-policy, attempt, wait, cancellation,
  local-block, and terminal-phase fields.

Out of scope:

- A server-wide lease or coordination across browsers, users, applications, or
  other processes.
- Claiming that a fixed pace can defeat an unpublished development or endpoint
  quota; remaining 429s are expected evidence, not silent success.
- Reusing `loadedTracks` as an additional freshness mechanism, changing the
  Liked Songs fingerprint cache, adding a TTL/refresh button, or changing
  playlist snapshot-cache semantics.
- Retrying 5xx responses or network errors, automatically resuming after a
  cooldown longer than 60 seconds, or keeping a page alive for hours.
- Changing Spotify page sizes, 100-URI write batches, the derived-playlist
  protocol, OAuth scopes, or the server telemetry schema.
- Making pacing remotely configurable or adding adaptive tuning in this
  increment.

## Design

**Spend fewer calls before controlling their rate.** `loadLikedSource` already
fetches and parses page zero before deciding whether its fingerprint cache
matches. If that authoritative `total` exceeds the output capacity, it raises a
distinct capacity error immediately and issues no remaining page, closing
fingerprint probe, or write request. The existing cache remains the sole
freshness rule: a match continues to cost one page-zero request, while a miss at
or below capacity performs the complete verified read.

**One lane replaces the pool.** Delete `maxConcurrentTrackRequests` and the
worker dispatcher. Remaining offsets are read in order by a simple loop, while
`requestSpotify` owns a module-scope next-start time and an abortable delay.
Every Web API request, including listing and sequential write batches, passes
through that point. A fixed 1,000 ms minimum is deliberately conservative and
unconfigurable in the first increment: a 10,000-track cold Liked Songs shuffle
can still take about five minutes and make roughly 303 necessary calls, but it
does not launch a six-request burst.

The telemetry operation declares policy `serial-1000ms-v1`, minimum start gap
1,000 ms, and one allowed 429 retry. The page-lifetime rolling history created by
the telemetry plan observes actual dispatches across listing and shuffle
operations; the request lane does not create a second history or counter.

**A 429 establishes one deadline.** The telemetry plan's normalized
`Retry-After` state supplies a non-negative safe integer delta. Missing or
invalid input becomes 30 seconds, matching Spotify's documented rolling-window
duration. The browser stores `{until}` under
`trueshuffle.spotify-cooldown.v1`; invalid or expired records are removed, and
storage failure degrades to the same deadline in page memory. The cooldown is
application-level rather than authorization state, so disconnect does not clear
it.

The request that received 429 may run once more after the deadline only when the
remaining wait is at most 60 seconds and it has not already retried. A second
429 updates the deadline and fails. A longer deadline fails immediately with
the absolute local retry time; later operations fail locally without a Spotify
call until it expires. Only 429 is safe to replay here: every other failure
retains the current fail-fast behavior, avoiding duplicate mutations after
ambiguous network failures.

**The active operation owns cancellation.** Listing and shuffle operations each
create an `AbortController`; `requestSpotify` passes its signal to fetch and the
delay helper. Disconnect aborts the controller before clearing page state.
Sequential dispatch checks the signal before every wait and request, so no page
or write batch begins after cancellation. Abort errors are swallowed only when
the operation is no longer active; ordinary failures retain their current
scoped messages.

**Telemetry is the tuning surface.** Each actual attempt retains the role and
workload established by its logical request and records its scheduled wait,
actual start, result, status, retry delay, reason, and page-local 30-second
count. A request refused by persisted cooldown records `cooldown-blocked`
without pretending Spotify returned a status. Cancellation records the phase
where work stopped. The initial interval changes only in a future reviewed
change after the SQLite evidence is queried; this plan contains no adaptive
logic.

## Affected Components

- `web/pure.js` and `web/pure_test.js`: add capacity and cooldown error/value
  logic and exact retry/cooldown decisions.
- `web/app.js` and `web/app_test.js`: replace the worker pool with sequential
  reads; add the paced lane, bounded 429 retry, stored cooldown, per-operation
  abort controller, early Liked Songs cap, and telemetry policy fields; prove
  timing with a deterministic fake clock.
- `README.md`: describe the conservative request policy and honest large-source
  duration.
- `doc/notes.md`: revise the rate-limiter note -- the governor-deferral
  sentence is superseded by this plan, while the deliberate probe remains a
  deferred experiment for tuning the interval from evidence.
- `doc/architecture/browser/APPLICATION_MODEL.md`,
  `doc/architecture/browser/DATA_MODEL.md`,
  `doc/architecture/integration/SPOTIFY_INTEGRATION.md`, and
  `doc/architecture/testing/TESTING_MODEL.md`: document serialization,
  cooldown state, cancellation, early capacity rejection, telemetry policy,
  deterministic time, and abort coverage.

No Go source, server route, SQLite schema, page element, cache validity rule, or
Spotify scope change is expected.

## Implementation Sequence

1. Add the pure capacity, cooldown, and decision logic with direct tests, reusing
   the telemetry plan's normalized retry-header state.
2. Extend the harness with a manually advanced clock and abortable fetch/wait
   behavior; keep the existing `settle` helper for unrelated tests.
3. Replace the page worker pool with a sequential loop and central 1-second
   request spacing. Replace the out-of-order pool test with proof of ordered,
   non-overlapping dispatch and minimum start gaps across listing and shuffle.
4. Add 429 deadline persistence, fallback, one short retry, long local block,
   and exact user messages; prove non-429 and network failures are never
   retried.
5. Add operation cancellation and first-page Liked Songs capacity rejection.
   Prove disconnect issues no later read or write and an oversized library
   issues only its opening page.
6. Assert policy identity, attempts, waits, cancellation, local blocks, and
   terminal phases in captured telemetry; update the nearest architecture pages
   and README.
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
between starts across operation boundaries, ordered offsets, and unchanged
page/write completeness. It must also prove one short 429 retry after the
advertised delay, the 30-second fallback, no second retry, no retry of any other
failure, persistence and expiry of a long cooldown, and zero Spotify calls while
locally blocked.

The Liked Songs cap case must issue only page zero and no write while existing
fingerprint-hit and verified-miss behavior remains intact. Disconnect cases must
abort a pending delay and an in-flight fetch and prove no subsequent write batch
was dispatched. Telemetry assertions must distinguish policy, waits, attempts,
cancellation, local blocking, and terminal phase. No live Spotify account or
slow wall-clock test is required.

After explicitly authorized deployment, use ordinary browser behavior only if
the user separately authorizes live Spotify validation. Compare sanitized
SQLite operation rows before and after the change: request starts should be
serialized, rolling-window counts should reflect the new pace, retry waits
should match response guidance, and any remaining 429 must retain its reason and
deadline. Do not tune the 1-second interval during this execution unless a new
reviewed plan authorizes that behavior change.

## Success Criteria

- No TrueShuffle browser operation has more than one Spotify Web API request in
  flight or starts requests less than 1,000 ms apart, including the boundary
  between playlist listing and a shuffle.
- A short 429 delay is honored and retried once; repeated, missing-header, and
  long-delay cases stop predictably without a request storm or hours-long page
  timer.
- Reloading during a long cooldown causes no Spotify call until the stored
  deadline expires, while disconnecting leaves that app-level protection
  intact.
- A Liked Songs library above playlist capacity stops after its opening page;
  existing playlist snapshot and Liked Songs fingerprint cache behavior is
  unchanged.
- Disconnect cancels active transport and prevents every subsequent request in
  that operation, including write batches.
- Existing completeness, target-ownership, batching, token, cache, and
  one-operation invariants remain intact, and durable telemetry identifies the
  active request policy and every wait, attempt, cancellation, local block, and
  remaining 429 without a server-schema change.
