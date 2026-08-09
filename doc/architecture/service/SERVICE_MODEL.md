# Service model

*Revised: 2026-08-09*

This page owns the Go service: its routes, embedded assets, and the invariant
that it stores nothing and never receives a Spotify token. Return to the
[architecture index](../README.md).

The service is one static binary. `main.go` embeds `web/index.html`,
`web/pure.js`, and `web/app.js` at build time and reads nothing from the
filesystem at runtime. It keeps no sessions, sets no cookies, and writes no
data anywhere. Every Spotify credential lives in the browser; the service's
only secret-adjacent value is the public Spotify client ID, which is
configuration, not a secret.

## Routes

| Route             | Response                                              |
| ----------------- | ----------------------------------------------------- |
| `GET /{$}`        | the embedded page, `text/html`, security headers      |
| `GET /callback`   | the same embedded page, for the OAuth redirect        |
| `GET /pure.js`    | embedded script, `text/javascript`, security headers  |
| `GET /app.js`     | embedded script, `text/javascript`, security headers  |
| `GET /api/config` | `{"spotify_client_id": ...}`, `no-store`, headers     |
| `GET /healthz`    | `ok`, `text/plain`, no browser security headers       |

Routes are exact: Go 1.22 pattern matching rejects `/pure.js/`, `/app.js/`,
and any unregistered path. `/{$}` matches only the root. The page and both
scripts carry the browser security headers owned by the
[security model](../security/SECURITY_MODEL.md).

## Startup and configuration

- `SPOTIFY_CLIENT_ID` is required; the process fails at startup without it
  rather than serving a broken page.
- `LISTEN_ADDR` overrides the default `127.0.0.1:8080`. The service speaks
  plain HTTP only; TLS and the public hostname belong to the reverse proxy
  described in the [deployment model](../deployment/DEPLOYMENT_MODEL.md).
