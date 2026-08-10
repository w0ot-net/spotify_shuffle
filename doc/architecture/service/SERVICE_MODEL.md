# Service model

*Revised: 2026-08-10*

This page owns the Go service: its routes, embedded assets, and the invariant
that it never receives a Spotify token and stores nothing but sanitized
telemetry. Return to the [architecture index](../README.md).

The service is one static binary. `main.go` embeds `web/index.html`,
`web/pure.js`, `web/app.js`, `web/styles.css`, and the five JPEG
backgrounds at build time. It keeps no sessions and sets
no cookies. Every Spotify credential lives in the browser; the service's
only secret-adjacent value is the public Spotify client ID, which is
configuration, not a secret. Its one write surface is the telemetry store:
`telemetry.go` keeps bounded, sanitized rate-limit reports in the SQLite
file named by `TELEMETRY_DB_PATH` (single connection, schema versioned,
mode 0600, retention and a 256 MiB size cap applied on every insert), with
no HTTP read route over it. A telemetry storage failure logs and answers
`503` on the intake route only; every other route stays healthy.

## Routes

| Route             | Response                                              |
| ----------------- | ----------------------------------------------------- |
| `GET /{$}`        | the embedded page, `text/html`, security headers      |
| `GET /callback`   | the same embedded page, for the OAuth redirect        |
| `GET /pure.js`    | embedded script, `text/javascript`, security headers  |
| `GET /app.js`     | embedded script, `text/javascript`, security headers  |
| `GET /styles.css` | embedded stylesheet, `text/css`, security headers     |
| `GET /background-{weave,veil,orbit,tide,prism}.jpg` | embedded JPEG, security headers |
| `GET /api/config` | `{"spotify_client_id": ...}`, `no-store`, headers     |
| `POST /api/telemetry` | `204` after a committed (or duplicate) report     |
| `GET /healthz`    | `ok`, `text/plain`, no browser security headers       |

The embedded assets share one `serveAsset` helper that writes the given
content type and the security headers. Routes are exact: Go 1.22 pattern
matching rejects `/pure.js/`, `/app.js/`, `/styles.css/`,
each background JPEG with a trailing slash, and any unregistered path. `/{$}`
matches only the root. The page, scripts, stylesheet, and images carry the
browser security headers owned by the
[security model](../security/SECURITY_MODEL.md).

## Startup and configuration

- `SPOTIFY_CLIENT_ID` is required; the process fails at startup without it
  rather than serving a broken page.
- `TELEMETRY_DB_PATH` is required and must name a file in an existing
  writable directory; startup creates a missing database but fails on a
  missing path, an unknown schema version, or an insecure file mode --
  deliberate fail-fast, so a misdeployed service is loud at activation
  rather than silently telemetry-less.
- `LISTEN_ADDR` overrides the default `127.0.0.1:8080`. The service speaks
  plain HTTP only; TLS and the public hostname belong to the reverse proxy
  described in the [deployment model](../deployment/DEPLOYMENT_MODEL.md).
