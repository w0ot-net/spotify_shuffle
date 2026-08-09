# Plan: Track Cache and Change Detection

Depends on `20260809-1-track-read.md` being implemented first.

## Summary

Cache each read playlist's ordered URI list in IndexedDB keyed by playlist
id and stamped with the `snapshot_id` it was read under. Selecting a
playlist whose cached snapshot matches the listing's current snapshot uses
the cache and issues zero track requests; a snapshot mismatch triggers the
existing fast read, and a local multiset comparison of old and new URIs
reports how many tracks were added and removed. Disconnecting deletes the
cache.

## Problem

After the track-read plan, every selection re-reads the full playlist even
when nothing changed -- for a 10,000-track playlist, 100 requests to learn
what the browser knew yesterday. The product goal is explicit: cache
membership and validate it with snapshots.

Spotify constrains the design: `snapshot_id` is an opaque version stamp
that changes on every playlist mutation, and there is no API that returns
the difference between two snapshots. So "detect change cheaply" decomposes
into two honest halves: equality of snapshots proves the cache current at
zero cost (the listing already delivers each playlist's `snapshot_id`), and
on inequality the only refresh is a URI-only re-read -- already cheap by
the previous plan -- after which the difference is computed locally.

## Scope

In scope:

- An IndexedDB store holding one record per playlist:
  `{snapshot_id, uris, cached_at}` keyed by playlist id.
- Retain `snapshot_id` in the pure listing-page reader so selection can
  compare without extra requests.
- Cache-first selection: snapshot match renders from cache with no track
  requests; mismatch or missing record runs the read, then stores the
  verified result.
- A pure multiset difference over URI lists (duplicates counted), rendered
  as "N added, M removed since last read" when a prior record existed;
  membership-identical reorders render the plain count.
- Cache unavailability degrades to the uncached read path; a failed
  re-read keeps the previous record.
- Disconnect deletes the cache database.
- Pure tests for the reader extension, record validation, and the
  difference; harness coverage with a minimal fake IndexedDB; a new
  data-model architecture page.

Out of scope:

- Eviction or size accounting. Records are roughly 40 bytes per track;
  even many large playlists stay in the low megabytes. Removal happens on
  disconnect only.
- Naming which tracks changed. Only URIs are cached; titles would require
  the metadata reads this project deliberately avoids.
- Refreshing the listing's snapshots after page load. Freshness is bounded
  by page load, exactly as the listing itself already is.
- Using the cache for anything but selection (the shuffle increment
  consumes `loadedTracks`, which this plan populates identically on both
  paths).

## Design

**Snapshot equality is the entire validity rule.** A cached record is
current if and only if its `snapshot_id` equals the snapshot the listing
reported for that playlist at page load. No timestamps, no TTLs, no partial
invalidation: Spotify changes the snapshot on every mutation, so equality
proves the full ordered list, not just its length.

**The listing already carries the evidence.** `/v1/me/playlists` items
include `snapshot_id`; the pure listing reader keeps `{id, name, total}`
and starts retaining it. Selection therefore decides cache-hit versus read
with zero additional requests. The one staleness window -- the listing
snapshot itself ages while the page sits open -- yields at worst an
unnecessary re-read or a consistent-but-old render, the same freshness
contract the listing has today.

**IndexedDB behind two small functions.** `web/app.js` gains a promise
wrapper opening database `trueshuffle` (version 1, object store
`playlists`) with get/put by playlist id and a database delete for
disconnect. No generic cache layer, no schema registry: one store, one
record shape, validated on read by a pure `validTrackCacheRecord` --
an invalid or unreadable record is a cache miss.

**Cache errors degrade; read errors fail.** The cache is an optimization,
so an unavailable IndexedDB (private mode, denied storage) must not break
reading: a failed cache read is a miss, a failed cache write leaves the
rendered result standing. Spotify read failures keep failing loudly, and a
failed re-read keeps the previous record intact -- the cache is only ever
replaced by a verified read, so it can hold stale truth but never
corruption.

**The difference is a pure multiset count.** Playlists may contain the same
URI more than once, so the comparison counts occurrences: added is the
surplus in the new list, removed the surplus in the old. Zero/zero with a
changed snapshot means a reorder or non-membership edit and renders the
plain count. The counts are display-only; no consumer needs the URI sets
yet, so they are not returned.

**Disconnect deletes the database.** Cached URIs are private account data;
the existing disconnect semantics -- delete local state, revoke nothing
remotely -- extend to the cache.

**Fake IndexedDB stays minimal.** The harness fakes exactly the surface
the wrapper touches -- open with upgrade, get, put, database delete --
delivering callbacks via deferred microtasks so handler registration wins
the race, mirroring `FakeStorage`'s role rather than growing toward a
storage engine.

## Affected Components

- `web/pure.js`: retain `snapshot_id` in the listing-page reader; add
  `validTrackCacheRecord` and the multiset difference.
- `web/app.js`: the IndexedDB wrapper, cache-first `selectPlaylist` flow,
  difference rendering, cache deletion on disconnect.
- `web/pure_test.js`: snapshot retention, record validation, difference
  cases -- duplicates in both directions, pure additions, pure removals,
  reorder-only.
- `web/app_test.js`: the fake IndexedDB; cases for a snapshot-match
  selection issuing zero track requests, a mismatch re-reading and storing
  and reporting counts, cache unavailability degrading to a working read,
  a failed re-read preserving the old record, and disconnect deleting the
  database.
- `doc/architecture/browser/DATA_MODEL.md` (new): cache ownership, the
  record shape, the snapshot-equality validity rule, the degrade posture,
  and the disconnect rule; linked from the architecture index reading
  order and the documentation map.
- `doc/architecture/integration/SPOTIFY_INTEGRATION.md`: snapshot
  semantics -- opaque, changes on every mutation, no difference API, local
  comparison after a URI-only re-read.
- `doc/architecture/browser/APPLICATION_MODEL.md`: cache-first selection.
- `doc/architecture/browser/AUTHORIZATION_MODEL.md`: disconnect also
  deletes the cache.
- `README.md`: status gains cached membership and growth/shrink reporting.

No Go file changes: the served page, routes, and CSP are untouched.

## Implementation Sequence

1. Extend the pure listing reader and add the record validator and
   difference, with direct tests.
2. Add the IndexedDB wrapper and the fake, proving them with a
   round-trip case.
3. Rewire selection cache-first, add the difference rendering and the
   disconnect deletion, and add the harness cases.
4. Add the data-model page, update the three touched pages and the README.
5. Validate, commit, push.

## Validation

```sh
node --check web/pure.js
node --check web/app.js
node --test web/pure_test.js web/app_test.js
git diff --check
! grep -nE 'document|window|fetch|localStorage|sessionStorage|crypto|location|history' web/pure.js
```

The tests must prove the zero-request cache hit, the mismatch path storing
only verified reads, correct duplicate-aware counts, degrade-on-unavailable
cache, and deletion on disconnect. `indexedDB` deliberately stays out of
the purity grep list because `web/pure.js` gains no storage code; the
wrapper lives in `web/app.js`.

Architecture-page link integrity is checked as in the architecture-docs
plan. Live validation against a real account -- mutate a playlist in
Spotify, reload, confirm the reported counts -- only with explicit user
direction. Deployment follows the private runbook on explicit direction,
plausibly as one release with the track-read plan.

## Success Criteria

- Re-selecting an unchanged playlist renders its count from cache with
  zero track requests, proven by the harness request log.
- After a snapshot change, selection re-reads, stores the verified list,
  and reports "N added, M removed" with duplicate-aware counts; a
  membership-identical change reports the plain count.
- An unavailable cache never breaks reading; a failed re-read never
  destroys the previous record.
- Disconnect leaves no cached playlist data in the browser.
- The purity grep stays clean; all prior tests pass unmodified except the
  listing-reader pure cases extended for `snapshot_id`.
- The data-model page exists and is linked; the integration,
  application-model, and authorization pages and the README describe the
  behavior.

## Execution Notes

Executed 2026-08-09, immediately after `20260809_track-read.md`.
Implementation commit `767d6c2`.

Implemented as planned: the pure listing reader retains the snapshot as
`snapshotId` on playlist objects (the stored record keeps the API's
`snapshot_id` name); `validTrackCacheRecord` and the multiset
`countTrackChanges` landed in `web/pure.js` with direct tests;
`web/app.js` gained the promise wrappers over database `trueshuffle`
(version 1, store `playlists`), the cache-first `selectPlaylist` flow, the
difference rendering, and cache deletion on disconnect. The harness's
`FakeIndexedDB` fakes exactly open-with-upgrade, get, put, and database
delete, delivering callbacks on deferred microtasks. The data-model page
was added and linked from the architecture index reading order and the
documentation map; the integration, application-model, and authorization
pages and the README were updated.

Deviations: none material. The mid-read disconnect guard introduced by the
track-read execution also gates the cache write, so a read that outlives a
disconnect stores nothing.

Validation, all passing: `node --check` on both web scripts,
`node --test web/pure_test.js web/app_test.js` (47 pass, 0 fail, including
the zero-request cache hit proven by the harness request log),
`git diff --check`, the inverted purity grep (unchanged: `indexedDB` stays
out of the list because `web/pure.js` gained no storage code), and the
architecture link-integrity loop over every relative Markdown target. No
Go files changed, so no Go validation was run.

Live validation -- mutating a real playlist and confirming the reported
counts -- and deployment were not performed; both remain conditional on
explicit user direction per `AGENTS.md`.

Deployment, completed 2026-08-09 with explicit user direction under the
private operations runbook: shipped as release
`96808e109a9035282c192ccb6ec5d692263ee0af` together with the track-read
and track-read-progress plans, whose records hold the shared validation
details. Manual browser validation against a live Spotify account was not
performed.
