# Plan: Safe Managed Playlist Targets

## Summary

Make a source's Spotify identity, recorded in a structured target description,
the authority for selecting the playlist TrueShuffle may overwrite. Playlist
names remain presentation and creation defaults only. Existing targets created
with the current generic description are adopted before their contents change,
while unmarked name collisions and ambiguous candidates fail safely.

## Problem

The current write path treats the name `<source name> TrueShuffle` as proof of
ownership. Any playlist with that name can be overwritten, whether or not
TrueShuffle created it. The same name-based rule hides unrelated suffix-named
playlists, makes duplicate source names unshuffleable, and loses the stable
target when a source is renamed.

New targets already receive the exact description `Created by TrueShuffle`,
and Spotify's current playlist listing returns descriptions. Spotify also
allows multiple playlists with the same name. The existing response therefore
contains enough state to replace the unsafe name inference without adding a
server registry or browser mapping.

## Scope

In scope:

- Define a versioned, exact managed-target description bound to either a
  playlist source id or the Liked Songs source kind.
- Retain playlist descriptions from the normal page-load listing and use the
  marker, never the name alone, to select an overwrite target.
- Create new targets with the structured description.
- Safely adopt one legacy target only when both its name and its description
  exactly match the old TrueShuffle contract; persist the structured marker
  before changing any track contents.
- Refuse to write when multiple structured or legacy candidates make target
  ownership ambiguous.
- Leave an unmarked same-name playlist untouched and create a separately
  managed target, relying on Spotify's supported duplicate names.
- Hide structured and exact legacy targets from the source list, but show
  arbitrary suffix-named playlists and every duplicate-named source.
- Update telemetry, tests, current architecture, and user-facing guarantees
  required by the changed ownership and migration contract.
- Replace the page's absolute no-duplicates claim with the accurate sequential
  reuse guarantee.

Out of scope:

- A server-side ownership registry, new IndexedDB state, or an account/profile
  request.
- Automatic deletion or merging of duplicate targets left by old concurrent
  tabs or devices.
- Cross-tab or cross-device locking around target creation; a later listing
  must detect duplicate managed markers and refuse an ambiguous overwrite.
- Changes to track caching, shuffle randomness, batching, rate-limit policy,
  or empty-source behavior.
- Implementing the independent playlist-name filter.

## Design

### Marker and source identity

`web/pure.js` owns one exact ASCII description format with an explicit version.
The source key is `playlist:<id>` for a listed playlist and a fixed `liked`
key for Liked Songs. Marker construction must reject an empty or malformed
source identity, and managed-description recognition must accept only the
exact versioned shape. The description contains no token, account identity,
track URI, or source name.

`readPlaylistPage` retains a string description or `null` beside each
playlist's existing id, name, total, and snapshot. Target matching compares the
complete expected marker for the selected source; it does not parse a name or
persist derived ownership state elsewhere.

### Target resolution and migration

Before shuffling or mutating a target, resolve against the retained listing:

1. Exactly one playlist with the selected source's structured marker is the
   managed target, regardless of its current name.
2. More than one structured match is an error and sends no target write.
3. With no structured match, exactly one playlist whose description is exactly
   `Created by TrueShuffle` and whose name is the exact derived name is a
   legacy candidate. Update its description to the structured marker before
   changing its items, then use it as the target.
4. Multiple legacy candidates are ambiguous and send neither a details update
   nor an item write.
5. With no managed or legacy candidate, create a private target under the
   derived name and structured description. An unmarked same-name playlist
   does not block creation and is never selected.

When a structured target's name differs because the source was renamed, update
the managed target's name to the current derived name before changing items.
This preserves the existing naming contract without creating a second target.
Because changing playlist details returns an empty successful response, extend
the existing paced Spotify request owner with an explicit empty-response mode;
do not bypass its cancellation, cooldown, retry, or telemetry behavior.

The metadata update gets one bounded telemetry role mapped to the existing
`playlist-metadata` endpoint class and `PUT` method. It changes no stored schema
and carries no source or target identity.

### Display behavior

The source display filter hides only playlists with a valid structured marker
or the exact legacy description. Remove suffix-only hiding, name deduplication,
the shadowed-count result, and its status suffix. Duplicate names are safe once
the source id determines the marker, and user playlists that merely end in
` TrueShuffle` remain usable sources.

The still-active playlist-filter plan must be revised to consume the new
display result and to stop relying on duplicate-name shadowing. Its text-filter
outcome remains independent and is not implemented here.

### Documentation and compatibility

The README and architecture must say that the structured marker, not the
suffix, authorizes writes; the derived name is the creation/current-name
contract. Document the one-time legacy adoption and the fail-safe ambiguity
behavior. Do not describe the client-only creation path as immune to concurrent
cross-device duplicate creation.

The implementation should cite the current Spotify contracts used by this
design:

- <https://developer.spotify.com/documentation/web-api/reference/get-a-list-of-current-users-playlists>
- <https://developer.spotify.com/documentation/web-api/reference/create-playlist>
- <https://developer.spotify.com/documentation/web-api/reference/change-playlist-details>

## Affected Components

- `web/pure.js`: own marker construction/recognition, playlist-description
  parsing, target resolution helpers, display filtering, and the details URL.
- `web/app.js`: resolve, create, adopt, and rename only marked targets through
  the paced request lane; remove name-shadow status handling.
- `web/pure_test.js`: cover exact marker validation, description parsing,
  marker-based resolution, ambiguity, and display behavior.
- `web/app_test.js`: prove safe collision handling, legacy adoption order,
  source renames, duplicate source names, ambiguity failure, and empty-response
  metadata updates.
- `telemetry.go` and `telemetry_test.go`: accept and validate the bounded target
  details-update role without changing the SQLite schema.
- `web/index.html` and `main_test.go`: make the static reuse claim accurate and
  keep its served-page contract covered.
- `README.md`: state the safe ownership, naming, and migration behavior.
- `doc/architecture/browser/APPLICATION_MODEL.md`: replace suffix/name display
  and lookup invariants with marker/source-id invariants.
- `doc/architecture/integration/SPOTIFY_INTEGRATION.md`: document description
  metadata, the details endpoint, resolution order, and failure posture.
- `doc/plans/20260810_playlist-name-filter.md`: update assumptions affected by
  the new display result; do not implement its filter behavior.

## Implementation Sequence

1. Add and directly test the marker, parsed description, target-resolution,
   details-URL, and display value logic.
2. Add empty-response support and the bounded metadata telemetry role to the
   existing request lane and server validator.
3. Replace name-based target lookup with the safe resolution and migration
   sequence, then remove shadowed-name UI handling.
4. Add browser wiring tests covering every branch before updating current
   documentation and the dependent active plan.

## Validation

```sh
gofmt -l telemetry.go telemetry_test.go
go test ./...
go vet ./...
node --test web/pure_test.js web/app_test.js
git diff --check
! grep -nE 'document|window|fetch|localStorage|sessionStorage|crypto|location|history' web/pure.js
```

No live Spotify account or remote deployment is required for validation.

## Success Criteria

- A playlist without an exact TrueShuffle description marker is never hidden
  or overwritten merely because of its name.
- A source rename and duplicate-named sources continue to use distinct stable
  targets identified by source id.
- One legacy target is marked before its first post-migration item write;
  ambiguous candidates fail before any target mutation.
- New targets carry the structured marker and are reused on the next shuffle.
- Target details updates retain the request lane's pacing, cancellation,
  retry, cooldown, and sanitized telemetry guarantees.
- Current documentation and the active filter plan describe the new contract,
  and all focused validation passes.
