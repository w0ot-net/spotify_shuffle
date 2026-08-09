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

Initial project setup. Implementation and deployment instructions are still to
come.
