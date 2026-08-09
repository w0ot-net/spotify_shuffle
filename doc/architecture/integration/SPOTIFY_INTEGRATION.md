# Spotify integration

*Revised: 2026-08-09*

This page owns the contract with Spotify: the endpoints in use, the paging
bounds, and the scopes position. Return to the
[architecture index](../README.md).

All Spotify traffic originates in the browser. Five endpoints are in use:

- `https://accounts.spotify.com/authorize` -- top-level navigation opening
  the consent flow.
- `https://accounts.spotify.com/api/token` -- form-encoded POST for the code
  exchange and refresh grants.
- `https://api.spotify.com/v1/me/playlists` -- authenticated GET listing the
  connected account's playlists.
- `https://api.spotify.com/v1/playlists/{id}` -- authenticated GET pinning
  and verifying the playlist `snapshot_id` around a track read.
- `https://api.spotify.com/v1/playlists/{id}/tracks` -- authenticated GET
  reading the selected playlist's track URIs.
- `https://api.spotify.com/v1/me/tracks` -- authenticated GET reading the
  account's Liked Songs library.
- `https://api.spotify.com/v1/me` -- authenticated GET for the user id a
  playlist creation needs.
- `https://api.spotify.com/v1/users/{id}/playlists` -- authenticated POST
  creating the private shuffled playlist.
- `https://api.spotify.com/v1/playlists/{id}/tracks` -- authenticated POST
  appending shuffled URIs to the playlist this app just created.

## Paging

Listing requests `limit=50`, the endpoint maximum, and follows the response
`next` cursor after the pure cursor check accepts it (see the
[security model](../security/SECURITY_MODEL.md)). The loop is bounded at 200
pages -- the API's 10,000-playlist library cap divided by the page size --
and exceeding the bound is an error, never a silent truncation, because a
silently short list would later shuffle the wrong playlist. Full playlist
objects are returned; the page reader consumes `id`, `name`, `tracks.total`,
and `snapshot_id`, skipping the null placeholders Spotify emits for items it
cannot expose.

## Track reading

Selecting a playlist reads its complete ordered track URI list in three
phases: pin the playlist's `snapshot_id`, fetch the `/tracks` pages, then
re-fetch the `snapshot_id` and require it unchanged, so a playlist mutating
mid-read fails the read instead of silently assembling a corrupted order.

Track requests are `fields`-filtered to `limit,total,items(track(uri))` --
URIs only, never full track metadata -- and ask for `limit=100`, the
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
caller-supplied bound. With no snapshot, the read pins the page-0 `total`,
runs the same bounded pool and offset assembly as playlist reads, and
verifies with the summed raw count plus a final probe whose `total` must
match the pin -- the strongest torn-read detection the endpoint offers.
Reading the library requires `user-library-read` (see the
[authorization model](../browser/AUTHORIZATION_MODEL.md) for how older
tokens are gated to a reconnect).

## Writing the shuffled playlist

The only write flow creates a new private playlist and fills it: read the
user id, `POST` the playlist, then append the shuffled URIs with
sequential `POST` batches of at most 100 -- sequential because each append
lands at the playlist's end, so arrival order is the shuffled order. After
the last batch, a `fields=tracks.total` read of the new playlist must
equal the written count or the flow reports the playlist as possibly
incomplete, naming it for manual cleanup; it never claims success on a
shortfall. No pre-existing playlist is ever written, so a failure strands
at worst a partial playlist this app just created. A library above the
10,000-item playlist cap fails before anything is created. This flow is
the first exercise of `playlist-modify-private`.

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
retry message naming the HTTP status Spotify returned (for example
"(Spotify returned 429)"), so a live failure is diagnosable from the page
alone; there is no retry, backoff, or `Retry-After` scheduling, and
no failure is interpreted as revocation (see the
[authorization model](../browser/AUTHORIZATION_MODEL.md)). This posture is a
deliberate current stance, recorded when OAuth hardening deferred retry
scheduling. Spotify's rate limits are unpublished, so any future governor
is to be designed from recorded live observations, not ahead of them.

## Scopes

`playlist-read-private` is exercised by listing and track reading,
`user-library-read` by the Liked Songs read, and
`playlist-modify-private` by the shuffled-playlist creation.
`playlist-modify-public` is granted but unexercised -- held so the
in-place playlist shuffle needs no re-consent (planned).
