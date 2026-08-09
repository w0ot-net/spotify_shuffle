# Plan: Shuffled Playlist from Liked Songs

Depends on `20260809-1-liked-read.md` being implemented first.

## Summary

With Liked Songs loaded, one explicit action creates a brand-new private
playlist containing every liked URI in a uniformly shuffled order:
Fisher-Yates over the loaded list with crypto-backed unbiased randomness,
`POST` create under the connected user, then sequential 100-URI batch
appends with the progress bar, a final total verification, and a success
message naming the playlist. No existing playlist is ever touched; a
failed write names the possibly partial new playlist instead of hiding it.

## Problem

After the liked-read plan the browser holds the ordered liked URIs and can
do nothing with them. Spotify offers no reorder API for Liked Songs, so
the only shuffle the platform permits is writing a new playlist. This is
also the first exercised write: the `playlist-modify-private` scope has
been granted since the first consent but never used.

## Scope

In scope:

- A pure Fisher-Yates shuffle taking an injected `randomBelow` function;
  `web/app.js` supplies rejection-sampled `crypto.getRandomValues`
  randomness so no modulo bias enters.
- The write flow: read the user id from `GET /v1/me`; create a private
  playlist named "Liked Shuffle <UTC minute stamp>" via
  `POST /v1/users/{id}/playlists`; append the shuffled URIs with
  sequential `POST /v1/playlists/{id}/tracks` batches of at most 100
  (order-preserving); verify the playlist's final `tracks.total` equals
  the written count.
- A shuffle button in the liked section, visible once a load succeeds,
  under the shared one-operation disabling; progress bar reuse for the
  append phase; elapsed time in the success message.
- A liked list larger than the 10,000-item playlist cap fails before any
  write; an empty list never shows the button.
- `requestSpotify` gains an optional JSON `POST` body.
- Pure readers for the user id and created playlist, URL builders for the
  three write-path endpoints, and batching; direct tests, harness
  coverage, Go marker, and the integration, application-model,
  authorization-model, and README updates.

Out of scope:

- Reusing or replacing a previously generated playlist. Every run creates
  a new one; dedup or replace semantics can layer on later without risk to
  user data.
- Shuffling regular playlists (in place or by copy). This flow is the
  liked-songs outcome only.
- Deleting or unfollowing playlists, including partial ones from failed
  runs; the failure message names the playlist for manual cleanup.
- Retry, backoff, and rate-limit budgeting for writes.

## Design

**The shuffle is pure and provably uniform at the boundary.**
`shuffledURIs(uris, randomBelow)` implements Fisher-Yates and validates
every returned index; direct tests drive it with deterministic sequences.
`web/app.js` implements `randomBelow` by rejection sampling a 32-bit
`crypto.getRandomValues` word, so each index is uniform.

**Writes are sequential and order-preserving.** Appends run one batch at a
time; each `POST` appends at the playlist's end, so arrival order is the
shuffled order. The progress bar's maximum is the URI count and each
completed batch advances it. No parallelism: order is the product.

