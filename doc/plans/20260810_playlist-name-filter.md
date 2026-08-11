# Plan: Playlist Name Filter

## Summary

A quiet text box above the source list narrows the visible rows as the
user types: case-insensitive substring match on each source's name, the
Liked Songs row included. Filtering is purely presentational -- the rows
are built once per listing exactly as today, and the filter only toggles
each row's `hidden` attribute -- so selection marking, mid-chain disabled
state, the retained listing, and the write flow are untouched by
construction. A static "No playlists match." line appears when the query
hides every row.

## Problem

The page renders one flat list of every playlist on the account, and the
product's stated goal is large libraries. Finding one playlist among
dozens means scrolling and scanning, on a phone, every time -- the
slowest step in a flow whose whole point is one tap. The app already
filters exact current and legacy managed targets out of the source display,
but it preserves duplicate names and arbitrary suffix-named user playlists;
the user has no way to narrow the list themselves.

## Scope

In scope:

- A pure name-match predicate in `web/pure.js` (trimmed, case-insensitive
  substring; the empty query matches everything), exported on the
  `TrueShuffle` global like its display-filter neighbors.
- A static filter input and a static no-match line in `web/index.html`,
  directly above `ul#playlists`, hidden by default.
- Wiring in `web/app.js`: rows remember their source name alongside the
  existing per-row state; the input's `input` event sets each row's
  `hidden` by the predicate and shows the no-match line exactly when
  every row is hidden; the input appears when the list renders and is
  hidden and cleared with the list on disconnect.
- Theme styling for the input in `web/styles.css`.
- Harness coverage: predicate cases in `web/pure_test.js`; in
  `web/app_test.js`, typing narrows rows (Liked Songs row included),
  clearing restores all rows, the no-match line toggles both ways, and
  disconnect hides and empties the input.
- The `id="playlist-filter"` served-page marker in `main_test.go`.
- One sentence each in
  `doc/architecture/browser/APPLICATION_MODEL.md` (the fixed document
  gains the filter input; the one-gesture section gains the display-only
  name filter beside the existing render-time filters) and `README.md`.

Out of scope:

- Showing the input only above some list-length threshold; it simply
  accompanies the list. Revisit only if small accounts find it noisy.
- Fuzzy matching, diacritic folding, or match highlighting.
- Persisting the query across reloads, keyboard shortcuts, and any
  filtering of the retained listing (the write flow's marker resolution must
  keep seeing every managed target, the same rule as the managed-description
  filter).

## Design

**Hide rows; never re-render.** The one delicate part of a filter is what
it does to live state: a re-render would recreate buttons while
`selectedPlaylist` holds a button reference for `aria-pressed` bookkeeping
(`web/app.js:1343-1351`) and while an active chain has every row disabled
through module-scope `playlistButtons` (`web/app.js:894-897`). The filter
therefore never rebuilds anything. `renderSourceList` keeps building the
rows once per listing; each row's `li` and source name are retained in
module scope beside the existing button list, and the filter pass is a
loop setting `item.hidden = !matches(name, query)`. Disabled buttons stay
disabled, the pressed row stays pressed (a hidden selected row is fine --
the status line still names the selection), and the retained listing is
never touched. Filtering during an active chain is harmless by
construction, so the input never needs disabling.

**Value logic in the pure module.** The predicate (trim the query, empty
matches all, otherwise case-insensitive substring on the name) is value
logic and lands in `web/pure.js` under the purity rule, beside
`displayedPlaylists`. Its direct array result contains every unmarked source,
including duplicate names. Matching uses the source name, not the rendered
label, so the Liked Songs row matches "liked" even when its label carries
the reconnect suffix.

**Static elements, fixed text.** The input
(`id="playlist-filter"`, `type="search"`, a placeholder and matching
`aria-label` of "Filter playlists", `autocomplete="off"`) and the
no-match line ("No playlists match.") are static HTML. The no-match line
has fixed text and is toggled by the same filter pass, shown exactly when
the query hides every row -- no dynamic message formatting. Both elements
follow the list's lifecycle: shown when `renderSourceList` unhides the
list, hidden -- and the input emptied -- by `clearPlaylists` on
disconnect. The routine list status remains independent of the filter.

**Presentation.** A quiet themed input: full row width, the glass
treatment's muted border and background, the muted placeholder, the
accent only on focus. No icon, no clear button beyond what
`type="search"` provides natively, no layout change to the list itself.

## Affected Components

- `web/pure.js`: the name-match predicate, exported with the other
  display helpers.
- `web/app.js`: per-row name/element state beside `playlistButtons`, the
  filter pass on `input`, show/clear hooks in `renderSourceList` and
  `clearPlaylists`.
- `web/index.html`: the filter input and no-match line above the list.
- `web/styles.css`: the themed input and its focus state.
- `web/pure_test.js`: predicate cases (empty and whitespace queries,
  case-insensitivity, substring position, no match).
- `web/app_test.js`: narrowing, restoring, no-match toggling, and
  disconnect behavior against the harness DOM.
- `main_test.go`: the `id="playlist-filter"` marker.
- `doc/architecture/browser/APPLICATION_MODEL.md` and `README.md`: one
  sentence each as named in scope.

## Implementation Sequence

Single-step change: predicate, markup, wiring, styles, tests, marker, and
the two documentation sentences in one commit; validate, push, and deploy
per the standing directive through the private runbook.

## Validation

```sh
gofmt -l main_test.go
go test ./...
go vet ./...
node --check web/pure.js
node --check web/app.js
node --test web/pure_test.js web/app_test.js
git diff --check
! grep -nE 'document|window|fetch|localStorage|sessionStorage|crypto|location|history' web/pure.js
```

Visual confirmation: run the server locally, connect nothing, and verify
the input is absent before a listing; the connected-state filtering
behavior is proven by the harness cases above.

## Success Criteria

- With a listing on screen, typing narrows the visible rows to
  case-insensitive name matches (Liked Songs included), clearing the box
  restores every row, and a query matching nothing shows "No playlists
  match." and nothing else.
- Filtering never rebuilds rows: during an active chain rows stay
  disabled and the selected row stays marked, whatever the query does.
- The retained listing and write flow are unchanged; the purity grep
  stays clean; all Go and Node suites pass.
