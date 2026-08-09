# Plan: Track Read Progress and Timing

## Summary

During a real track read, the page shows a determinate native `<progress>`
element -- maximum set from the server-reported total once page 0 lands,
value advancing as each page completes -- and the final loaded message
reports the elapsed time: "Loaded 4212 tracks in 3.8s." Cache hits stay
instant, keep the plain count, and never show the bar. No fake progress:
both the denominator and every tick are server facts the read protocol
already produces.

## Problem

A large playlist read takes seconds -- roughly 100 requests for a
10,000-track playlist even at 6 concurrent -- and the only feedback is a
static "Loading tracks..." line. Nothing confirms the pull is advancing or
reports how long it took, and the read is the most time-consuming
recurring step the product has.

The duration is also exactly the observation this project deferred
rate-limit design on: any future governor is to be designed from recorded
real-world read behavior. A visible elapsed time turns every real read
into that evidence without any new tooling.

## Scope

In scope:

- Thread a progress callback from the read protocol: invoked with the
  summed raw item count and the reported total after page 0 and after each
  pool page completes, all inside `web/app.js`.
- A `<progress id="track-progress" hidden>` element shown once page 0
  reveals a non-zero total, updated per tick, and hidden when the load
  settles -- success or failure.
- Record the read's start time and render the elapsed seconds (one
  decimal) in the loaded message on the read path only.
- Consolidate the loaded-message composition -- count pluralization, the
  duration suffix, and the existing added/removed suffix -- into one pure
  function with direct tests, replacing the `trackCountMessage` helper and
  inline suffix in `web/app.js`.
- Harness cases for the new behavior; the new page marker in the Go page
  test; application-model and README updates.

Out of scope:

- The rate-limit probe and any governor. The timing message produces the
  evidence; the probe itself deliberately has no plan document.
- Styling. The CSP permits no stylesheet source; the native `<progress>`
  element renders without one, which is why it is the chosen control.
- Distinguishing cache hits in the message text (for example a "cached"
  label). The absence of a duration already distinguishes them.
- Progress for the playlist listing, request cancellation, and any
  persistence or telemetry of timings.

## Design

**Every tick is a server fact.** The read protocol already learns the
authoritative total and the enforced page size from page 0, and the pool
already parses each page's raw item count. Progress is therefore
determinate from the moment it appears: `max` is the reported total,
`value` is the summed raw counts of completed pages (raw, not URI counts,
matching the completeness check's semantics). There is no estimated or
animated-only phase; before page 0 lands the existing "Loading tracks..."
text is the only indicator.

**The bar carries the numbers; the text stays quiet.** The track status
line is `aria-live`, so rewriting its text on every page completion would
be chatty for screen readers. The `<progress>` element updates silently
and announces sensibly in assistive tech; the status text changes only on
state transitions, exactly as today.

**The clock lives in the adapter, formatting in the pure module.**
`web/app.js` records `Date.now()` when the read path starts and computes
the elapsed milliseconds when it settles; the pure module only formats. A
new pure `loadedTracksMessage(count, elapsedMilliseconds, changes)`
returns the full message: plain count for a null elapsed (the cache path),
"in X.Ys" with one decimal otherwise, and the "N added, M removed since
last read." suffix when changes are present and non-zero. This moves the
existing `trackCountMessage` helper and inline suffix composition out of
`web/app.js`; the message gains rounding logic that must be direct-tested,
and value logic lands in `web/pure.js` per the testing model.

**Failure scope.** The progress element is hidden whenever the load
settles, in the same `finally` that re-enables the playlist buttons. A
failed or torn read changes nothing else about the existing failure
behavior; a cache hit never shows the bar because the callback only fires
from the network read.

## Affected Components

- `web/pure.js`: `loadedTracksMessage` (count, optional elapsed
  milliseconds, optional change counts).
- `web/app.js`: the `track-progress` element handling, the read start
  time, the progress callback threaded through `loadTracks` into
  `readPlaylistTracks` and the pool, and replacing `trackCountMessage`
  plus the inline suffix with the pure message.
- `web/index.html`: the `<progress id="track-progress" hidden>` element
  beside the track status line.
- `web/pure_test.js`: direct message cases -- pluralization, zero and
  multi-second rounding to one decimal, null elapsed, zero/zero changes
  suppressed, combined duration-plus-changes form.
- `web/app_test.js`: extend the deferred-response pool case to assert the
  bar appears with `max` equal to the total and `value` advancing as pages
  resolve; hidden after success and after failure; never shown and no
  duration on a cache hit. Existing read-path assertions on the exact
  loaded message gain the duration form (asserted by pattern, since real
  elapsed time is nondeterministic); cache-hit assertions keep the plain
  form. This assertion change is the planned behavior change, not
  absorption.
- `main_test.go`: add the `track-progress` marker to the page test.
- `doc/architecture/browser/APPLICATION_MODEL.md`: track states gain the
  determinate progress element and the timed loaded message, with the
  aria-quiet rationale.
- `README.md`: one status clause -- reads show live progress and report
  elapsed time.

## Implementation Sequence

1. Add `loadedTracksMessage` with its direct tests.
2. Add the `track-progress` element and the Go page marker.
3. Wire the callback, timing, and element handling in `web/app.js`.
4. Extend the harness cases.
5. Update the application-model page and the README.
6. Validate, commit, push.

## Validation

```sh
gofmt -l main.go main_test.go
go test ./...
go vet ./...
node --check web/pure.js
node --check web/app.js
node --test web/pure_test.js web/app_test.js
git diff --check
! grep -nE 'document|window|fetch|localStorage|sessionStorage|crypto|location|history' web/pure.js
```

The harness must prove the bar's lifecycle against the deferred-response
pool: visible with server-truth `max` after page 0, advancing per resolved
page, hidden on settle in both outcomes, absent on cache hits. Live
confirmation on a real large playlist -- watching the bar and recording
the reported duration -- only with explicit user direction, per
`AGENTS.md`; that recorded duration is rate-limit evidence.

## Success Criteria

- During a multi-page read the progress element is visible with `max`
  equal to the reported total and `value` advancing as pages complete,
  proven by the deferred-response harness case.
- A read-path load renders "Loaded N tracks in X.Ys." (one decimal), with
  the added/removed suffix appended after a cache mismatch exactly as
  before; a cache hit renders the plain count with no duration and never
  shows the bar.
- The progress element is hidden once the load settles, on success and on
  failure alike.
- Message logic is pure with direct tests, the purity grep stays clean,
  and all prior tests pass unmodified except the read-path message
  assertions the scope names.
- The application-model page and the README describe the behavior.
