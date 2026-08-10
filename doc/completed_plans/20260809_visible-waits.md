# Plan: Visible Waits and Cancellable Chains

*Distilled: 2026-08-09*

## Summary

A rate-limited page must never sit gray and silent. When the request lane
waits beyond its routine pacing gap, the page shows a live countdown
naming the reason; every active shuffle chain gains a Cancel button wired
to the abort controller that already exists; and a final 429 always
surfaces the pause message with the absolute retry time instead of the
generic failure text. No behavior toward Spotify changes -- this makes
state the lane already tracks visible and escapable.

## Problem

A live 429 produced exactly the bad experience the request-control plan
accepted implicitly: `requestSpotify` stores the cooldown and waits up to
60 seconds before its single retry, and during that wait every row is
disabled while the status line still reads "Loading Liked Songs..." --
gray, silent, and wrong. The only escape is disconnecting entirely.

Three specific gaps, all in `web/app.js`:

- `abortableDelay` knows the exact wait but renders nothing; the page has
  no waiting state at all between "loading" and the eventual outcome.
- The per-operation `AbortController` built for disconnect has no user
  affordance, so a user cannot abandon a paced chain without abandoning
  their session.
- A user-initiated abort would today render "Tracks could not be loaded.
  Select the playlist again to retry." -- a failure message for a
  deliberate act -- and a second 429 (retry exhausted, wait under 60
  seconds) renders the generic could-not-load text even though the stored
  deadline is known to the millisecond.

## Scope

In scope:

- A `wait-status` line rendered by the lane whenever a scheduled wait
  reaches 2 seconds: "Spotify asked us to slow down -- retrying in Ns.",
  ticking once per second and disappearing the moment the wait ends,
  however it ends. Routine 1-second pacing gaps stay silent.
- Like the progress bar, the countdown is visual-only (no live region):
  per-second ticks must not be announced, and the outcome still arrives
  through the existing status lines. This mirrors the page's recorded
  accessibility posture for per-step numbers.
- A `cancel` button visible exactly while a shuffle chain runs, aborting
  the operation's controller. A cancelled load renders "Cancelled."; a
  cancel that interrupts writing names the possibly partial target with
  the existing rewrite offer. Rows re-enable immediately through the
  existing gate teardown.
- A pure `OperationCancelledError`; the lane and delay throw it on abort,
  and catch sites classify it (and a real fetch `AbortError`) as
  cancellation, not failure. Disconnect keeps its current silent path;
  telemetry keeps reporting the existing `abandoned` phase for both.
- A final 429 -- the retry also limited, or no retry allowed -- throws
  the existing `CooldownActiveError` unconditionally, so all surfaces
  render "Spotify asked for a pause. Try again after HH:MM:SS." (This
  deletes the current wait-length condition rather than adding one.)
- Page-marker, harness, architecture, and README migration.

Out of scope:

- Cancelling the initial playlist listing. It runs before any row exists;
  its 429 waits get the countdown, and reload remains its escape.
- Any change to pacing, retry policy, cooldown persistence, telemetry
  schema or enums, or Spotify request behavior.
- Auto-resuming after long cooldowns, toasts, spinners, or styling; the
  page remains unstyled fixed text by the standing CSP decision.
- The stray `trueshuffle` binary in the worktree root (untracked build
  output; not part of this change).

## Design

**The lane renders its own waiting.** A `pacedWait(waitMs, signal)`
wrapper in `web/app.js` replaces the bare `abortableDelay` call in
`requestSpotify`: below the 2-second notice threshold it delegates
unchanged; at or above it, it loops one-second slices, rendering the pure
`waitCountdownMessage(remainingMs)` into `wait-status` before each slice
and hiding the element in a `finally`. The countdown therefore works for
retry waits, short-cooldown waits before new requests, and nothing else --
and is deterministic under the harness's manual clock, since it uses the
same `setTimeout` and `Date` the clock already controls.

**Cancel is the controller made visible.** `runShuffle` already brackets
every chain with the button gate; it now also shows the `cancel` button
(and hides it in the same `finally`). The click handler aborts
`activeOperation.controller` -- the identical mechanism disconnect uses --
so no second cancellation pathway exists. The distinction between the two
is who observes it: disconnect clears the selection so the existing
inactive-selection guards stay silent; user cancel leaves the selection,
and the catch sites render "Cancelled." through the new classification.

**Cancellation is a class, not a string.** `abortableDelay` and the lane's
post-wait abort check throw the pure `OperationCancelledError` instead of
a plain `Error`; a `wasCancelled(error)` helper in `web/app.js` also
accepts a platform `AbortError` from an aborted fetch. Loader catches, the
listing catch, and `writeShuffled`'s catch branch on it before the
existing failure rendering. The telemetry terminal phase stays
`abandoned` -- honest, and it keeps the server enum untouched.

**A final 429 is always a pause, never a shrug.** `requestSpotify`'s 429
handling currently throws `CooldownActiveError` only when the deadline
exceeds the retry ceiling; when the retry itself gets limited the caller
sees the generic failure. The condition is removed: any 429 that will not
be retried throws `cooldownError(deadline)`. Every surface already renders
that message with the absolute time, so this is a deletion, not new
mechanism.

