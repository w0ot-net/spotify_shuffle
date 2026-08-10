# Data model

*Revised: 2026-08-10*

This page owns the browser's persistent local data: the IndexedDB caches,
small `localStorage` application records, their validity rules, and the
degrade and disconnect postures. Return to the
[architecture index](../README.md).

## One store, two record shapes

IndexedDB database `trueshuffle` (version 1) holds one object store,
`playlists`. A playlist record, keyed by playlist id, is
`{snapshot_id, uris, cached_at}`: the ordered track URI list a verified
read produced, the `snapshot_id` it was read under, and the write time.
The Liked Songs record, keyed by the `liked-songs` sentinel (Spotify ids
never contain a hyphen, so the key spaces cannot collide), is
`{total, head, uris, cached_at}`: the library's URI list, the total it
was read at, and `head`, the page-0 URI list it was read under.
`web/app.js` owns the store behind small promise wrappers -- open, get,
put, and database delete; there is no generic cache layer or schema
registry. Each reader validates its own shape on read with the pure
`validTrackCacheRecord` or `validLikedCacheRecord`; an invalid or
unreadable record is a cache miss.

## Snapshot equality is the playlist validity rule

A cached playlist record is current if and only if its `snapshot_id` equals the
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

## The liked fingerprint is an ordering argument

The library has no snapshot, so its validity rule is the fingerprint
`likedRecordMatches` checks: the record is current if and only if its
`total` and its `head` equal the total and URI list of a freshly fetched
page 0. This rests on documented ordering behavior rather than a version
stamp -- saved tracks return newest-first by save time and cannot be
reordered -- so a removal moves the total, and an addition moves the head
even when a balanced removal holds the count still. The one mutation the
fingerprint cannot see is an unlike immediately reversed for the same
track, which is membership-neutral. Because page 0 is also the request a
full read starts with, a fingerprint match costs exactly one request, and
the read's closing probe re-checks the same fingerprint so a stored
record is verified current at read end. A mismatch is not an error; it is
the normal signal to re-read, after which the membership difference is
reported exactly as playlist re-reads report it.

## The cache degrades; reads fail

The cache is an optimization. An unavailable IndexedDB -- private mode,
denied storage, an unsupported browser -- makes every lookup a miss and
every store a no-op, and reading proceeds uncached. A failed re-read keeps
the previous record intact: only a verified read ever replaces a record,
so the cache can hold stale truth but never corruption. Spotify read
failures keep failing loudly per the integration posture.

## The telemetry delivery queue is a second, separate database

`trueshuffle-telemetry` (version 1) holds one versioned envelope record --
at most four encoded, already-sanitized telemetry reports awaiting the
server's acknowledgement, plus a bounded counter of unavoidable drops.
Overflow evicts the oldest success-only report first and counts a drop
only when every entry carries a Spotify failure. One read/write
transaction owns each envelope update, which serializes overlapping tabs;
a corrupt record is discarded and reported as unavailable storage, never
interpreted. The queue holds no Spotify, account, playlist, or track
identity, so it deliberately survives disconnect -- pending operational
evidence is not private account data.

## The cooldown record is application state

`localStorage` key `trueshuffle.spotify-cooldown.v1` holds `{until}`, the
absolute deadline of the most recent Spotify `429` cooldown, so a reload
cannot hammer Spotify during a pause. Invalid and expired records are
removed on read; an unwritable store degrades to the same deadline in page
memory. The record carries no account data and is application-level rather
than authorization state, so disconnect does not clear it.

## The background preference is visual state

`localStorage` key `trueshuffle.background.v1` holds one value from the fixed
background vocabulary: `weave`, `veil`, `orbit`, `tide`, or `prism`.
`weave` is the default and is represented by no stored record. An invalid
record -- including `ribbon`, the retired SVG default -- is discarded;
unavailable storage leaves selection working for the
current page only. The preference contains no Spotify or account data and
survives disconnect independently of authorization and cached tracks.

## Disconnect deletes the database

Cached URIs are private account data. Disconnecting deletes the
`trueshuffle` database along with the token record and page state (see the
[authorization model](AUTHORIZATION_MODEL.md)); no cached playlist data
survives a disconnect. The telemetry queue database, which holds no
account data, is not deleted.
