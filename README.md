# TrueShuffle

A planned mobile-friendly web utility for quickly reshuffling large Spotify
playlists.

The intended approach is to cache playlist item URIs in the browser, generate a
new order locally, and update Spotify in the largest supported batches. This
avoids downloading full track metadata or moving thousands of tracks one at a
time on every shuffle.

## Goals

- Trigger a shuffle from an iPhone or any modern browser.
- Handle playlists containing thousands of tracks efficiently.
- Cache playlist membership with IndexedDB and validate it with Spotify
  snapshots.
- Respect Spotify API rate limits and retry guidance.
- Keep long-lived Spotify authorization under the user's browser control.

## Status

The project currently provides a Go HTTP server with an embedded browser app,
Spotify Authorization Code with PKCE, and a `GET /healthz` endpoint. The page
can connect and disconnect Spotify in one browser, and lists the connected
account's playlists so one can be selected. Selecting a playlist reads its
ordered track URIs -- concurrently across pages, guarded by a snapshot check
that fails the read if the playlist changes mid-flight -- and shows the track
count. It does not yet cache track lists or modify any playlist.

The browser stores Spotify access and refresh tokens in `localStorage` under a
versioned application key. The key retains the project's former
`spotify_shuffle` namespace so browsers authorized before the TrueShuffle
rename stay connected. Temporary OAuth state and the PKCE verifier use
`sessionStorage`. The Go service receives neither token and exposes only the
public Spotify client ID.

## Run

Go 1.22 or later is required. Set the public client ID from the Spotify
Developer Dashboard when starting the server:

```sh
SPOTIFY_CLIENT_ID=your-client-id go run .
```

Open <http://127.0.0.1:8080/> in a browser to view the home page.

The server listens on `127.0.0.1:8080` by default. Set `LISTEN_ADDR` to use a
different address:

```sh
SPOTIFY_CLIENT_ID=your-client-id LISTEN_ADDR=127.0.0.1:9090 go run .
```

Register the exact callback for each origin used to run the app. The default
local callback is:

```text
http://127.0.0.1:8080/callback
```

The deployed callback is:

```text
https://shuffle.p.a-9.co/callback
```

The app requests `playlist-read-private`, `playlist-modify-public`, and
`playlist-modify-private`. Only `playlist-read-private` is exercised today, to
list the account's playlists and read the selected playlist's tracks. The
modify grants are stored for the upcoming playlist management work.

Check the running server with:

```sh
curl http://127.0.0.1:8080/healthz
```

## Browser security

The authenticated application origin must load only repository-owned
JavaScript. Response headers enforce a restrictive Content Security Policy and
do not permit third-party scripts, inline scripts, or `eval`. The policy allows
browser connections only to this origin, `https://accounts.spotify.com` for
tokens, and `https://api.spotify.com` for Web API reads. Advertising,
analytics, or other third-party JavaScript must use a separate origin and must
not receive Spotify data.

"Disconnect this browser" deletes the local token record. It does not revoke
the authorization grant in Spotify; reconnecting or revoking the app through
Spotify remains a separate action.

## Documentation

[`doc/README.md`](doc/README.md) maps all project documentation. The
[architecture pages](doc/architecture/README.md) describe the current system
design.

## Test

Run the Go tests with Go 1.22 or later:

```sh
go test ./...
```

Run the browser authentication and playlist tests with Node.js 18 or later.
They use only Node's built-in test modules and require no package installation:

```sh
node --test web/pure_test.js web/app_test.js
```
