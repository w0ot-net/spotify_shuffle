# Spotify integration

*Revised: 2026-08-09*

This page owns the contract with Spotify: the endpoints in use, the paging
bounds, and the scopes position. Return to the
[architecture index](../README.md).

All Spotify traffic originates in the browser. These endpoint paths are in use:

- `https://accounts.spotify.com/authorize` -- top-level navigation opening
  the consent flow.
- `https://accounts.spotify.com/api/token` -- form-encoded POST for the code
  exchange and refresh grants.
- `https://api.spotify.com/v1/me/playlists` -- authenticated GET listing the
  connected account's playlists and POST creating a private shuffled
  playlist.
- `https://api.spotify.com/v1/playlists/{id}` -- authenticated GET pinning
  and verifying the playlist `snapshot_id` around a track read.
- `https://api.spotify.com/v1/playlists/{id}/items` -- authenticated GET
  reading the selected playlist's track URIs, POST appending shuffled URIs,
  and PUT replacing existing contents.
- `https://api.spotify.com/v1/me/tracks` -- authenticated GET reading the
  account's Liked Songs library.

## Paging

Listing requests `limit=50`, the endpoint maximum, and follows the response
`next` cursor after the pure cursor check accepts it (see the
[security model](../security/SECURITY_MODEL.md)). The loop is bounded at 200
pages -- the API's 10,000-playlist library cap divided by the page size --
and exceeding the bound is an error, never a silent truncation, because a
silently short list would later shuffle the wrong playlist. Full playlist
objects are returned; the page reader consumes `id`, `name`, `items.total`,
and `snapshot_id`, skipping the null placeholders Spotify emits for items it
cannot expose.

## Track reading

Selecting a playlist reads its complete ordered track URI list in three
phases: pin the playlist's `snapshot_id`, fetch the `/items` pages, then
re-fetch the `snapshot_id` and require it unchanged, so a playlist mutating
mid-read fails the read instead of silently assembling a corrupted order.

Track requests are `fields`-filtered to `limit,total,items(item(uri))` --
URIs only, never full track metadata -- and ask for `limit=50`, the
documented maximum. The first page's response echoes the page size the
server actually enforced and the authoritative total; the remaining offsets
are computed from those echoed facts, never from documentation assumptions,
and fetched by a pool of at most six concurrent requests. The pool
dispatches nothing further after its first failure. Pages are assembled by
offset, so completion order cannot affect the result.

A summed raw item count differing from the reported total, or a moved
snapshot, discards the read and asks the user to select the playlist again.
Items without an exposable track URI are skipped but still count toward the
completeness check. A total above Spotify's 10,000-item playlist cap is an
error, mirroring the listing bound.

Every track-read URL is constructed locally against the fixed API origin
with the playlist id URI-encoded; track reading follows no server-supplied
cursor at all, so the listing's cursor guard has no analogue here and the
bearer token cannot be steered off-origin by a response.

## Liked Songs reading

Liked Songs is not a playlist resource: it is absent from the listing, has
no `snapshot_id`, and has no reorder API. `/v1/me/tracks` supports no
`fields` filtering, so full track objects arrive and only `track.uri` is
consumed; the page maximum is 50 and the library has no 10,000-item cap
(Spotify removed it in 2020), so the offset computation takes a
caller-supplied bound.

The library read is cache-first: the cached record's fingerprint -- its
`total` plus the URI list of its newest page -- is compared against the
page-0 fetch the read needs anyway, and a match reuses the cached URIs at
the cost of that one request (see the
[data model](../browser/DATA_MODEL.md) for why the fingerprint is sound).
With no snapshot, a full read pins the page-0 fingerprint,
runs the same bounded pool and offset assembly as playlist reads, and
verifies with the summed raw count plus a final probe that must reproduce
the pinned fingerprint -- so a mid-read membership change fails the read
even when it holds the total still, the strongest torn-read detection the
endpoint offers, and a stored record is verified current at read end.
Reading the library requires `user-library-read` (see the
[authorization model](../browser/AUTHORIZATION_MODEL.md) for how older
tokens are gated to a reconnect).

## Writing the shuffled playlist

Shuffled output lands in one derived playlist per source, named
`<source name> TrueShuffle`. The suffix is the app's ownership claim and
an invariant, not a convention: every playlist id the write flow touches
is either returned by the create call it just made or found in the
page-load listing under a name exactly equal to the derived name, so a
playlist without the suffix is unreachable by construction.

When no listed playlist bears the derived name, the flow `POST`s a private
playlist under that name to `/v1/me/playlists`, and appends the shuffled URIs
to `/v1/playlists/{id}/items` in sequential batches of at most 100 --
sequential because each append lands at the end, so arrival order is the
shuffled order.
When the target exists, the first batch goes by `PUT`, replacing the
entire contents, and the remaining batches append; a rerun after any
mid-write failure therefore starts from a clean replacement, never
appending onto wreckage. Either way a final `fields=items.total` read of
the target must equal the written count or the flow names the target as
possibly incomplete and offers a rerun; it never claims success on a
shortfall. A source above the 10,000-item playlist cap fails before
anything is written.

## Snapshot semantics

`snapshot_id` is an opaque version stamp that changes on every playlist
mutation, and Spotify offers no API returning the difference between two
snapshots. Change detection therefore decomposes locally: snapshot equality
proves a cached track list current at zero request cost -- the listing
already delivers each playlist's `snapshot_id` -- and on inequality the
only refresh is a URI-only re-read, after which the added and removed
counts are computed locally by a multiset comparison (see the
[data model](../browser/DATA_MODEL.md)).

## Failure posture

Integration failures fail fast. A non-OK response -- including `401`,
`429`, and `5xx` -- surfaces as a listing, read, or write failure with a
retry message naming the HTTP status and endpoint Spotify refused (for
example "(Spotify returned 429 at /v1/me/tracks)"), so a live failure is
diagnosable from the page alone; there is no retry, backoff, or
`Retry-After` scheduling, and
no failure is interpreted as revocation (see the
[authorization model](../browser/AUTHORIZATION_MODEL.md)). This posture is a
deliberate current stance, recorded when OAuth hardening deferred retry
scheduling. Spotify's rate limits are unpublished, so any future governor
is to be designed from recorded live observations, not ahead of them. Those
observations now exist: every operation posts a sanitized report -- request
roles, timing, statuses, `Retry-After` state, Spotify's structured reason,
and the page-local rolling 30-second request count -- to the service's
telemetry store, without changing any Spotify request.

## Scopes

`playlist-read-private` is exercised by listing and track reading,
`user-library-read` by the Liked Songs read, and
`playlist-modify-private` by the derived-playlist writes.
`playlist-modify-public` is granted but unexercised -- held because a
user may make a derived playlist public in Spotify, and overwriting it
then requires the public scope without a re-consent.
