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
Spotify Authorization Code with PKCE, and a `GET /healthz` endpoint. After
connecting Spotify, the page shows one list -- Liked Songs first, then the
account's playlists -- and one click on any row shuffles it: the row's
ordered track URIs are read (concurrently across pages, with a live progress
bar and guards that fail the read if the source changes mid-flight), shuffled
with unbiased crypto randomness, and written to that source's one stable
derived playlist, `<source name> TrueShuffle` -- created private on first
use and rewritten in place on every rerun, so repeat shuffles never
accumulate playlists. Playlist track lists are cached in IndexedDB and
validated with Spotify snapshots, so re-shuffling an unchanged playlist
issues no track reads and a changed one reports how many tracks were added
and removed. Liked Songs is read through the library API each time (it is
not a playlist, has no snapshot, and cannot be reordered in place;
connections made before this feature show a one-time reconnect on its row to
grant the library scope). The app hides its own derived playlists from the
list and shows each playlist name once (a note counts any hidden duplicates,
which become shuffleable when renamed in Spotify), and the only playlists it
ever writes are the ones it derives with the " TrueShuffle" suffix; source
playlists are never modified.

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

The app requests `playlist-read-private`, `playlist-modify-public`,
`playlist-modify-private`, and `user-library-read`. The read scopes are
exercised to list playlists, read the selected playlist's tracks, and read
Liked Songs; `playlist-modify-private` creates the private shuffled
playlists. `playlist-modify-public` is stored for the upcoming in-place
shuffle work.

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

"Disconnect this browser" deletes the local token record and the cached track
lists. It does not revoke the authorization grant in Spotify; reconnecting or
revoking the app through Spotify remains a separate action.

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
