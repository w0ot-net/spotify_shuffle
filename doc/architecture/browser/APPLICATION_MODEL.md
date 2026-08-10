# Application model

*Revised: 2026-08-10*

This page owns the browser application's structure: the two-script split, the
purity rule, and the structural lifecycle. Which authorization outcome
produces which page state belongs to the
[authorization model](AUTHORIZATION_MODEL.md). Return to the
[architecture index](../README.md).

## Two scripts, one global

`web/index.html` is a fixed document -- a visual-background selector, a
status line, connect and disconnect buttons, a playlist status line, a
track status line, a progress element, and the source list, plus two
static fine-print lines: a connect note (permissions and the
tokens-stay-in-this-browser fact, visible exactly when Connect is, by a
stylesheet rule) and a workspace note (the derived-copy contract, the
never-modified guarantee, and page-load freshness) -- that loads two
classic scripts with `defer`, in order:

1. `web/pure.js` defines a single `TrueShuffle` global containing the
   browser-independent value logic and error types: token-record building and
   validation, playlist- and track-page parsing, track URL construction and
   offset computation, track-page assembly, cache-record validation, the
   visual-background choice validation, the multiset track difference, the
   Fisher-Yates shuffle, derived-name
   derivation and lookup, the display filter, label and message formatting,
   and the paging-cursor check.
2. `web/app.js` is the platform adapter. It reads `TrueShuffle` while
   loading, owns every `document`, `fetch`, storage, crypto, and history
   interaction, and wires the value logic to the page.

Script order is an invariant, not a convention: `app.js` destructures the
global at load, so a reversed pair breaks the page at startup. The served
page is tested for position, not mere presence, of the two tags.

Each listing and each shuffle chain also assembles one sanitized telemetry
report -- request roles, timing, statuses, workload numbers, and the
page-lifetime rolling 30-second request count -- delivered unawaited when
the operation settles. Delivery is acknowledged, not fire-and-forget: the
encoded report enters a four-entry queue (see the
[data model](DATA_MODEL.md)) before transport, a drain pass triggered by
page initialization and each enqueue submits oldest-first, and only the
server's `204` removes an entry -- reloads and overlapping tabs retry
safely against the server's idempotent report ids. Without usable queue
storage the report degrades to a one-shot send that says so. Queue,
storage, and transport failure are all contained in the delivery owner;
telemetry can never change what an operation does or renders. The bounded
vocabulary lives in `web/pure.js`; the
[security model](../security/SECURITY_MODEL.md) owns what may never appear
in a report.

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
skeleton: restore the optional visual-background preference, verify Web Crypto
support, load the public configuration, then branch on whether the location is
the OAuth callback or an ordinary load. Connected paths finish by listing
playlists. Background changes apply immediately and persist when local storage
works; invalid or unavailable storage falls back to the original Ribbon image
without affecting authorization or Spotify work.

The page-state vocabulary the lifecycle renders:

- connection states: working, disconnected, connected, and error (with or
  without a reconnect button; the kept-token refresh-failure error also
  offers the disconnect button as its escape);
- list states: loading, listed (always at least the Liked Songs row), and
  failure;
- chain states, all in the track status line: loading (with the
  determinate progress element during a network read), loaded count with
  the read's elapsed time, no-tracks, cap exceeded, writing (the bar
  tracks written batches), created or updated (naming the derived target
  with count, elapsed time, and the membership difference when a cached
  record was replaced), incomplete (naming the target with a rerun
  offered), cancelled (naming the possibly partial target when writing
  had begun), and failure;
- the waiting state: whenever the request lane pauses beyond its routine
  gap, a dedicated line counts down "Spotify asked us to slow down --
  retrying in Ns." and disappears the moment the wait ends. Like the
  progress bar it is visual-only, so screen readers hear outcomes, not
  ticks.

## The one gesture

The page is one list: Liked Songs first, then the account's playlists with
the app's own derived ` TrueShuffle` playlists hidden by a render-time
filter -- display filtering only, because the retained listing must keep
derived entries for the write flow's target lookup. Visible names are also
unique: only the first instance of each name renders, in listing order,
with the Liked Songs row counting as the first "Liked Songs", so no two
clickable rows can share a derived target. A shadowed duplicate is
unshuffleable until renamed in Spotify -- an accepted cost, but not a
silent one: when deduplication hides anything, the list status line
carries a one-line note counting the hidden rows, while the routine
hiding of derived targets goes unannounced. Liked Songs is a
pseudo-playlist entering the shared selection flow with a sentinel id (a
hyphen cannot appear in a Spotify id, so it can never collide), not a
parallel code path.

Clicking a row records the selection, marks the button with
`aria-pressed`, and runs one chain: load, shuffle, write. Playlist rows
load cache-first -- a cached record whose snapshot matches the listing's
reaches the write with zero track requests, and otherwise the read
protocol the [Spotify integration](../integration/SPOTIFY_INTEGRATION.md)
page owns runs and its verified result is stored (see the
[data model](DATA_MODEL.md)). The Liked Songs row loads through the
library read, cache-first like playlist rows but under the fingerprint
validity rule the [data model](DATA_MODEL.md) owns, since the library has
no snapshot: a fingerprint match costs one page-0 request and reuses the
cached URIs. A loaded source with zero tracks reports that
and writes nothing; otherwise the chain Fisher-Yates-shuffles the URIs
with crypto-backed unbiased randomness (the pure shuffle takes the
randomness as an argument) and writes the source's derived target --
created when absent, replaced in full when present. The fetched listing is
retained in module scope as the target lookup, and a created target joins
it so a repeat click overwrites instead of duplicating.

A token predating `user-library-read` renders the Liked Songs row as the
reconnect action -- the ordinary authorization flow -- while playlist rows
keep working (see the [authorization model](AUTHORIZATION_MODEL.md)).

One operation runs at a time: every row is disabled until the active
chain settles, which is what lets the single progress element serve the
read and write phases in turn. A Cancel button accompanies every active
chain -- it aborts the same per-operation controller disconnect uses, so
no second cancellation pathway exists; a cancelled chain renders
"Cancelled." and re-enables the rows immediately. The bar is determinate from the moment it
appears -- its maximum is the server-reported total (or the write's URI
count) and its numbers stay out of the `aria-live` status text so screen
readers are not spammed per step. The loaded list sits in module-scope
`loadedTracks` (`{id, snapshotId, uris}`). A failed load or write renders
in the track status line and leaves the listing, the cache, the selection,
and the stored token untouched; disconnecting mid-chain aborts the chain's
controller, so its pending wait or fetch rejects and nothing further --
no page, no write batch -- is dispatched, while any late result is
dropped. Requests themselves flow through the serial paced lane the
[Spotify integration](../integration/SPOTIFY_INTEGRATION.md) page owns; an
active long cooldown renders its absolute retry time in the status line
instead of issuing a request.