**Nothing existing is ever written.** The only mutated resource is the
playlist this flow just created, so a failure can strand at worst a
partial new playlist. The failure message names it ("may be incomplete --
delete it in Spotify or shuffle again"); a retry creates a fresh one.
The create happens only after the local cap and emptiness checks pass.

**Verification is by the playlist's own count.** After the last batch, a
`fields=tracks.total` read of the new playlist must equal the written
count; a mismatch renders the incomplete-playlist failure, never success.

## Affected Components

- `web/pure.js`: `shuffledURIs`, `uriBatches`, `readUserId`,
  `readCreatedPlaylist`, `readPlaylistTotal`, and the `meURL`,
  `createPlaylistURL`, `addTracksURL`, `playlistTotalURL` builders with id
  encoding.
- `web/app.js`: the JSON `POST` support in `requestSpotify`, unbiased
  `randomBelow`, the create-and-append flow with progress and elapsed
  time, the shuffle button lifecycle, shared disabling.
- `web/index.html`: `liked-shuffle` button.
- `web/pure_test.js`: shuffle determinism under injected sequences,
  permutation preservation with duplicates, index validation, batching
  edges (empty, exactly 100, 101), reader validation cases.
- `web/app_test.js`: full-flow case asserting the create body, batch
  sizes, order preservation across batches, the verification request, and
  the success message; mid-append failure naming the playlist; cap
  exceeded writes nothing; button gating.
- `main_test.go`: the `liked-shuffle` marker.
- `doc/architecture/integration/SPOTIFY_INTEGRATION.md`: the three write
  endpoints, sequential batching, the verify-by-total rule.
- `doc/architecture/browser/APPLICATION_MODEL.md`: the shuffle action and
  its states.
- `doc/architecture/browser/AUTHORIZATION_MODEL.md`:
  `playlist-modify-private` is now exercised.
- `README.md`: status -- creates shuffled private copies of Liked Songs;
  existing playlists are still never modified.

## Implementation Sequence

1. Pure shuffle, batching, readers, builders with direct tests.
2. The button and Go marker.
3. The `web/app.js` flow.
4. Harness cases.
5. Documentation updates.
6. Validate, commit, push.

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

Live confirmation -- reconnect, load a real library, create a shuffled
playlist, and open it in Spotify -- follows deployment under the standing
deployment direction; the first real write is to a fresh private playlist
only.

## Success Criteria

- One click on the shuffle action creates exactly one new private
  playlist whose contents are a permutation of the loaded liked URIs,
  written in batches of at most 100, proven by the harness request log.
- The success message names the playlist and reports count and elapsed
  time; the progress bar tracks the append phase and hides on settle.
- A mid-write failure or count mismatch names the partial playlist and
  never claims success; a cap-exceeding or empty list writes nothing.
- No request in the flow modifies any pre-existing playlist.
- Purity grep clean; every prior test passes unmodified.

## Execution Notes

Executed 2026-08-09. Implementation commit `2e4f37a`.

Implemented as planned: `shuffledURIs` (Fisher-Yates over injected
randomness with index validation), `uriBatches`, the three write-path URL
builders, `readUserId`, `readCreatedPlaylist`, and `readPlaylistTotal` in
`web/pure.js`; JSON `POST` support in `requestSpotify`, rejection-sampled
`randomBelow`, the create-and-append flow with progress and elapsed time,
and the shuffle button lifecycle in `web/app.js`; the `liked-shuffle`
element and Go marker; the integration, application-model,
authorization-model, and README updates.

Deviations: the success-message composition landed as a pure
`createdPlaylistMessage` with direct tests -- the plan named only readers
and builders, but the message carries the same duration-rounding logic the
loaded-message already keeps pure, so it followed the same rule.

Validation, all passing: `gofmt -l main.go main_test.go` (no output),
`go test ./...`, `go vet ./...`, `node --check` on both web scripts,
`node --test web/pure_test.js web/app_test.js` (70 pass, 0 fail),
`git diff --check`, and the inverted purity grep. The harness proves the
single-create, batch sizes and order, the verification request, the
incomplete-playlist failure naming, the cap refusing to write, and the
empty-library gating.

Live confirmation -- reconnect, load a real library, create a shuffled
playlist, and open it in Spotify -- follows the deployment recorded
below.

Deployment, completed 2026-08-09 under the standing deployment direction
and the private operations runbook: shipped as release
`87f2622864d39d3c19f69b93270c80cf8b30c358` together with the liked-read
plan. Embedded `vcs.revision` matches and `vcs.modified` is false; binary
SHA-256
`c62cc4fd5744978b8b5f94cd7886a018f722e33b1b3d465a0da86d9b09b78860`. The
full Go and JavaScript suites passed on the host (70 of 70 browser tests
via direct `node` execution). The previous release `96808e1...` was
retained and `current` switched atomically; after restart the service is
active with zero restarts, loopback and public health are green, the
`liked-shuffle` element and library scope are served on the public
origin, and no warning-or-higher journal entries appeared. The first live
run against a real account (reconnect, load, create) is the user's next
action.
