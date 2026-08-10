# Security model

*Revised: 2026-08-09*

This page owns the rules that confine Spotify data to intended origins: the
Content Security Policy the service sets and the coding rules the browser
app obeys. Return to the [architecture index](../README.md).

The threat model is concrete: the browser holds long-lived Spotify tokens,
so the authenticated origin must run only repository-owned JavaScript and
send Spotify data only to Spotify.

## Response headers

The page and both scripts are served with:

- `Content-Security-Policy` (below);
- `Referrer-Policy: no-referrer`, so the app URL never leaks to Spotify or
  anywhere else;
- `X-Content-Type-Options: nosniff`.

## The CSP, directive by directive

```text
default-src 'none'            nothing loads unless allowed below
script-src 'self'             only first-party scripts; no inline, no eval
style-src 'self'              only the first-party stylesheet; no inline style
img-src 'self'                only the first-party background image; no data:
connect-src 'self'            /api/config
  https://accounts.spotify.com    token exchange and refresh (the authorize
                                  step is a navigation, not a fetch)
  https://api.spotify.com         Web API reads
base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
```

`default-src 'none'` means the allowlist is exhaustive: `style-src 'self'`
permits the one first-party stylesheet and no inline style, `img-src 'self'`
permits the one first-party background image and no `data:` or third-party
image, and there is still no permitted font or frame source. Adding any such
asset requires its own directive, deliberately. Third-party scripts and styles --
analytics, advertising, anything -- must never load on this origin; a page
that wants them needs a separate origin without Spotify data.

## Rules the app code obeys

- **Bearer tokens stay on the API origin.** The playlist paging cursor
  comes from a Spotify response body, so it is not trusted: `app.js` follows
  it only when the pure cursor check proves it targets the playlists
  endpoint. The CSP `connect-src` is the backstop; the guard fails first and
  cleanly.
- **Third-party text never becomes markup.** Playlist names are
  attacker-influenced strings. List entries are built with `createElement`
  and `textContent`; `innerHTML` is never assigned.
- **No inline script or style, ever.** The page wires all behavior from the
  two served scripts and all presentation from the one served stylesheet,
  keeping `script-src 'self'` and `style-src 'self'` honest; a test asserts
  the served page carries no inline `style=` attribute or `<style>` block.
- **Telemetry is sanitized at the source.** The rate-limit reports the page
  posts to `/api/telemetry` carry bounded enums and numbers only -- request
  roles, timing, statuses, counts -- never tokens, account or playlist
  identity, track URIs, raw URLs, or response text. Raw values exist only
  inside the browser normalizer; the server validates every field strictly,
  rejects cross-origin provenance when browser headers reveal it, and
  exposes no read route. Pending reports await acknowledgement in a small
  IndexedDB queue that is sanitized before it is stored, which is why it
  may survive disconnect. Leak absence is asserted by test.

The [testing model](../testing/TESTING_MODEL.md) requires that removing a
security guard makes a test fail; the cursor guard is the standing example.
