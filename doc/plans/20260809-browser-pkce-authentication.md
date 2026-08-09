# Plan: Browser PKCE Authentication

## Summary

Add a complete Spotify connection flow to the existing deployed page using
Authorization Code with PKCE. The browser will keep the Spotify token set in
`localStorage`, temporary OAuth correlation values in `sessionStorage`, and the
Go server will expose only the public Spotify client ID and static application
assets. The authenticated origin will enforce a strict no-third-party-script
boundary so that browser-held refresh tokens are not exposed to advertising or
analytics code.

## Problem

The application currently serves a static message that Spotify is not
configured. It has no authorization route, browser token lifecycle, connection
state, or production callback registration, so it cannot obtain the user grant
needed for later playlist operations. The previously considered server-side
token file is unnecessary for the chosen browser-owned PKCE design.

## Scope

In scope:

- Configure the Go process with a public Spotify client ID and fail at startup
  when it is absent.
- Serve the same browser application at `/` and `/callback`, an external
  first-party JavaScript asset, and a small same-origin JSON configuration
  endpoint.
- Implement Authorization Code with PKCE in browser JavaScript using Web Crypto
  and Spotify's authorization and token endpoints.
- Store the one-time OAuth `state` and PKCE verifier in `sessionStorage` and
  validate and delete them when processing the callback.
- Store the access token, refresh token, granted scope, and computed expiration
  time under one versioned `localStorage` key.
- Refresh an expired or nearly expired access token in the browser, preserving
  the existing refresh token when Spotify does not return a replacement.
- Provide minimal disconnected, connecting, connected, error, and logout
  states without fetching a Spotify profile or playlist.
- Request only the playlist scopes needed by the next playlist-management
  increment: `playlist-read-private`, `playlist-modify-public`, and
  `playlist-modify-private`.
- Apply restrictive browser security headers that allow only first-party
  scripts and the Spotify token connection required by this flow.
- Document the browser token model, configuration, storage-clearing behavior,
  and the invariant that the authenticated origin must not load advertisements,
  analytics, or other third-party JavaScript.
- Register `https://shuffle.p.a-9.co/callback` in the existing Spotify app,
  configure the deployed service with its client ID outside Git, deploy the
  implementation through the remote checkout, and validate sign-in over HTTPS.

Out of scope:

- Reading Spotify profiles, playlists, Liked Songs, tracks, or snapshots.
- IndexedDB playlist caching, incremental synchronization, shuffle generation,
  playlist writes, background jobs, progress reporting, and API rate-limit
  handling.
- Passing access tokens to Go; during this increment Spotify token traffic is
  directly between the browser and Spotify.
- Server-side token persistence, cookies, sessions, SQLite, multi-user account
  records, centralized logout, or token revocation.
- Advertising integration, an advertising hostname, consent management,
  analytics, or a privacy-policy implementation. Any later advertising must be
  isolated on another origin and must not receive Spotify data.
- A frontend framework, package manager, JavaScript bundler, service worker, or
  browser-automation test suite.
- Committing Spotify credentials, tokens, deployment environment files,
  systemd configuration, or binaries.

## Design

Keep the existing Go server as a small embedded-asset owner. `main` reads
`SPOTIFY_CLIENT_ID`, rejects an empty value before listening, and passes the
validated value to the handler. The client ID is public OAuth configuration,
not a secret; expose it through `GET /api/config` with `Cache-Control: no-store`
rather than compiling a deployment-specific value into the page. The app does
not read or require `SPOTIFY_CLIENT_SECRET`.

Serve `web/index.html` for exact `GET /` and `GET /callback` requests and serve
an embedded `web/app.js` with the correct JavaScript content type. The callback
is a client-side application state, so it does not need a separate Go callback
implementation. The redirect URI is always computed as
`window.location.origin + "/callback"`; therefore the local and production
redirects must each be registered exactly in Spotify's allowlist.

The page starts authorization by generating cryptographically random `state`
and PKCE verifier values, deriving the S256 code challenge with Web Crypto,
placing the state and verifier in `sessionStorage`, and navigating to Spotify.
On callback, it handles Spotify denial explicitly, requires an exact state
match, consumes the stored correlation values, and exchanges the code with the
PKCE verifier. Callback query parameters must be removed from the visible URL
after processing so authorization codes and error values do not remain in
history.

Persist one JSON token record under a versioned local-storage key. Treat the
record as invalid unless all required fields have the expected primitive types.
Compute `expires_at` from Spotify's `expires_in` value and refresh before expiry
with a small clock-skew margin. A successful refresh replaces the access token
and expiration while retaining the old refresh token when the response omits a
new one. An invalid or rejected refresh deletes the record and returns the UI to
the disconnected state. Logout only deletes local browser state; it does not
claim to revoke Spotify's authorization grant.

Do not add a general frontend abstraction for this single page. Keep OAuth
constants, storage validation, PKCE helpers, refresh logic, callback handling,
and the small UI state transitions in one first-party JavaScript file. Use text
content and fixed DOM nodes rather than inserting HTML from URLs, token
responses, or storage.

Set at least `Content-Security-Policy`, `Referrer-Policy: no-referrer`, and
`X-Content-Type-Options: nosniff` on browser application responses. The CSP must
deny by default, allow scripts only from the same origin, allow connections
only to the same origin and `https://accounts.spotify.com`, prohibit framing,
objects, and base-URI changes, and avoid `unsafe-inline` and `unsafe-eval`.
This header is both a security control and the enforceable form of the
no-advertising-code invariant. Do not weaken it speculatively for future ads.

