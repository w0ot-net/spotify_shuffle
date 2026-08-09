# Plan: Unified One-Click Shuffle List

Depends on `20260809-1-derived-shuffle-target.md` being implemented first.

## Summary

The page becomes one list and one gesture: Liked Songs is the first row,
the user's playlists follow (derived ` TrueShuffle` playlists hidden), and
clicking any row loads its tracks -- cache-first for playlists, a library
read for Liked Songs -- shuffles them, and writes the result to the row's
derived target. The separate Liked Songs section, its three buttons, and
the playlist-selection-without-action state all disappear.

## Problem

The current page has two disjoint surfaces. Playlist rows select and load
tracks but lead nowhere: no shuffle exists for them, which is the product's
entire point. Liked Songs works end to end but lives in a separate section
with its own status line and three buttons (reconnect, load, shuffle),
presenting Spotify's library as a different kind of thing when to the user
it is just another shuffleable collection. Reaching a shuffled playlist
takes two or three clicks in one place and is impossible in the other.

## Scope

In scope:

- Render a Liked Songs row as the first list entry; when the stored token
  lacks `user-library-read`, its click starts the reconnect authorization
  and its label says so.
- Hide playlists whose name ends with the ` TrueShuffle` suffix from the
  rendered list, and render only the first instance of each name -- the
  Liked Songs row is always first, so a playlist named "Liked Songs" is
  shadowed by it. The full listing stays retained for the write flow's
  target lookup.
- When deduplication hides at least one playlist, render a one-line note
  counting the hidden duplicates and saying renaming them in Spotify
  makes them shuffleable. Derived-playlist hiding gets no note, and no
  note renders when nothing is shadowed.
- One click on any row runs load, shuffle, and create-or-overwrite as a
  single sequence, reusing the existing cache-first playlist load, the
  Liked Songs library read, and the derived-target write flow; a source
  with zero tracks reports that and writes nothing.
- Collapse the Liked Songs section: remove its status line and three
  buttons from `web/index.html` and `web/app.js`, and route every state
  through the existing playlist and track status lines and the shared
  progress element.
- Drop the now-empty "no playlists" special case: the list always holds
  the Liked Songs row.
- Harness and page-marker migration; architecture and README migration.

Out of scope:

- Any change to the read protocols, the cache, the shuffle, or the write
  flow; this plan rewires triggers and surfaces only.
- Caching Liked Songs. The library has no snapshot to validate, so each
  Liked Songs click re-reads it; this is the existing cost, now behind
  one click instead of two.
- A confirmation step. The target is app-owned by the suffix invariant,
  so the worst a stray click does is re-shuffle a playlist that exists to
  be re-shuffled.
- Track counts on the Liked Songs row; the listing carries no library
  total and this plan adds no request to fetch one.

## Design

**Liked Songs is a pseudo-playlist, not a parallel code path.** The row
enters the existing selection flow as `{liked: true, name: "Liked Songs"}`.
`selectPlaylist` branches once: liked rows load through the library read
and skip the cache; playlist rows keep the cache-first load. Everything
downstream -- progress, status rendering, the zero-track guard, shuffle,
write, disconnect handling -- is one shared path, which is what deletes
the `likedToken`/`likedTracks` parallel state and the second status
surface.

**Display filtering is not data filtering.** The retained listing keeps
every playlist; only the row renderer skips derived names and duplicate
names, keeping the first instance of each in listing order with the Liked
Songs row counting as the first "Liked Songs". The write flow's target
lookup must keep seeing every playlist or a shuffle would create a
duplicate target, so both filters live at render time and nowhere else.

**Visible names are unique, so targets are unambiguous.** Deduplication
makes name-keyed targets injective from the visible list: no two
clickable rows can share a derived target, which retires the
shared-target surprise duplicate names would otherwise cause. A shadowed
duplicate is unshuffleable until renamed in Spotify, an accepted cost --
but not a silent one. Dropping rows without saying so would be the
listing's version of silent truncation, which this repository treats as
an error elsewhere; the renderer therefore reports the shadowed count in
a single conditional line, while the routine hiding of derived targets
stays unannounced because the user watches those get created.

**One in-flight operation, one progress element.** The existing
action-button gate carries over: every row disables while a click's
load-shuffle-write chain runs. The chain reuses the read progress bar and
then the write progress bar exactly as the two flows do today.

**The reconnect surface moves into the row.** A token predating
`user-library-read` renders the Liked Songs row as the reconnect action --
the same `startAuthorization` call the section button makes today -- so
the capability gate survives with no dedicated widgets.

**Failure scope is unchanged by unification.** A failed load or write
renders in the track status line, leaves the listing, the cache, the
stored token, and (per the previous plan) all non-derived playlists
untouched; disconnecting mid-chain drops late results through the
existing selection-active guard, which the liked pseudo-playlist now
shares.

## Affected Components

- `web/app.js`: render the liked row first; render-time derived-name
  filter; the single click chain (load, zero-track guard, shuffle, write);
  removal of the liked section state, renderers, and listeners; reconnect
  routed through the row.
- `web/pure.js`: the render-list helper that hides derived names, and the
  liked row's labels; the zero-track message.
- `web/index.html`: remove the liked status line and the three liked
  buttons.
