# Spotify integration

*Revised: 2026-08-09*

This page owns the contract with Spotify: the endpoints in use, the paging
bounds, and the scopes position. Return to the
[architecture index](../README.md).

All Spotify traffic originates in the browser. Three endpoints are in use:

- `https://accounts.spotify.com/authorize` -- top-level navigation opening
  the consent flow.
- `https://accounts.spotify.com/api/token` -- form-encoded POST for the code
  exchange and refresh grants.
- `https://api.spotify.com/v1/me/playlists` -- authenticated GET listing the
  connected account's playlists.

## Paging

Listing requests `limit=50`, the endpoint maximum, and follows the response
`next` cursor after the pure cursor check accepts it (see the
[security model](../security/SECURITY_MODEL.md)). The loop is bounded at 200
pages -- the API's 10,000-playlist library cap divided by the page size --
and exceeding the bound is an error, never a silent truncation, because a
silently short list would later shuffle the wrong playlist. Full playlist
objects are returned; the page reader consumes `id`, `name`, and
`tracks.total`, skipping the null placeholders Spotify emits for items it
cannot expose.

## Failure posture

Integration failures fail fast. A non-OK playlist response -- including
`401`, `429`, and `5xx` -- surfaces as a listing failure with a
reload-to-retry message; there is no retry, backoff, or `Retry-After`
scheduling, and no failure is interpreted as revocation (see the
[authorization model](../browser/AUTHORIZATION_MODEL.md)). This posture is a
deliberate current stance, recorded when OAuth hardening deferred retry
scheduling.

## Scopes

`playlist-read-private` is exercised by listing. `playlist-modify-public`
and `playlist-modify-private` are granted at consent but unexercised --
held so the upcoming write increment needs no re-consent (planned).