Production activation remains host configuration rather than repository
content. Register the production callback in Spotify, place only the public
client ID in a root-controlled service environment file or drop-in, and retain
the existing loopback listener, Apache proxy, TLS certificate, and dynamic-user
service model. Deploy from the remote Git checkout using its established
pull-test-build-atomic-install workflow. Do not copy the ignored local `.env`
or `cookie.txt` to the host.

## Affected Components

- `main.go`: validate the client ID, embed the JavaScript asset, serve the app
  callback and configuration routes, and attach browser security headers.
- `main_test.go`: cover configuration validation, the new routes and content
  types, the public configuration response, security headers, and unchanged
  health behavior.
- `web/index.html`: replace the placeholder with fixed connection status,
  connect, and logout controls and load only the first-party external script.
- `web/app.js`: implement PKCE authorization, callback validation, browser
  token persistence and refresh, URL cleanup, logout, and UI state changes.
- `README.md`: describe implemented Spotify connection behavior, required
  client-ID configuration, browser storage, logout semantics, scopes, and the
  authenticated-origin third-party-code prohibition.
- Spotify Developer Dashboard: add the exact production callback while
  preserving the registered local callback.
- Remote service configuration and installed binary: provide the public client
  ID outside Git and deploy the tested repository commit without adding host
  files to the repository.

## Implementation Sequence

1. Change handler construction to require a non-empty Spotify client ID, expose
   it through `/api/config`, serve `/callback` and `/app.js`, and add the
   security headers without altering `/healthz`.
2. Replace the static placeholder with semantic connection controls and add the
   first-party JavaScript implementation for PKCE start, callback processing,
   token validation and refresh, logout, and fixed UI states.
3. Extend focused Go tests for startup configuration and every new HTTP
   contract, including the CSP's required sources and absence of inline script.
4. Update the README to match the implemented runtime configuration and browser
   security/storage model, retaining a clear boundary between current auth
   behavior and future playlist work.
5. Run formatting and local tests, inspect the staged diff for token or client
   credential leakage, then commit and push the implementation using explicit
   paths.
6. Add `https://shuffle.p.a-9.co/callback` to the existing Spotify app and add
   the public client ID to root-controlled remote service configuration. Do not
   add or transfer the client secret.
7. Pull the committed revision in `/root/tools/spotify_shuffle`, run its tests,
   build in a temporary directory, atomically install the binary with rollback,
   restart the existing service, and verify Apache still proxies only to
   `127.0.0.1:5107`.
8. Complete one user-authorized production sign-in from the iPhone, confirm the
   callback returns to a connected page and the URL is clean, then verify
   refresh/reload and logout behavior without reading or modifying playlists.
9. Record execution results in this plan, move it to `doc/completed_plans/`, and
   commit and push the completion record.

## Validation

- Run `gofmt` on changed Go files and `go test ./...`.
- Run `go vet ./...` because handler construction and embedded asset routing
  change together in this small package.
- Start the server with no `SPOTIFY_CLIENT_ID` and require an immediate,
  explicit configuration failure; start it with a non-secret test client ID
  and require normal service.
- Verify `/`, `/callback`, `/app.js`, `/api/config`, and `/healthz` statuses,
  content types, exact-route behavior, cache policy, and security headers.
- Inspect `web/index.html` and response headers to confirm there is no inline or
  third-party script and the CSP permits only the required Spotify accounts
  connection.
- Exercise callback error handling for denial, missing state, and mismatched
  state without exchanging a live authorization code.
- With user participation, authorize the production app once and inspect the
  browser to confirm temporary OAuth values are removed, the versioned token
  record is written only to `localStorage`, callback parameters disappear, and
  no token appears in cookies, URLs, HTML, server logs, or network requests to
  the Go origin.
- Reload the connected page, exercise an expired-token refresh if practical,
  and verify logout removes the token record and returns to the disconnected
  state. If the six-month refresh expiry cannot be reproduced, validate the
  rejected-refresh branch with an invalid disposable browser record rather than
  waiting or changing the user's real grant.
- On the host, verify the checkout revision, tests, installed-binary checksum,
  active service, stable restart count, listener restricted to
  `127.0.0.1:5107`, Apache configuration syntax, HTTPS `/`, HTTPS `/callback`,
  and `/healthz`.
- Run `git status --short --branch` locally and remotely and confirm that no
  `.env`, cookie, token, generated binary, temporary build, or rollback artifact
  entered either checkout.

## Success Criteria

- Visiting the production page on the iPhone presents a working Spotify
  connection control and completes Authorization Code with PKCE through the
  exact registered HTTPS callback.
- OAuth state mismatches and authorization errors are rejected without storing
  tokens, and callback query parameters do not remain in browser history.
- A valid token set persists across reloads in the browser, refreshes without a
  client secret, preserves rotated refresh tokens correctly, and is removed by
  logout or an invalid refresh.
- Neither the Go service nor the deployment host persist user Spotify tokens;
  the server exposes only the configured public client ID.
- The authenticated origin loads no third-party JavaScript, and response
  headers enforce the documented origin boundary needed for browser token
  storage.
- Existing health, loopback listener, Apache HTTPS proxy, certificate, and
  remote-checkout deployment behavior remain operational.
- No playlist data is read and no Spotify playlist is modified by this
  increment.