- `main_test.go`: page markers for the removed liked elements.
- `web/pure_test.js`: filter cases -- derived names hidden, near-miss
  names kept, duplicate names reduced to the first instance with the
  shadowed count reported, a "Liked Songs" playlist shadowed by the liked
  row -- and label and shadowed-note message cases.
- `web/app_test.js`: one click on a playlist row runs read, shuffle, and
  write in order; one click on the liked row does the same through the
  library read; a cache hit skips straight to the write; derived rows are
  absent while their targets are still found by the write lookup; the
  scope-gated liked row starts authorization; a zero-track source writes
  nothing; disconnect mid-chain issues no further writes. Existing
  liked-section cases are removed with the section.
- `doc/architecture/browser/APPLICATION_MODEL.md`: the unified list, the
  one-click lifecycle, the collapsed state vocabulary, and the
  pseudo-playlist branch.
- `doc/architecture/browser/AUTHORIZATION_MODEL.md`: the reconnect
  surface is the liked row.
- `README.md`: status describes the single list and one-click shuffle.

## Implementation Sequence

1. Add the pure filter and label helpers with direct tests.
2. Rewire `selectPlaylist` into the full chain and route the liked
   pseudo-playlist through it; remove the liked section code and state.
3. Remove the liked elements from `web/index.html` and update the page
   markers.
4. Migrate the harness: extend the fake page, replace the liked-section
   cases with the unified-chain cases.
5. Update the two architecture pages and the README.
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

The JavaScript tests must prove the full one-click chain for both row
kinds, the render-only nature of the derived filter (hidden row, found
target), and that the write invariant from the previous plan holds across
the unified path.

Live validation -- one click on a real playlist and on Liked Songs, each
yielding an updated derived playlist; a pre-scope token showing the
reconnect row -- follows explicit user direction, per `AGENTS.md`.

## Success Criteria

- The page shows exactly one list: Liked Songs first, non-derived
  playlists after it, derived playlists nowhere, and no two rows sharing
  a name; a note counting shadowed duplicates appears exactly when
  deduplication hid something.
- One click on any row ends with "Created" or "Updated"
  `"<name> TrueShuffle"` and the count, with progress visible during the
  read and the write; a second click on the same row re-shuffles the same
  target.
- A playlist row with a valid cache reaches the write with zero track
  requests.
- The liked section's elements, states, and parallel page state no longer
  exist in the page, the app, or the harness.
- A token without the library scope shows the reconnect row and clicking
  it starts authorization; playlist rows keep working regardless.
- The purity grep stays clean; the Go suite and every surviving
  JavaScript case pass.
- The application-model and authorization pages and the README describe
  the unified interaction.

## Execution Notes

Executed 2026-08-09. Implementation commit `2d27d30`.

Implemented as planned: `displayedPlaylists`, `likedRowLabel`, and
`emptySourceMessage` in `web/pure.js`; the liked pseudo-playlist (sentinel
id `liked-songs`), the render-time derived-name filter, the
load-shuffle-write chain (`runShuffle` over `loadPlaylistSource` /
`loadLikedSource` / `writeShuffled`), the reconnect-through-the-row gate,
and the removal of the liked section's elements, listeners, and
`likedTracks`/`likedToken` state in `web/app.js` and `web/index.html`;
the four liked page markers left `main_test.go`; the empty-account
special case is gone since the list always holds the liked row. The
harness gained a shared write backend modeling replace-versus-append
contents per target and migrated every chain-affected case.

Deviations, all bounded:

- The membership difference survives unification by composition: a pure
  `trackChangesSuffix` (extracted from `loadedTracksMessage` without
  behavior change) is appended to the final Created/Updated message when
  a cached record was replaced, so the transient loaded message no longer
  being the last render loses no information.
- The missing-write-scope stop renders a disconnect-and-reconnect
  instruction in the track status line; the previous surface for that
  gate was the liked section's reconnect button, which this plan removes,
  and the liked row's reconnect only exists for tokens missing the
  library scope.
- The "cache hit never shows the progress bar" harness case was removed
  rather than migrated: the chain's write phase uses the bar by design,
  so the property it proved no longer exists. The zero-request cache-hit
  criterion moved into the round-trip case, which now also proves the hit
  reaches the write as a `PUT` overwrite.

Validation, all passing: `gofmt -l main.go main_test.go` (no output),
`go test ./...`, `go vet ./...`, `node --check` on both web scripts,
`node --test web/pure_test.js web/app_test.js` (73 pass, 0 fail),
`git diff --check`, and the inverted purity grep.

Correction: the plan revisions `c8086f1` and `cf8ff29` -- visible-name
deduplication with the liked row counting as the first "Liked Songs",
and the conditional shadowed-duplicates note -- landed in parallel with
this execution and were missed by commit `2d27d30`. They were implemented
immediately after in the addendum commit recorded below:
`displayedPlaylists` now returns the unique-named visible rows plus the
shadowed count, the pure `shadowedRowsNote` renders the one-line note
(singular and plural) exactly when something was shadowed, the note
joins the list status line, and pure and harness cases cover first-
instance-wins, the shadowed "Liked Songs" playlist, and the note's
presence and absence (76 pass, 0 fail under the same validation set).

Deployment under the standing direction is recorded below with the
companion derived-target plan.
