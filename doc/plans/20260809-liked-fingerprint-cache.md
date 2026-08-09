# Plan: Liked Songs Fingerprint Cache

## Summary

Cache the Liked Songs library in the existing IndexedDB store and validate
the record with a fingerprint the library cannot silently escape: its
total plus the URI list of its newest page. Because saved tracks order by
save time newest-first, every membership change moves one or both -- so a
fingerprint match proves the cached URIs current at the cost of exactly
one request, the page-0 fetch the read performs anyway. A repeat Liked
Songs shuffle drops from `ceil(N/50) + 1` read requests to one; the same
comparison also strengthens the read's own torn-read probe from total-only
to the full fingerprint.

## Problem

`loadLikedSource` in `web/app.js` re-reads the entire library on every
click because the library has no `snapshot_id` to key the playlist cache's
validity rule. A 3,000-track library costs 61 read requests per shuffle, a
10,000-track one 201 -- the app's largest rate-limit consumer, spent even
when nothing changed. Repeat shuffles of an unchanged library are the
product's core gesture, and they are exactly the case the playlist cache
already made free for playlists.

Count-equality alone would be a poor validity rule: an unlike balanced by
a like leaves the count unchanged and the cache permanently stale, with
nothing to ever heal it. The library's ordering closes that hole: an
addition always lands at the top of page 0, so a count-neutral change is
visible in the newest page even though the total held still.

## Scope

In scope:

- A liked cache record `{total, head, uris, cached_at}` stored under the
  existing `liked-songs` sentinel key in the current store, where `head`
  is the page-0 URI list the record was read under; a pure validator and
  a pure fingerprint comparison (total equal and head URIs equal).
- Cache-first `loadLikedSource`: read the record, fetch page 0, and on a
  fingerprint match reuse the cached URIs with no further requests; on a
  miss or mismatch continue the existing full read from that already
  fetched page 0, then store the new record.
- Membership difference on re-reads: the existing multiset comparison
  against the old record, rendered exactly as playlist re-reads render it.
- Strengthen the read's final page-0 probe from total-only to the full
  fingerprint comparison, so a mid-read membership change that holds the
  total still also fails the read, and the stamped fingerprint is verified
  current at read end.
- The existing degrade posture applies: an unusable cache is a miss, a
  failed record write leaves the rendered result standing, a failed
  re-read keeps the old record, and disconnect's database deletion already
  covers the new record.
- Architecture and README migration for the new validity rule.

Out of scope:

- Any change to playlist caching, the write flow, the request pool, or
  `requestSpotify`. The pending rate-limit plans
  (`20260809-01`/`20260809-02`) own pacing and retry; request control
  declares persistent Liked Songs caching out of its scope, and this plan
  fills that gap without touching its surface. Its in-tab loaded-source
  reuse composes in front of this cache.
- A TTL, refresh button, or any validity input beyond the fingerprint.
- Caching liked-track metadata; the record stores URIs only.

## Design

**The fingerprint is an ordering argument, stated honestly.** Saved
tracks are returned newest-first by save time, and the library cannot be
reordered. A removal changes `total`; an addition changes `total` or, in
the count-neutral case, appears at the head of page 0; re-liking an
existing song moves it to the head. The only invisible mutation is an
unlike immediately reversed for the same track -- membership-neutral by
definition. Unlike the playlist rule, this rests on documented ordering
behavior rather than a version stamp, and the data-model page says so
plainly.

**One comparison, two duties.** The pure fingerprint comparison validates
a cached record against a fresh page 0 and validates the read's closing
probe against its opening page. The stamped `{total, head}` is therefore
not merely what page 0 said at read start -- the probe proved it still
true at read end, so a stored record never begins life stale.

**The hit path costs the request already owed.** Page 0 is the read's
first request today (it establishes the total for offset computation), so
fingerprint validation adds zero requests to a cold read and reduces a
warm one to that single request. No new endpoint, no new request shape.

**Record separation without a second store.** Playlist records and the
liked record differ in shape and validity rule but share the store; the
key space cannot collide because Spotify ids never contain a hyphen while
the sentinel key does. The cache reader takes the validator as an
argument; each caller names its own record shape.

**Failure scope.** A fingerprint mismatch is not an error -- it is the
normal signal to re-read. A probe mismatch remains
`PlaylistChangedError` with the existing "changed while loading" message.
Cache unavailability never blocks the read; Spotify failures keep failing
loudly and keep the old record.

## Affected Components

- `web/pure.js`: `validLikedCacheRecord` and the fingerprint comparison
  (`likedRecordMatches`).
- `web/app.js`: parameterize the cache reader's validator; cache-first
  `loadLikedSource` with the page-0-first flow; `readLikedTracks` accepts
  the pre-fetched first page; the probe verifies the full fingerprint;
  the record write after a verified read.
- `web/pure_test.js`: validator shape cases; fingerprint cases -- match,
  total drift, count-neutral head drift, head-order drift.
- `web/app_test.js`: a fingerprint match shuffles from cache with exactly
  one library request; a count-neutral swap re-reads and reports the
  difference; a verified re-read stores a record a following click hits;
  a mid-read head drift with a steady total fails the read; an
  unavailable cache degrades to the full read.
- `doc/architecture/browser/DATA_MODEL.md`: the second record kind, its
  fingerprint validity rule, and the ordering-inference caveat.
- `doc/architecture/integration/SPOTIFY_INTEGRATION.md`: Liked Songs
  reading becomes cache-first; the probe check is the fingerprint.
- `doc/architecture/browser/APPLICATION_MODEL.md`: the liked row no
  longer skips the cache.
- `README.md`: the status paragraph stops saying Liked Songs is read
  each time.

## Implementation Sequence

1. Add the pure validator and comparison with direct tests.
2. Restructure the liked read to take the pre-fetched page 0 and verify
   the fingerprint probe.
3. Make `loadPlaylistSource`'s cache reader validator-parameterized and
   wire the cache-first liked flow with the record write.
4. Add the harness cases.
5. Update the three architecture pages and the README.
6. Validate, commit, push, and deploy per the standing directive through
   the private runbook.

## Validation

```sh
gofmt -l main.go main_test.go
go test ./...
go vet ./...
node --check web/pure.js
node --check web/app.js
node --test web/pure_test.js web/app_test.js
git diff --check
! grep -nE 'document|window|fetch|localStorage|sessionStorage|crypto|location|history' web/pure.js
```

The JavaScript tests must prove the one-request warm path via the harness
request log, the count-neutral invalidation, and that no stored record
ever comes from an unverified read. Existing cold-read request-sequence
assertions must pass unmodified.

Live validation -- two consecutive Liked Songs shuffles, the second
issuing one library request, then an unlike-plus-like pair followed by a
shuffle that re-reads -- follows explicit user direction per `AGENTS.md`.

## Success Criteria

- A second Liked Songs shuffle with an unchanged library issues exactly
  one `/v1/me/tracks` request and shuffles the cached URIs.
- Any membership change -- including one that holds the count still --
  invalidates the cache, triggers the full read, and reports added and
  removed counts.
- A mid-read membership change that keeps the total constant now fails
  the read instead of passing the probe.
- Cache unavailability, failed record writes, and failed re-reads leave
  behavior and prior records exactly as the degrade posture requires;
  disconnect still deletes every cached record.
- The purity grep stays clean; all existing tests pass with unmodified
  assertions.
- The data-model, integration, and application-model pages and the README
  describe the fingerprint rule and its ordering caveat.
