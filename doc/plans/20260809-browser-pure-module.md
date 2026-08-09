# Plan: Browser Pure-Logic Module

## Summary

Move the browser code that transforms and validates values -- with no DOM,
network, storage, or crypto dependency -- out of `web/app.js` into a new
`web/pure.js` served as a second first-party script. Test that module directly
in Node with no fakes at all. This is a refactor with no behavior change: the
existing authentication and listing tests must keep passing to prove it. The
point is not to shrink the harness today but to stop it growing every time a
feature adds value logic.

## Problem

`web/app.js` is a single IIFE with no exports, so the only way to reach any
function inside it is `web/app_test.js`'s `vm` harness: a fake `window`,
`document`, `location`, `history`, `fetch`, two fake storages, and a
`FakeElement` class. Half of `web/app_test.js` -- lines 1 through 246 of 483 --
is that scaffolding.

The cost is now concrete:

- Proving that a paging cursor pointing off `api.spotify.com` is rejected -- a
  string prefix check -- requires booting a fake browser, seeding a fake
  `localStorage` with a token record, faking `fetch`, and running `initialize()`
  to completion.
- `FakeElement` is drifting toward a hand-written DOM. Adding the playlist list
  required teaching it `appendChild`, `setAttribute`, `getAttribute`, and that
  assigning `textContent` clears children. Each of those encodes a DOM
  behavior; each is a place the fake can disagree with a real browser and make
  a test lie in either direction.
- Value logic is asserted only as a side effect of integration tests. Label
  pluralization, null-placeholder skipping in a playlist page, and token-record
  validation have no direct coverage.

The shuffle increment adds exactly the kind of code that suffers most from
this: order generation and batch chunking are pure functions over arrays, and
under the current structure they would only be reachable through a simulated
page load.

## Scope

In scope:

- Add `web/pure.js`, a classic script defining a single `TrueShuffle` global
  containing the browser-independent value logic and error types.
- Move these existing definitions from `web/app.js` unchanged in behavior:
  `TokenRejectedError`, `AuthorizationRevokedError`, `encodeBase64URL`,
  `validTokenRecord`, `playlistLabel`, the playlist-page reader, the paging
  cursor check, and the `playlistsEndpoint` constant.
- Split `storeTokenResponse` into a pure record builder that takes the current
  time as an argument and the `localStorage` write that stays in `web/app.js`.
- Serve `/pure.js` and load it before `/app.js`.
- Add `web/pure_test.js` covering the moved logic directly, with no fakes.
- Load `web/pure.js` into the existing `vm` context in `web/app_test.js`, and
  delete the one integration test made redundant by direct coverage.
- Update the documented test command.

Out of scope:

- Any change to authentication, listing, or rendering behavior. Every
  observable behavior is identical after this change, and the unchanged
  integration tests are the evidence.
- `settle(rounds)`, the harness helper that pumps the microtask queue a fixed
  number of times. It is a real fragility and it will not survive the shuffle
  increment's sequential batch writes, but it is independently fixable and
  unrelated to where the logic lives.
- Converting the browser app to ES modules. `import` cannot appear inside the
  IIFE, so it would force removing the wrapper and reindenting the whole file,
  and `vm.runInContext` cannot execute module syntax -- the harness would need
  `vm.SourceTextModule` with a linker callback behind
  `--experimental-vm-modules`. That adds harness complexity to a change whose
  purpose is to remove it.
- jsdom, any npm dependency, a package manifest, or a bundler.
- Reducing the remaining integration tests. What survives proves wiring the
  pure tests cannot: storage writes, URL cleanup, fetch orchestration, and DOM
  state transitions.
- The shuffle logic this refactor is meant to prepare for.

## Design

**One global, one invariant.** `web/pure.js` ends with a top-level
`var TrueShuffle = {...}`, which becomes a global property in a classic script
and lands on the context object under `vm.runInNewContext` identically. The
file's governing rule is that it may not reference `document`, `window`,
`fetch`, `localStorage`, `sessionStorage`, `crypto`, `location`, or `history`.
That rule is greppable, so it is checked rather than asserted.

**Chosen over ES modules deliberately.** Two classic scripts with `defer`
execute in document order, so `TrueShuffle` is defined before `app.js` runs.
This keeps `vm.runInContext` working, which keeps the auth and listing
integration tests intact. See Out of scope for why the module route costs more
than it returns here.

