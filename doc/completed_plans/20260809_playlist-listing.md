# Plan: Playlist Listing

*Distilled: 2026-08-09*

## Summary

Read the signed-in user's Spotify playlists and render them as a selectable
list on the page. The browser calls `GET /v1/me/playlists` with the access
token it already holds, follows the paging cursor, and renders playlist names
and track counts as fixed DOM text. The Go service gains one change: the
Content Security Policy must permit connections to the Spotify Web API origin.
Selecting a playlist records the choice in the page so the next increment has
a defined attachment point; nothing is written to Spotify.

## Problem

`web/app.js` implements the full PKCE connection lifecycle and then stops. A
connected user sees "Spotify is connected in this browser." and no other
capability, so the page proves authorization works and nothing else. Every
planned behavior -- caching playlist membership, generating an order, writing
batches back -- requires a chosen playlist first, and there is currently no way
to see or choose one.

Two concrete blockers exist today:

- `contentSecurityPolicy` in `main.go:14` sets
  `connect-src 'self' https://accounts.spotify.com`. Any request to
  `https://api.spotify.com` is blocked by the browser before it is sent.
- `web/index.html` has no container for playlist output, and the granted
  `playlist-read-private` scope has never been exercised.

## Scope

In scope:

- Fetch the current user's playlists from `GET /v1/me/playlists` in the
  browser, following the `next` cursor with a bounded page count.
- Render the playlists as a selectable list of buttons showing name and track
  count, and record the selected playlist id in page state.
- Render distinct empty, loading, and failure states for the listing.
- Add `https://api.spotify.com` to the CSP `connect-src` directive.
- Update the served page contract, the browser test harness, and the README to
  match the new behavior.
- Deploy and verify through the existing repository release workflow.

Out of scope:

- IndexedDB caching, `snapshot_id` validation, shuffle generation, and playlist
  writes. This increment reads and displays only.
- Retry, backoff, or `Retry-After` scheduling. A `429` or `5xx` during listing
  is surfaced as a listing failure, consistent with the deferred follow-up
  already recorded in the OAuth hardening plan.
- Filtering the list to playlists the user can actually modify. That requires
  the current user's id from `GET /v1/me` and an ownership and collaborative
  comparison, which belongs with the write increment that depends on it.
- Reading playlist items or track metadata.
- Any CSS or visual styling. `default-src 'none'` currently permits no
  stylesheet source, so styling requires its own CSP directive and asset route.
- Liked Songs, which has no reorder API and is not a playlist resource.
- On-demand access-token refresh outside `initialize()`; see the Design
  invariant below.

## Design

**Token freshness reuses the existing invariant.** `initialize()` already
refreshes a token that is expired or within `expirySkewMilliseconds` of expiry
before it calls `renderConnected()`. Listing runs immediately after the
connection is confirmed in that same pass, on both the post-callback path and
the stored-token path, so the access token is known valid at request time. This
deliberately adds no on-demand token accessor and no second refresh path. A
long-lived open page is not a concern because listing happens only during page
initialization.

**A failed listing never destroys authorization.** The existing code clears the
stored token only on `AuthorizationRevokedError`, which is raised solely for a
parsed `invalid_grant` token response. Listing failures -- including `401` from
the Web API -- are not proof of revocation and must not clear the token record.
A failed listing leaves the page connected and shows a retry-by-reload message,
so the failure scope is the playlist section rather than the session.

**Paging is bounded and fails fast.** Request `limit=50`, the endpoint maximum,
and follow the response `next` cursor while it is a non-empty string. Guard the
loop with a maximum page count; exceeding it is an error rather than a silent
truncation, because a silently short list would later shuffle the wrong
playlist. Request only the fields the page renders.

**All Spotify-derived text is written as text.** Playlist names are attacker-
influenced strings from a third party. Build list entries with
`document.createElement` and assign `textContent`; never assign `innerHTML` or
build markup from response data. This preserves the existing no-inline-script
posture that the CSP enforces.

**Selection is page state, not storage.** The selected playlist id lives in a
module-scope variable and is reflected on the chosen button with
`aria-pressed`. It is not persisted, because the next increment will define
what persistence means once caching exists. Selecting a playlist performs no
network request.

**CSP change is additive and narrow.** `connect-src` gains exactly
`https://api.spotify.com`. No other directive changes, and no third-party
origin is introduced.

## Affected Components

- `main.go`: add `https://api.spotify.com` to the `contentSecurityPolicy`
  `connect-src` directive so browser requests to the Spotify Web API are
  permitted.
- `main_test.go`: `assertBrowserSecurityHeaders` compares against the
  `contentSecurityPolicy` constant and would not catch a wrong value, so add a
  literal assertion that `connect-src` permits both the accounts origin and the
  Web API origin; extend the `TestAppPage` marker list with the new container
  id.
- `web/index.html`: add the playlist list container and its status line as
  fixed, initially hidden elements.
- `web/app.js`: add the paged playlist request, list rendering, selection
  state, and the listing loading, empty, and failure states; invoke listing
  from the two connected paths in `initialize()`.
- `web/app_test.js`: the fake `fetch` throws on any unrecognized URL and the
  fake `document` resolves only `status`, `connect`, and `logout`, so both must
  be extended before any existing test passes; add coverage for a paged
  successful listing, an empty listing, and a listing failure that leaves the
  stored token intact.
