# TrueShuffle

TrueShuffle is an early-stage, mobile-friendly web application for reshuffling
large Spotify playlists. It builds a genuinely randomized playlist order in
the browser and writes that order to a separate Spotify playlist; it never
reorders the source.

## Current behavior

- One list covers Liked Songs and the connected account's playlists. One click
  reads the source, shuffles its track URIs with crypto-backed Fisher-Yates,
  and writes the result in Spotify's largest supported batches.
- Each source gets a managed playlist named `<source name> TrueShuffle`.
  TrueShuffle identifies that target with an exact versioned description tied
  to the source id, not by trusting its name. It leaves unmarked same-name
  playlists alone, safely adopts one target with the old exact description,
  and refuses ambiguous matches.
- Playlist tracks are cached in IndexedDB and checked against Spotify's
  `snapshot_id`. Liked Songs uses a size-and-newest-page fingerprint because it
  has no snapshot. An unchanged playlist needs no track reads; unchanged Liked
  Songs needs one source-read request.
- Spotify requests use one cancellable serial lane with at least 250 ms between
  starts. A `429` honors valid `Retry-After` guidance with at most one bounded
  retry, and longer cooldowns survive reloads.
- The Go service embeds the browser app, exposes `GET /healthz`, supplies the
  public Spotify client id, and stores bounded first-party rate-limit telemetry
  when configured.

## Practical limits

- Play the generated copy with Spotify's shuffle turned off: its stored order
  is the shuffle.
- A cold multi-thousand-track source can take minutes because reads and writes
  are deliberately paced. Cached repeat shuffles usually take seconds.
- Spotify can rate-limit Liked Songs separately and omit browser-visible retry
  guidance. After an observed Liked Songs `429`, TrueShuffle disables only that
  source for its conservative 24-hour window; playlist shuffles still work.
- The playlist list is a page-load snapshot. Reload to see later Spotify
  changes.
- Separate tabs or devices can race while creating a first target. A later
  shuffle detects duplicate managed markers and asks the user to resolve them
  in Spotify instead of guessing which playlist to overwrite.

## Run locally

Go 1.25 or later is required. Set the public client id from the Spotify
Developer Dashboard and a path for the telemetry database:

```sh
SPOTIFY_CLIENT_ID=your-client-id \
TELEMETRY_DB_PATH=/tmp/trueshuffle-telemetry.sqlite go run .
```

The server listens on `127.0.0.1:8080` by default. Set `LISTEN_ADDR` to use a
different address:

```sh
SPOTIFY_CLIENT_ID=your-client-id \
TELEMETRY_DB_PATH=/tmp/trueshuffle-telemetry.sqlite \
LISTEN_ADDR=127.0.0.1:9090 go run .
```

Open <http://127.0.0.1:8080/> and check the server with:

```sh
curl http://127.0.0.1:8080/healthz
```

Register the exact callback for every origin used to run the app. The default
local callback is:

```text
http://127.0.0.1:8080/callback
```

The deployed callback is:

```text
https://shuffle.p.a-9.co/callback
```

## Authorization and privacy

Authorization Code with PKCE runs in the browser. Spotify access and refresh
tokens stay in `localStorage`; temporary OAuth state and the verifier stay in
`sessionStorage`. The Go service receives none of them. The stored token key
retains the former `spotify_shuffle` namespace so previously authorized
browsers remain compatible.

The app requests:

- `playlist-read-private` to list private playlists and read their tracks;
- `user-library-read` to read Liked Songs;
- `playlist-modify-private` to create and update private managed targets; and
- `playlist-modify-public` to keep an explicitly managed target writable if
  the user later makes it public.

"Disconnect this browser" removes the local token record and cached track
lists. It does not revoke the grant in Spotify; use Spotify's app settings for
account-level revocation.

`TELEMETRY_DB_PATH` names a SQLite file created with mode 0600. Reports contain
bounded request timing, roles, statuses, and counts, but no token, account,
playlist, or track identity. The service exposes no HTTP read endpoint for the
database. The browser retains at most four equally sanitized pending reports
until the service acknowledges them.

## Browser security

The application loads only repository-owned JavaScript, CSS, and images.
Response headers enforce a restrictive Content Security Policy: no third-party
or inline scripts or styles, no `eval`, and browser connections limited to the
application origin plus Spotify's authorization and API origins. Advertising,
analytics, and other third-party code do not belong on the authenticated
origin.

## Documentation

[`doc/README.md`](doc/README.md) maps the project documentation. The
[architecture pages](doc/architecture/README.md) describe the current system;
plans and completed plans describe future and historical work separately.

## Test

Run the Go checks with Go 1.25 or later:

```sh
go test ./...
go vet ./...
```

Run the browser tests with Node.js 18 or later. They use only built-in Node
modules and require no package installation:

```sh
node --test web/pure_test.js web/app_test.js
```
