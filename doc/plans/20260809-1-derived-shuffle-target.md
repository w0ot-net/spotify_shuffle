# Plan: Derived Shuffle Target

## Summary

Shuffled output stops accumulating timestamped playlists and instead lands
in one derived playlist per source, named `<source name> TrueShuffle`:
created when absent, overwritten in place when present. The suffix is the
app's ownership claim -- the only playlists this app ever writes are ones
carrying it -- so source playlists stay untouchable by construction. The
existing Liked Songs shuffle becomes the first consumer, targeting
"Liked Songs TrueShuffle".

## Problem

`createShuffledPlaylist` in `web/app.js` names each run
`"Liked Shuffle " + timestamp` and always creates, so every shuffle adds
another playlist to the user's library. The intended interaction --
re-shuffle whenever you like -- makes that clutter unbounded. There is
also no way to shuffle into a stable playlist a user can pin in Spotify
clients and simply see reordered.

The write flow also cannot express "replace": `requestSpotify` supports
GET and POST only, and nothing looks up an existing playlist by name.

## Scope

In scope:

- Derive the target name in `web/pure.js`: source name plus the
  ` TrueShuffle` suffix, with a lookup that finds the first exact-name
  match in the listed playlists.
- Retain the fetched playlist listing in module scope so the lookup has a
  source, and append a created target to it so a second shuffle in the
  same page load overwrites instead of duplicating.
- Overwrite protocol: the first URI batch goes by `PUT` to
  `/v1/playlists/{id}/tracks`, replacing the entire contents, and the
  remaining batches append by `POST` sequentially, followed by the
  existing total verification. Creation keeps today's create-then-append
  path but uses the derived name.
- `requestSpotify` accepts an explicit method so `PUT` is expressible.
- A result message distinguishing "Created" from "Updated", replacing the
  timestamped-name builder and its message.
- Update the Liked Songs shuffle button label to match the overwrite
  behavior.
- Tests for the name derivation, lookup, overwrite request sequence,
  create-when-absent, and same-page-load second shuffle; architecture and
  README migration.

Out of scope:

- The unified one-click list, Liked Songs placement, and hiding derived
  playlists from the list: the follow-up plan
  `20260809-2-unified-shuffle-list.md`.
- Migrating or deleting previously created "Liked Shuffle ..." playlists;
  they remain inert in the user's library.
- A stored source-to-target id mapping. Targets are identified by name,
  accepting that duplicate-named sources share a target and that the
  first match wins when the target name itself is duplicated.
- Cross-device freshness. The lookup sees the listing fetched at page
  load; a target created elsewhere afterward can be missed and duplicated
  once, the page-load freshness contract the listing already has.

## Design

**The suffix is an ownership invariant, not a convention.** Every playlist
id the write flow touches is either returned by the create call it just
made or found in the listing under a name equal to
`derivedPlaylistName(source)`. No other id ever reaches a write URL, so a
user playlist without the suffix is unreachable by construction, and the
worst any failure can strand is a partial playlist the app owns.

**Overwrite is self-healing.** The first batch is a full-contents `PUT`,
so a rerun after any mid-write failure starts from a clean replacement,
never appends onto wreckage. The failure message can therefore say
"shuffle again" honestly for both create and overwrite paths. Batches stay
sequential because arrival order is the shuffled order.

**Name matching is exact and case-sensitive.** The lookup compares the
listing's rendered names -- including the "Untitled playlist" placeholder
the listing reader substitutes -- against the derived name with `===`.
First match wins; the plan accepts the duplicate-name consequences named
under scope.

**The scope story changes honestly.** `playlist-modify-private` covers
targets the app created. A user may later make a derived playlist public
in Spotify, and overwriting it then requires `playlist-modify-public` --
which is why that scope stays granted; it is no longer "held for the
in-place shuffle", a plan this direction retires.

**Failure scope.** Lookup happens before any write; a failed create leaves
nothing; a failed overwrite leaves the derived target partially rewritten
and named in the message with a rerun offered; source playlists and the
cache are never touched by the write flow.

## Affected Components

- `web/pure.js`: `derivedPlaylistName`, the exact-name lookup over listed
  playlists, and the created-versus-updated result message; delete
  `shuffledPlaylistName`-adjacent timestamp naming (`createdPlaylistMessage`)
  in favor of the new message.
- `web/app.js`: retain the listing in module scope; `requestSpotify`
  method parameter; the create-or-overwrite branch and `PUT`-then-append
  sequence in the shuffle flow; delete `shuffledPlaylistName`.
- `web/index.html`: the Liked Songs shuffle button label reflects
  overwrite ("Shuffle Liked Songs").
- `web/pure_test.js`: derivation and suffix cases, lookup first-match and
  no-match, message wording for both paths.
- `web/app_test.js`: overwrite path issues `PUT` for batch one and `POST`
  for the rest against the found target id; create path when no name
  matches; a second shuffle in the same page load overwrites the target
  created moments earlier; a mid-overwrite failure names the target.
- `main_test.go`: the served-page marker for the relabeled button if the
  current marker names the old label.
- `doc/architecture/integration/SPOTIFY_INTEGRATION.md`: the write flow
  becomes create-or-overwrite with the `PUT` replacement, the ownership
  invariant, and the revised scope rationale.
- `doc/architecture/browser/APPLICATION_MODEL.md`: shuffle states name
  the derived target and the created/updated distinction.
- `README.md`: status describes the stable derived playlist and that
  sources are never modified.

## Implementation Sequence

1. Add the pure helpers and their direct tests; remove the timestamp
   naming.
2. Extend `requestSpotify` with the method parameter.
3. Retain the listing, implement the lookup and the create-or-overwrite
   write sequence, and relabel the button.
4. Extend the harness write cases.
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

The JavaScript tests must prove: no write request ever targets an id other
than the created playlist's or a listing entry bearing the exact derived
name; the first overwrite batch is a `PUT` and later batches are `POST`s;
and the second-shuffle-overwrites case passes without a page reload.

Live validation -- shuffling Liked Songs twice and confirming a single
"Liked Songs TrueShuffle" whose order changed -- follows explicit user
direction, per `AGENTS.md`.

## Success Criteria

- Shuffling Liked Songs creates "Liked Songs TrueShuffle" when absent and
  overwrites exactly that playlist when present, reporting "Created" or
  "Updated" with count and elapsed time.
- Repeated shuffles never add playlists beyond the one derived target.
- No write request can address a playlist lacking the ` TrueShuffle`
  suffix, proven by the harness request log across every write case.
- A failed overwrite names the target and a rerun fully replaces its
  contents.
- The purity grep stays clean; unrelated existing tests pass unmodified.
- The integration and application-model pages and the README describe the
  derived-target behavior and the revised scope rationale.