**Failure scope.** Nothing changes for Spotify: request order, pacing,
retries, and telemetry events are byte-identical. A cancelled chain
leaves the listing, cache, token, and selection exactly as a failed one
does; a mid-write cancel can strand the same partial derived target a
mid-write failure already can, and says so with the same rewrite offer.

## Affected Components

- `web/pure.js`: `OperationCancelledError`; `waitCountdownMessage`.
- `web/app.js`: `pacedWait` and the `wait-status` renderer; the `cancel`
  button wiring inside `runShuffle`'s existing gate; `wasCancelled` and
  the cancellation branches in the loader, listing, and write catches;
  the unconditional final-429 `CooldownActiveError`.
- `web/index.html`: add `<p id="wait-status" hidden>` beside the progress
  element and `<button id="cancel" type="button" hidden>Cancel</button>`.
- `main_test.go`: the two new page markers.
- `web/pure_test.js`: countdown message formats; the error class.
- `web/app_test.js`: with the manual clock -- the countdown appears
  during a 429 retry wait, ticks down, and disappears on resume; it never
  appears for routine pacing gaps; cancel during a wait renders
  "Cancelled.", re-enables rows, and dispatches nothing further; cancel
  mid-write names the partial target; a limited retry renders the pause
  message with its time. The existing second-429 case's expected message
  changes to the pause text -- the one authorized assertion change.
- `doc/architecture/browser/APPLICATION_MODEL.md`: the waiting state and
  cancel affordance join the state vocabulary and the one-gesture text.
- `doc/architecture/integration/SPOTIFY_INTEGRATION.md`: one clause -- a
  final 429 always surfaces the absolute retry time.
- `README.md`: one sentence in the request-policy paragraph -- waits are
  visible and cancellable.

## Implementation Sequence

1. Add the pure message and error class with direct tests.
2. Add the page elements and Go markers.
3. Implement `pacedWait`, the cancel wiring, the cancellation
   classification, and the unconditional final-429 pause.
4. Add the harness cases and update the one authorized assertion.
5. Update the two architecture pages and the README.
6. Validate, commit, push, and deploy per the standing directive through
   the private runbook.

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

The deterministic-clock cases must prove the countdown's full lifecycle,
its absence during routine pacing, both cancel paths, and the pause
message on a limited retry. Live validation -- triggering a real wait and
watching the countdown and Cancel behave -- follows the next natural 429
on the deployed site rather than any deliberate provocation.

## Success Criteria

- During any rate-limit wait the page names the reason and counts down;
  the gray-and-silent state no longer exists.
- Cancel is available for every active chain, ends it within one paced
  slice, renders "Cancelled." (or the partial-target message mid-write),
  and leaves the page immediately usable.
- A final 429 always tells the user when to come back, with the absolute
  time, on every surface.
- Screen readers hear outcomes, not ticks.
- Spotify-facing behavior and telemetry are unchanged; the purity grep
  stays clean; every prior test passes with the single authorized
  assertion change.

## Execution Notes

Executed 2026-08-09. Implementation commit `753ccbb`.

Implemented as planned: `OperationCancelledError` and
`waitCountdownMessage` in `web/pure.js`; `pacedWait` wrapping the lane's
single wait site with the 2-second notice threshold, one-second slices,
and teardown in `finally`; the visual-only `wait-status` line and the
`cancel` button in `web/index.html` with their Go page markers; cancel
wired inside `runShuffle`'s existing gate to the operation's controller
(the same one disconnect aborts), with `wasCancelled` classifying the
pure class and platform `AbortError`s at every catch -- loaders and the
write render "Cancelled." (naming the possibly partial target mid-write),
the row-less listing stays silent, and telemetry reports `abandoned`; the
final-429 condition was deleted so every unretried 429 surfaces
"Spotify asked for a pause. Try again after HH:MM:SS." on all surfaces.

Deviations: none. Two test-construction notes: the harness's fake fetch
abort now throws an `AbortError`-shaped error so both cancellation paths
classify, and the no-further-dispatch assertion counts Spotify requests
only, since the cancelled operation still delivers its own telemetry
report -- by design.

Validation, all passing: `gofmt -l` clean, `go test ./...`,
`go vet ./...`, `node --check`, `node --test` (119 pass, 0 fail: two new
pure cases and four new wiring cases -- countdown lifecycle under the
manual clock, countdown absence during routine pacing, cancel during a
rate-limit wait ending the chain with nothing further dispatched, and
cancel mid-write naming the partial target), `git diff --check`, and the
purity grep. The second-429 message expectation was the single authorized
assertion change.

Deployment, completed 2026-08-09 under the standing deployment direction
through the private runbook: release
`266af0fd4f4a66ed6017b6a1b854e864d134842a` (binary SHA-256
`c6fb89e2f6bc1cf6f160...`, embedded revision matching,
`vcs.modified=false`); host Go and browser suites passed; previous release
`93469fe...` retained; after the atomic switch the service is active as
`trueshuffle` with zero restarts, loopback and public health 200, both new
page elements present in the served public page, and zero warning journal
entries.
