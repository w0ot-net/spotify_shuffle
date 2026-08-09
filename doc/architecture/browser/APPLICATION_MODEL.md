# Application model

*Revised: 2026-08-09*

This page owns the browser application's structure: the two-script split, the
purity rule, and the structural lifecycle. Which authorization outcome
produces which page state belongs to the
[authorization model](AUTHORIZATION_MODEL.md). Return to the
[architecture index](../README.md).

## Two scripts, one global

`web/index.html` is a fixed document -- a status line, connect and disconnect
buttons, a playlist status line, and a playlist list -- that loads two
classic scripts with `defer`, in order:

1. `web/pure.js` defines a single `TrueShuffle` global containing the
   browser-independent value logic and error types: token-record building and
   validation, playlist- and track-page parsing, track URL construction and
   offset computation, track-page assembly, cache-record validation, the
   multiset track difference, label formatting, and the paging-cursor check.
2. `web/app.js` is the platform adapter. It reads `TrueShuffle` while
   loading, owns every `document`, `fetch`, storage, crypto, and history
   interaction, and wires the value logic to the page.

Script order is an invariant, not a convention: `app.js` destructures the
global at load, so a reversed pair breaks the page at startup. The served
page is tested for position, not mere presence, of the two tags.

## The purity rule

`web/pure.js` may not reference `document`, `window`, `fetch`,
`localStorage`, `sessionStorage`, `crypto`, `location`, or `history`. The
rule is greppable and is checked as part of the
[testing model](../testing/TESTING_MODEL.md); it is what lets the value
logic be tested with nothing faked. Consequences of the rule: time enters
`buildTokenRecord` as an argument, and `encodeBase64URL` stays in `app.js`
because it calls `window.btoa`.

New value logic -- anything that transforms or validates data without a
platform interface -- lands in `web/pure.js`, not in the adapter.

## Structural lifecycle

`initialize()` is the sole entry point and runs once per page load. Its
skeleton: verify Web Crypto support, load the public configuration, then
branch on whether the location is the OAuth callback or an ordinary load.
Connected paths finish by listing playlists.

The page-state vocabulary the lifecycle renders:

- connection states: working, disconnected, connected, and error (with or
  without a reconnect button);
- playlist states: loading, listed, empty account, and failure, each a
  distinct rendered message;
- track states: loading (with a determinate progress element during a
  network read), loaded count with the read's elapsed time, and failure,
  rendered in their own status line;
- liked states: reconnect required (token predates `user-library-read`),
  loadable, loading, loaded count with elapsed time, and failure, in the
  Liked Songs section's own status line.

Selecting a playlist records `{id, name}` in module-scope page state, marks
the chosen button with `aria-pressed`, and loads the playlist's ordered
track URIs cache-first: a cached record whose snapshot matches the
listing's renders with zero track requests, and otherwise the read protocol
the [Spotify integration](../integration/SPOTIFY_INTEGRATION.md) page owns
runs and its verified result is stored (see the
[data model](DATA_MODEL.md)). When a re-read replaces a cached record, the
membership difference renders as added and removed counts. A network read
shows a determinate `<progress>` element once page 0 reveals the total:
its maximum is the server-reported total, each completed page advances it
by that page's raw item count, and it hides when the load settles either
way. The numbers stay out of the `aria-live` status text so screen readers
are not spammed per page, and the loaded message reports the elapsed
seconds; a cache hit renders instantly with neither bar nor duration. One operation runs at a
time: every action button -- the playlist buttons and the Liked Songs
section's -- is disabled until the active load settles, which is also what
lets the single progress element serve every operation. A loaded Liked
Songs library lands in module-scope `likedTracks` (`{uris}`), the input
for the shuffled-playlist increment; it is page state only and is never
cached, because the library has no snapshot to validate against. Either path lands the list in module-scope
`loadedTracks` -- `{id, snapshotId, uris}` -- the attachment point for
shuffle generation (planned). A failed read clears `loadedTracks`, renders
the failure in the track status line, and leaves the listing, selection,
and stored token untouched; a late result from a read that outlives its
page state -- disconnecting mid-read -- is dropped.
