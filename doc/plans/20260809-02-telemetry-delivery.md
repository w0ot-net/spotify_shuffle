# Plan: Acknowledged Telemetry Delivery

Depends on `20260809-01-rate-limit-telemetry.md`.

## Summary

Keep sanitized operation reports in a four-entry browser queue until the
telemetry endpoint acknowledges them. Use the preceding plan's report IDs and
idempotent `204` contract so reloads and overlapping tabs can retry safely
without duplicating SQLite rows. Queue failure remains completely outside
Spotify and UI behavior.

## Problem

The telemetry plan initially submits each report once with an unawaited
keepalive fetch. If that request loses connectivity, races a reload, or receives
an intake/store failure, absence from SQLite is indistinguishable from an
operation that never happened. Durable rate-limit evidence needs an explicit
pending-versus-acknowledged state, not merely an attempted request.

## Scope

In scope:

- Persist already-sanitized encoded reports before transport in a separate
  IndexedDB queue database containing no Spotify identity.
- Bound the queue globally at four reports, retaining failure-bearing reports
  before success-only reports and counting unavoidable drops.
- Drain oldest first on page initialization and after enqueue, remove only after
  `204`, stop after a transport/non-204 failure, and allow duplicate concurrent
  delivery to resolve through server idempotency.
- Report whether durable queue storage was available and the number of reports
  dropped before the current report.
- Keep queue, storage, and transport failure from changing Spotify requests,
  rendered results, authorization, or the existing private track cache.
- Document the bounded local state and its privacy/degrade behavior.

Out of scope:

- Server routes, SQLite schema changes, or changes to report content other than
  populating the delivery fields reserved by the preceding plan.
- An unbounded offline log, service worker, background synchronization, retry
  timer, user-facing delivery status, or guarantee on browsers without usable
  IndexedDB.
- Clearing sanitized pending reports on Spotify disconnect; they remain only
  until acknowledged or displaced by the queue bound.
- Authentication, cross-device delivery, or making telemetry part of playlist
  correctness.

## Design

**One small IndexedDB record is the queue.** A separate
`trueshuffle-telemetry` database keeps one versioned queue-envelope record, so
disconnect can continue deleting the private `trueshuffle` track-cache database
without destroying pending operational evidence. A read/write transaction owns
each envelope update, giving overlapping tabs serialization without a new lock
abstraction. The pure module validates the envelope before use; corruption is
discarded as unavailable queue state, never interpreted leniently.

Before submission, the browser encodes and bounds the completed report, opens a
read/write transaction, inserts it if absent, applies the four-report bound, and
commits. Overflow deletes the oldest success-only report first; if all entries
contain Spotify failures, it deletes the oldest and increments a bounded drop
counter. Each newly built report copies the current counter into the reserved
`reports_dropped_before` field and states whether durable queue storage was
available. If IndexedDB is unavailable, the report falls back to the existing
one-shot keepalive path and honestly records `queue-unavailable` if delivered.

**Drain has triggers, not a retry loop.** One drain runs per page at a time.
Initialization and a successful enqueue trigger it; it reads the oldest report,
submits with same-origin `fetch` and `keepalive`, and removes that exact report
in a new transaction only after `204`. It continues while acknowledgements
succeed and stops on the first fetch error or non-204 response. No timer is
created, so an outage causes at most one failed attempt per trigger. Two tabs
may send the same report, but the server's unique report ID makes both receive
the same successful acknowledgement and transactional removal is harmless.

Queue work is launched independently from operation settlement. Every storage
and network error is contained inside the delivery owner, and no caller awaits
it before rendering or issuing Spotify requests.

## Affected Components

- `web/pure.js` and `web/pure_test.js`: validate and bound the queue envelope and
  choose failure-preserving eviction without browser interfaces.
- `web/app.js` and `web/app_test.js`: own the separate IndexedDB queue, enqueue-
  before-send ordering, drain triggers, acknowledgement removal, and unavailable
  storage fallback using the existing fake IndexedDB boundary.
- `README.md`: disclose the bounded sanitized pending queue.
- `doc/architecture/browser/APPLICATION_MODEL.md`,
  `doc/architecture/browser/DATA_MODEL.md`,
  `doc/architecture/security/SECURITY_MODEL.md`, and
  `doc/architecture/testing/TESTING_MODEL.md`: document delivery ownership,
  persistent state, privacy/disconnect behavior, and queue tests.

No Go source, server route/schema, page element, Spotify request, scope, token,
or track-cache record change is expected.

## Implementation Sequence

1. Add pure queue-envelope validation and four-entry failure-preserving eviction
   with direct tests.
2. Add the separate IndexedDB wrapper and captured transport path to the browser
   harness without changing the existing track-cache database.
3. Enqueue before transport, drain on initialization/enqueue, and remove only
   after `204`; populate delivery availability and drop-count fields.
4. Prove reload recovery, concurrent duplicate acknowledgement, unavailable and
   corrupt database fallback, bounded overflow, and total operation isolation.
5. Update the nearest documentation, validate, commit, and push. Deploy only
   after the prerequisite telemetry plan is deployed and with separate explicit
   direction.

## Validation

```sh
node --check web/pure.js
node --check web/app.js
node --test web/pure_test.js web/app_test.js
git diff --check
! grep -nE 'document|window|fetch|localStorage|sessionStorage|crypto|location|history' web/pure.js
```

Focused tests must prove persistence precedes fetch; only `204` removes a
report; a transport error, rejection, or `503` leaves it queued; page reload
retries it; duplicate deliveries create no visible error; overflow prefers
retaining failure reports and records drops; queue corruption and unavailable
IndexedDB degrade to one-shot submission; and delivery never changes Spotify
request order, UI state, or operation results.

## Success Criteria

- With usable IndexedDB, every completed operation is either acknowledged by
  the server or remains in the four-entry sanitized queue.
- Reload and overlapping-tab retries cannot create duplicate SQLite operations,
  and acknowledgement removes only the matching queued report.
- Queue overflow is bounded, failure-preserving, and observable through the
  reserved drop count; unavailable storage is distinguishable in delivered
  telemetry.
- The queue contains no Spotify/account/playlist/track identity, survives
  disconnect only while pending, and never changes application behavior.
- No retry timer, server/schema change, or second persistence abstraction beyond
  the one-record IndexedDB queue is introduced.
