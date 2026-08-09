# Data model

*Revised: 2026-08-09*

This page owns the browser's persistent track data: the IndexedDB cache,
its record shape, the validity rule, and the degrade and disconnect
postures. Return to the [architecture index](../README.md).

## One store, one record shape

IndexedDB database `trueshuffle` (version 1) holds one object store,
`playlists`, keyed by playlist id. A record is
`{snapshot_id, uris, cached_at}`: the ordered track URI list a verified
read produced, the `snapshot_id` it was read under, and the write time.
`web/app.js` owns the store behind small promise wrappers -- open, get,
put, and database delete; there is no generic cache layer or schema
registry. Records are validated on read by the pure
`validTrackCacheRecord`; an invalid or unreadable record is a cache miss.

## Snapshot equality is the entire validity rule

A cached record is current if and only if its `snapshot_id` equals the
snapshot the listing reported for that playlist at page load. No
timestamps, no TTLs, no partial invalidation: Spotify changes the snapshot
on every playlist mutation (see the
[Spotify integration](../integration/SPOTIFY_INTEGRATION.md)), so equality
proves the full ordered list, not just its length. A matching record
renders with zero track requests; a mismatch or miss runs the full
verified read, whose result replaces the record and whose difference from
the old list is reported as duplicate-aware added and removed counts. The
listing snapshot itself ages while the page sits open, which costs at
worst an unnecessary re-read -- the same freshness contract the listing
has.

## The cache degrades; reads fail

The cache is an optimization. An unavailable IndexedDB -- private mode,
denied storage, an unsupported browser -- makes every lookup a miss and
every store a no-op, and reading proceeds uncached. A failed re-read keeps
the previous record intact: only a verified read ever replaces a record,
so the cache can hold stale truth but never corruption. Spotify read
failures keep failing loudly per the integration posture.

## Disconnect deletes the database

Cached URIs are private account data. Disconnecting deletes the
`trueshuffle` database along with the token record and page state (see the
[authorization model](AUTHORIZATION_MODEL.md)); no cached playlist data
survives a disconnect.
