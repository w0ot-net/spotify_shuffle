# Authorization model

*Revised: 2026-08-09*

This page owns Spotify authorization: the PKCE flow, the storage model, the
refresh invariant, and how authorization outcomes map onto the page states.
Return to the [architecture index](../README.md).

Authorization Code with PKCE runs entirely in the browser. The Go service
supplies only the public client ID through `/api/config`; it never sees an
authorization code, verifier, or token. The app requests the scopes
`playlist-read-private`, `playlist-modify-public`,
`playlist-modify-private`, and `user-library-read`.
`playlist-modify-private` is exercised by the shuffled-playlist creation;
`playlist-modify-public` is granted but unexercised, held for the
in-place playlist shuffle (planned).

A stored token's `scope` value gates capabilities added after it was
granted: a token without `user-library-read` keeps working for playlists
while the Liked Songs section offers a reconnect, which is the ordinary
authorization flow with the current scope list. There is no separate
reconsent path.

## Flow

Connecting generates a random `state` (32 bytes) and PKCE verifier (64
bytes), stores both in `sessionStorage`, and redirects to the Spotify
authorize endpoint with an S256 challenge. The callback returns to
`/callback`, which serves the same page; `initialize()` immediately replaces
the URL with `/` so codes never survive in history, verifies `state`,
exchanges the code plus verifier for tokens, and clears the pending
`sessionStorage` entries.

## Storage

The token record lives in `localStorage` under `spotify_shuffle.oauth.v1` --
the legacy namespace is retained so browsers authorized before the
TrueShuffle rename stay connected. A record holds `access_token`,
`refresh_token`, `token_type`, `scope`, and an absolute `expires_at`
computed by the pure record builder from a caller-supplied clock. A stored
record that fails validation is deleted on read, which is equivalent to
being disconnected.

## Refresh invariant

Tokens are refreshed only during `initialize()`: a stored record expired or
within the 60-second skew of expiry is refreshed before the page renders as
connected, so every request issued in that page load holds a known-fresh
token. There is no on-demand refresh path and no refresh timer. A refresh
response may omit `refresh_token`, `scope`, or `token_type`; the previous
record's values are preserved.

## Failure classification

Failure handling is per path, and the distinctions are load-bearing:

- **Callback failure clears authorization.** Any failure completing the
  callback -- state mismatch, denied grant, missing code or verifier, or a
  rejected token exchange -- clears the stored record and pending entries,
  and the page offers reconnection.
- **Refresh failure clears authorization only on proof of revocation.** A
  parsed `invalid_grant` error raises `AuthorizationRevokedError` and clears
  the record; any other refresh failure (network, non-JSON, other errors)
  keeps the record and asks for a reload.
- **A listing failure never clears authorization.** A failed playlist fetch
  is not evidence of revocation; the page stays connected and scopes the
  failure to the playlist section.

Disconnecting deletes the local record, pending entries, playlist and track
page state, and the track cache database (see the
[data model](DATA_MODEL.md)). It does not revoke the grant at Spotify;
revocation remains an action in the user's Spotify account.
