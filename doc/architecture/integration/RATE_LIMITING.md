# Spotify rate limiting: confirmed facts

*Revised: 2026-08-10*

This page records what is actually known about Spotify Web API rate
limiting, because the limits themselves are unpublished and folklore is
easy to mistake for fact. Every statement here carries its evidence class:

- **[doc]** -- stated by Spotify's own documentation, retrieved and quoted
  on 2026-08-10.
- **[observed]** -- observed first-hand on this app's production
  registration.
- **[code]** -- a property of this repository, verifiable at the cited
  location.
- **[deduction]** -- follows necessarily from cited facts; the premises
  are named.

Anything not supportable at one of those levels lives in
"What remains unknown". Return to the [architecture index](../README.md);
the app's own request behavior is specified in
[Spotify integration](SPOTIFY_INTEGRATION.md).

## What Spotify documents

Source: [Rate Limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits)
(retrieved 2026-08-10).

- The limit is app-scoped, not user-scoped: "Spotify's API rate limit is
  calculated based on the number of calls that your app makes to Spotify
  in a rolling 30 second window." **[doc]**
- Exceeding it produces `429` responses. The `429` "will normally include
  a `Retry-After` header with a value in seconds" -- "normally", so the
  header is not guaranteed. **[doc]**
- Per-endpoint limits exist but are not enumerated: "A few API endpoints,
  like the playlist image upload endpoint, have a custom rate limit."
  **[doc]**
- No numeric limit is published for any mode or endpoint. **[doc]**
- Spotify's own mitigation advice: apply for extended quota mode, use a
  backoff-retry strategy, use batch APIs, use `snapshot_id`, study request
  patterns, lazy-load. **[doc]**

Source: [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
(retrieved 2026-08-10).

- Development mode (the default, and this app's current mode): "Up to 5
  authenticated Spotify users can use an app that is in development
  mode", each added to the app's allowlist first, and "the app owner must
  have a Spotify Premium account". **[doc]**
- Extended quota mode allows unlimited users and "a higher rate limit
  than development mode apps". **[doc]**
- Since May 15, 2025, Spotify "only accepts applications from
  organizations (not individuals)" for extended quota mode, via a form
  submitted "through a company email"; review "can take up to six
  weeks". **[doc]**

Source: [Web API changelog, July 2026](https://developer.spotify.com/documentation/web-api/references/changes/july-2026)
(retrieved 2026-08-10).

- "API quotas for development mode are now counted per developer account
  rather than per Client ID." A second registration under the same
  developer account therefore shares this app's quota buckets. **[doc]**
- A quota-exceeded `429` carries a body with `"reason":
  "QUOTA_EXCEEDED"`. **[doc]** This app's telemetry records that field
  (`normalizeSpotifyReason`, [`web/pure.js`](../../../web/pure.js)), so
  future incidents can distinguish quota exhaustion from short-window
  throttling. **[code]**
- Accounts may now hold up to 25 Client IDs (previously 1). **[doc]**

## What this app has observed

On 2026-08-09, on the production registration, 5-10 operator-initiated
Liked Songs shuffles were enough that `GET /v1/me/tracks` returned `429`
for roughly 24 hours, while playlist endpoints (`/v1/me/playlists`,
`/v1/playlists/...`) kept succeeding for the same app and account
throughout. **[observed]** Enforcement in practice is therefore scoped
at least per endpoint, not only per app-wide window -- consistent with
the documented existence of unenumerated custom endpoint limits.
**[deduction]**

Those `429`s carried no valid numeric `Retry-After`. Premises: the app
stores any valid `Retry-After` (a plain 1-6 digit seconds value,
[`web/pure.js`](../../../web/pure.js) `normalizeRetryAfter`) as a single
global cooldown deadline that blocks every Spotify call until it expires
([`web/app.js`](../../../web/app.js) `storeCooldown` /
`activeCooldownUntil`); a 24-hour value fits that parser; playlist calls
were not blocked. Had Spotify advertised the real penalty, the app would
have paused everything -- playlists kept working only because the header
was absent or unparseable and the app fell back to its 30-second
cooldown. **[deduction]**

Production telemetry captured the incident's per-request evidence
(roles, statuses, `Retry-After` state, page offsets, rolling window
counts) and has not yet been analyzed; analysis would replace the
deduction above with recorded values. **[observed]**

## Why Liked Songs is the exposed surface

These are properties of this repository, not of Spotify:

- Every browser paces itself to one request in flight with at least
  250 ms between starts ([`web/app.js`](../../../web/app.js),
  `minStartGapMs`) -- at most ~4 requests/second per user. Pacing and
  cooldown state are per-browser; nothing coordinates across users, so
  aggregate pressure on the shared app quota scales with concurrent
  users. **[code]**
- A cold Liked Songs read costs `ceil(total/50) + 1` requests (50-item
  pages plus a closing fingerprint probe); a cache hit costs exactly 1.
  The cache is written only after a complete verified read
  ([`web/app.js`](../../../web/app.js) `loadLikedSource`), so a read
  that fails mid-way -- including by `429` -- is restarted from offset 0
  on the next attempt. Repeated attempts against a throttled endpoint
  are therefore maximally expensive precisely when the endpoint is
  least willing. **[code]**
- Playlist reads reuse their cache at zero track-request cost when the
  `snapshot_id` is unchanged; Liked Songs has no snapshot, which is why
  its verification spends requests at all (see
  [Spotify integration](SPOTIFY_INTEGRATION.md)). **[code]**
- On `429` the app replays once when the advertised wait is at most 60
  seconds, and otherwise surfaces the pause; without a valid
  `Retry-After` the cooldown is 30 seconds
  ([`web/pure.js`](../../../web/pure.js), cooldown policy). During a
  multi-hour server-side penalty this understates the real wait and
  permits periodic doomed retries. **[code]**

Combined with the account-scoped quota facts above: one user repeatedly
cold-reading a large library can exhaust the development-mode quota for
`/v1/me/tracks` for every user of the app -- and of every Client ID under
the same developer account -- for the duration of Spotify's penalty.
**[deduction]**

## What remains unknown

Spotify publishes none of the following; nothing in this repository or
its telemetry has yet established them either:

- Numeric request limits for either quota mode.
- Which endpoints carry custom limits, their quotas, or their windows.
- Penalty durations, escalation rules, or when `Retry-After` is present
  versus absent.
- Whether penalties attach to app+endpoint, account+endpoint, or also
  per-user dimensions beyond the app scoping documented above.

Developer-community threads describe multi-hour `Retry-After` values and
endpoint-scoped lockouts resembling the 2026-08-09 incident, but
community.spotify.com refuses non-browser retrieval, so their content
could not be independently verified and is deliberately not cited as
fact here.

Analyzing the recorded 2026-08-09 telemetry is the one available step
that converts unknowns above into facts for this app's actual traffic.