- `README.md`: the Status section states the page "does not yet read or modify
  playlists" and must describe listing; the Browser security section must name
  the added API origin; the scopes paragraph must stop describing
  `playlist-read-private` as unused.

No change is expected in the Go route table, the token storage model, the
OAuth scopes, systemd, Apache, DNS, TLS, or the Spotify application
configuration.

## Implementation Sequence

1. Extend `contentSecurityPolicy` in `main.go` and add the literal `connect-src`
   assertion in `main_test.go`.
2. Add the playlist container and status line to `web/index.html` and extend
   the `TestAppPage` marker list.
3. Implement paged fetching, rendering, and selection in `web/app.js`, wired
   into both connected paths of `initialize()`.
4. Extend the `web/app_test.js` harness with the playlist endpoint and DOM
   elements, then add the listing cases.
5. Update the README Status, Browser security, and scopes text.
6. Run the validation commands and inspect the diff for scope growth.
7. Commit and push. Deployment is a separate, gated step: it requires explicit
   user direction and the machine-local private operations runbook named in
   `AGENTS.md`. Landing the code does not authorize it.

## Validation

Local:

```sh
gofmt -l main.go main_test.go
go test ./...
go vet ./...
node --check web/app.js
node --test web/app_test.js
git diff --check
```

The Go tests must prove the served CSP permits `https://api.spotify.com` and
still permits `https://accounts.spotify.com`. The JavaScript tests must prove a
two-page listing renders every playlist in order, an empty listing renders the
empty state, and a failed listing leaves the `localStorage` token record
present.

Manual browser validation, only with explicit user authorization to use a
live Spotify account, per `AGENTS.md`:

- Load the page while connected and confirm the playlists render with correct
  names and track counts.
- Confirm selecting a playlist marks it and issues no network request.
- Confirm the browser console reports no CSP violation.

The paging, empty, failure, and selection paths are proven deterministically
by `web/app_test.js`; those tests are the required evidence for them, and no
particular live account shape (more than 50 playlists, or none) is a
completion requirement.

Deployment validation, only once deployment is separately authorized and
performed under the private operations runbook:

- Verify the release binary's embedded clean Git revision before activation.
- Confirm `trueshuffle.service` is active with no restart loop.
- Confirm `/healthz` and the public HTTPS routes still respond.
- Confirm the deployed response `Content-Security-Policy` header contains the
  API origin.

No Spotify playlist is created, modified, or deleted during validation.

## Success Criteria

- A connected user's playlists are listed on the page with name and track
  count. Multi-page correctness is proven by the deterministic paging test,
  or by a live multi-page account when the user authorizes one.
- Selecting a playlist visibly marks it and records the id in page state.
- An empty playlist set, and a failed listing, each render a distinct state
  rather than a blank or broken page.
- A listing failure leaves the stored token record intact and the session
  connected.
- The served CSP permits the Spotify Web API origin and no other new origin.
- The README describes listing as implemented behavior and no longer claims
  playlists are unread.
- The deployed service is healthy and the existing connect, callback, reload,
  and disconnect flows continue to work.

## Execution Status

Implementation landed in `eae9283` (`List Spotify playlists on the page`).
Steps 1 through 6 of the sequence are complete; step 7 is not.

Implemented as planned, with one bounded correction: `fetchPlaylists` requires
the `next` cursor to start with the `/v1/me/playlists` endpoint prefix before
following it. The plan said to follow the cursor while it is a non-empty
string, which would send the bearer token to whatever URL the response names.
The prefix check keeps the paging design and closes that exposure.

Local validation, all passing:

- `gofmt -l main.go main_test.go`: no output.
- `go test ./...`: ok.
- `go vet ./...`: ok.
- `node --check web/app.js`, `node --check web/app_test.js`: ok.
- `node --test web/app_test.js`: 16 passed, 0 failed.
- `git diff --check`: clean.

Deployment, completed 2026-08-09 with explicit user direction under the
private operations runbook:

- Deployed as one release together with the browser pure-logic module change.
  The release revision is `869dbf8d969e4a299b118255808ab9af9b130486`, whose
  tree contains this plan's implementation commit `eae9283`; the binary's
  embedded `vcs.revision` matches and `vcs.modified` is false. Binary SHA-256
  `78800302947438eb9027e956cedd84fd3bfdc29889356d52ae2363ea2134fc1b`.
- The production checkout fast-forwarded cleanly, and the full Go and
  JavaScript suites passed on the host (25 of 25 browser tests via direct
  `node` execution per the host's recorded `node --test` limitation).
- The previous release `7814648...` was retained and the `current` symlink
  switched atomically. After restart: service active with zero restarts,
  listener on `127.0.0.1:5107` only, loopback and public `/`, `/healthz`,
  `/api/config` all healthy, and no warning-or-higher journal entries.
- The deployed `Content-Security-Policy` header now includes
  `connect-src 'self' https://accounts.spotify.com https://api.spotify.com`,
  verified on the public origin.
- One deviation from the runbook's recorded access details: its SSH target
  named a machine whose host key does not match production. The correct
  target was established by DNS resolution and `known_hosts` fingerprint
  comparison before any connection, and the runbook has been corrected
  outside the repository.

Manual browser validation against a live Spotify account remains conditional
on explicit user authorization and was not performed; the deterministic tests
in `web/app_test.js` are the recorded evidence for the paging, empty,
failure, and selection paths.