**Time becomes an argument.** The token record builder takes `now` and returns
the record; `web/app.js` passes `Date.now()` and performs the `localStorage`
write. Expiry arithmetic becomes deterministic and directly testable, and the
split keeps the storage side effect with the code that owns storage.

**The page reader returns a value.** The current reader appends into a caller-
supplied array. It becomes a function returning the playlists parsed from one
page, which is what makes it testable without a scratch array. Callers
concatenate.

**Error types move with the logic that raises them.** `TokenRejectedError` and
`AuthorizationRevokedError` are pure data types, and the record builder must
raise `TokenRejectedError` to preserve today's control flow exactly.
`web/app.js` reads both from the global for its `instanceof` checks, so the
refresh-failure classification the OAuth hardening work established is
unchanged.

**No CSP change.** `script-src 'self'` already permits a second first-party
script. `connect-src` is untouched.

**Failure scope.** A refactor with no behavior change has no new runtime
failure mode, with one exception worth naming: if `/pure.js` is not served,
`app.js` throws immediately on a missing global and the page renders nothing.
The route test and a deployed page load cover that.

## Affected Components

- `web/pure.js` (new): the browser-independent value logic, error types, and
  the playlists endpoint constant, exposed as one `TrueShuffle` global.
- `web/app.js`: delete the moved definitions, read them from the global, pass
  `Date.now()` into the record builder, and keep the `localStorage` write and
  the fetch loop that concatenates page results.
- `web/pure_test.js` (new): direct tests for label pluralization and a missing
  name, page parsing including null placeholders and malformed payloads, cursor
  acceptance and rejection, token-record validation, expiry arithmetic, and
  refresh-token fallback when the response omits one.
- `web/app_test.js`: run `web/pure.js` in the vm context before `web/app.js`;
  delete the cursor-rejection integration test now covered directly.
- `web/index.html`: load `/pure.js` with `defer` before `/app.js`.
- `main.go`: embed `web/pure.js` and serve it at `GET /pure.js` with the
  JavaScript content type and the existing browser security headers.
- `main_test.go`: assert the `/pure.js` route, content type, and headers, and
  update the `TestAppPage` script markers.
- `README.md`: the Test section names one browser test file and must name both.

No change is expected in the CSP constant, the OAuth scopes, the token storage
model, or any host configuration.

## Implementation Sequence

1. Create `web/pure.js` with the moved definitions, preserving behavior exactly.
2. Update `web/app.js` to consume the global and delete the moved copies.
3. Embed and route `/pure.js` in `main.go`, add the script tag to
   `web/index.html`, and update `main_test.go` for the route and markers.
4. Add `web/pure_test.js`.
5. Load `web/pure.js` into the `web/app_test.js` context and delete the
   redundant cursor test.
6. Update the README test command.
7. Run validation and confirm the surviving integration tests pass unmodified.
8. Commit and push, then deploy through the existing release workflow. The
   pending `20260809-playlist-listing.md` deployment is not yet done and the
   two can ship in one release.

## Validation

```sh
gofmt -l main.go main_test.go
go test ./...
go vet ./...
node --check web/pure.js
node --check web/app.js
node --check web/pure_test.js
node --check web/app_test.js
node --test web/pure_test.js web/app_test.js
git diff --check
```

Confirm the purity invariant directly:

```sh
grep -nE 'document|window|fetch|localStorage|sessionStorage|crypto|location|history' web/pure.js
```

That command must produce no output.

The strongest evidence of no behavior change is that every surviving test in
`web/app_test.js` passes with its assertions unmodified. Any edit to an
existing assertion means behavior moved and must be justified, not absorbed.

Manual browser validation:

- Load the page and confirm both scripts load and the console reports no CSP
  violation and no missing-global error.
- Confirm playlist listing and selection still work, and that disconnect still
  clears the list.

Deployment validation:

- Confirm `/pure.js` returns 200 with the JavaScript content type and the
  security headers on the deployed origin.
- Confirm `trueshuffle.service` is active and `/healthz` responds.

## Success Criteria

- The moved logic is covered by tests that construct no fake DOM, storage,
  fetch, or window.
- `web/app.js` contains no remaining copy of the moved definitions.
- `grep` finds no browser global in `web/pure.js`.
- Every surviving `web/app_test.js` test passes with unmodified assertions,
  and the Go suite passes.
- `/pure.js` is served with the JavaScript content type and the existing
  security headers, and the page loads with no missing-global error.
- The README names both browser test files in a single runnable command.
- Adding value logic in the next increment requires a new case in
  `web/pure_test.js` and no change to the harness.
