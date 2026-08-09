# Plan: Liked Songs Read

## Summary

A Liked Songs section on the page reads the connected account's complete
saved-track URI list from `GET /v1/me/tracks` through the existing
bounded-pool read pattern, with the progress bar and elapsed-time message,
holding the result in page state for the follow-up shuffled-playlist plan.
Reading the library requires the `user-library-read` scope, so the section
shows a reconnect action when the stored token predates the scope.

## Problem

Liked Songs is not a playlist resource: it is absent from
`/v1/me/playlists`, has no `snapshot_id`, and has no reorder API, so the
in-place shuffle path can never apply to it. The product requirement is to
shuffle Liked Songs by writing a new playlist, which decomposes into
reading the saved-track URIs (this plan) and writing a shuffled copy (the
follow-up `20260809-2-liked-shuffle.md`). Today the app cannot read the
library at all: the granted scopes do not include `user-library-read`.

## Scope

In scope:

- Add `user-library-read` to the requested scopes. Gate the Liked Songs
  section on the stored token's `scope` value: a token without the scope
  shows a reconnect button that runs the existing authorization flow.
- Read `/v1/me/tracks` with offset-addressed pages (`limit=50`, the
  endpoint maximum; it supports no `fields` filtering) through the shared
  bounded pool, reusing the track-page reader -- the item shape matches --
  the offset computation, assembly, progress element, and message.
- The library has no snapshot, so the read pins the page-0 `total` and
  verifies it unchanged with a final probe, plus the summed raw-count
  check; mismatch fails as a changed-while-loading error. The library has
  no 10,000 cap (removed by Spotify in 2020), so the offset computation
  gains a caller-supplied maximum; playlist reads keep 10,000.
- Section UI: a status line plus reconnect and load buttons; `likedTracks`
  page state `{uris}`; one operation at a time across playlist and liked
  loads via shared button disabling.
- Pure logic and direct tests; harness coverage; Go page markers; the
  authorization-model, integration, application-model, and README updates.

Out of scope:

- Creating or writing any playlist: the follow-up plan.
- Caching Liked Songs. With no snapshot there is no cheap validity rule;
  every load is a fresh read. Revisit only with observed need.
- Showing Liked Songs inside the playlists list; it is not a playlist and
  gets its own section.
- Retry, backoff, and `Retry-After`; the fail-fast posture stands.

## Design

**Scope gating is read from the stored token.** The token record already
carries `scope`; a pure word-membership check decides between the
reconnect and load actions. Reconnect is the existing `startAuthorization`
with the extended scope list -- no second flow. Tokens issued before this
change keep working for playlists; only the liked section asks for
reconsent.

**Total is the version stamp, verified twice.** Page 0 pins `total`; after
the pool drains, the summed raw item count must equal it, and a final
page-0 probe must report the same `total`. Weaker than a snapshot but the
strongest signal the endpoint offers; any mismatch discards the read.

**Reuse over new machinery.** `readTrackPage` already validates
`{limit,total,items(track(uri))}`-shaped pages and `/v1/me/tracks` items
match it; `assembleTrackPages` and the pool are unchanged except the pool
takes a URL-for-offset function instead of a playlist id, so both reads
share it. `remainingTrackOffsets` gains an explicit `maxTotal` argument:
playlist callers pass 10,000, the liked read passes
`Number.MAX_SAFE_INTEGER`.

**One operation at a time.** The playlist-button disabling generalizes to
all action buttons (playlist buttons plus the liked section's), so a liked
load and a playlist load cannot interleave and share the single progress
element safely.

## Affected Components

- `web/pure.js`: `likedPageURL`, `hasScope`, `maxPlaylistTracks` export,
  `remainingTrackOffsets` maximum argument.
- `web/app.js`: the scope in `scopes`, the liked section rendering and
  gating, `readLikedTracks` (pin/pool/verify by total), `likedTracks`
  state, the generalized pool URL builder and shared button disabling,
  clearing on disconnect.
- `web/index.html`: `liked-status`, `liked-connect`, `liked-load`.
- `web/pure_test.js`: URL and scope-check cases; offsets maximum cases
  (the existing cap case updates to the new signature and message).
- `web/app_test.js`: reconnect gating and the authorize URL carrying the
  new scope; a multi-page liked read with progress and count; total-drift
  and request-failure cases; disconnect clearing; one-operation gating.
- `main_test.go`: the three new element markers.
- `doc/architecture/browser/AUTHORIZATION_MODEL.md`: the scope list and
  the reconnect-gating rule.
- `doc/architecture/integration/SPOTIFY_INTEGRATION.md`: the endpoint, no
  fields filtering, the total-pin verify, no library cap.
- `doc/architecture/browser/APPLICATION_MODEL.md`: the liked section
  states and the one-operation invariant.
- `README.md`: status and the scopes paragraph.

## Implementation Sequence

1. Pure additions and signature change with direct tests.
2. Page elements and Go markers.
3. `web/app.js` gating, read, and shared disabling.
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

Live confirmation (reconnect, load a real library) follows deployment
under the standing deployment direction.

## Success Criteria

- A token without `user-library-read` shows the reconnect action, whose
  authorize URL carries the new scope; a token with it shows the load
  action.
- Loading reads every page with the bounded pool, shows the progress bar,
  and renders the count with elapsed time; `likedTracks` holds the URIs.
- A total that drifts mid-read or a short read fails loudly and leaves
  playlists, selection, and token untouched.
- Playlist and liked loads cannot run concurrently.
- Disconnect clears the section and its state.
- Purity grep clean; all prior tests pass unmodified except the offsets
  cap case named in scope.

## Execution Notes

Executed 2026-08-09. Implementation commit `b058517`.

Implemented as planned: `likedPageURL`, `hasScope`, the exported
`maxPlaylistTracks`, and the `remainingTrackOffsets` maximum argument in
`web/pure.js` (the playlist read passes 10,000, the liked read
`Number.MAX_SAFE_INTEGER`); the pool now takes a URL-for-offset function;
the liked section with scope-gated reconnect, the total-pinned read with
final-probe verification, `likedTracks` page state, and the shared
`setActionButtonsDisabled` gate in `web/app.js`; three new page elements
with Go markers; the authorization-model, integration, application-model,
and README updates.

Deviations: a module-scope `likedToken` (set when the section renders,
cleared on disconnect) carries the token to the section's click handlers
and doubles as the late-result guard for a read that outlives a
disconnect -- the same posture the playlist read has.

Validation, all passing: `gofmt -l main.go main_test.go` (no output),
`go test ./...`, `go vet ./...`, `node --check` on both web scripts,
`node --test web/pure_test.js web/app_test.js` (57 pass, 0 fail),
`git diff --check`, and the inverted purity grep.

Deployment, completed 2026-08-09: shipped as release
`87f2622864d39d3c19f69b93270c80cf8b30c358` together with the companion
`20260809_liked-shuffle.md`, whose record holds the deployment details.
