# Spotify Shuffle

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
- Keep Spotify authentication tokens out of browser storage when a backend is
  used.

## Status

The project currently provides a minimal Go HTTP server with a `GET /healthz`
endpoint. Spotify integration and the browser interface remain planned work.

## Run

Go 1.22 or later is required.

```sh
go run .
```

The server listens on `127.0.0.1:8080` by default. Set `LISTEN_ADDR` to use a
different address:

```sh
LISTEN_ADDR=127.0.0.1:9090 go run .
```

Check the running server with:

```sh
curl http://127.0.0.1:8080/healthz
```

## Test

```sh
go test ./...
```
