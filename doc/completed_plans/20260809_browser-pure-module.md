# Plan: Browser Pure-Logic Module

*Distilled: 2026-08-09*

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

- Exercising one branch of a string prefix check -- the paging cursor guard --
  requires booting a fake browser, seeding a fake `localStorage` with a token
  record, faking `fetch`, and running `initialize()` to completion. Cheap cases
  are therefore not written, and the guard has exactly one.
- Worse, the weight of that scaffolding hides dead assertions. The existing
  cursor test still passes with the guard deleted, because the fake `fetch`
  then rejects the off-origin URL itself and produces the same message and the
  same hidden list. This was confirmed by removing the guard in a scratch copy:
  16 of 16 tests still passed. A test that expensive should not be able to
  assert nothing without it being obvious.
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
  `TokenRejectedError`, `AuthorizationRevokedError`, `validTokenRecord`,
  `playlistLabel`, the playlist-page reader, the paging cursor check, and the
  `playlistsEndpoint` constant.
- Split `storeTokenResponse` into a pure record builder that takes the current
  time as an argument and the `localStorage` write that stays in `web/app.js`.
- Serve `/pure.js` and load it before `/app.js`.
- Add `web/pure_test.js` covering the moved logic directly, with no fakes.
- Load `web/pure.js` into the existing `vm` context in `web/app_test.js`, and
  strengthen the cursor integration test so that removing the guard fails it.
- Assert that the served page loads `/pure.js` before `/app.js`, and that
  `/pure.js` is an exact route.
- Update the documented test command.

Out of scope:

- Any change to authentication, listing, or rendering behavior. Every
  observable behavior is identical after this change, and the unchanged
  integration tests are the evidence.
- `settle(rounds)`, the harness helper that pumps the microtask queue a fixed
  number of times. It is a real fragility and it will not survive the shuffle
  increment's sequential batch writes, but it is independently fixable and
  unrelated to where the logic lives.
- Converting the browser app to ES modules. A top-level `import` could sit
  above the existing IIFE, so the wrapper would not have to change. The real
  cost is that `vm.runInContext` cannot execute module syntax, so the harness
  would need `vm.SourceTextModule` with a linker callback behind
  `--experimental-vm-modules`. That adds harness complexity to a change whose
  purpose is to remove it.
- jsdom, any npm dependency, a package manifest, or a bundler.
- Reducing the remaining integration tests. What survives proves wiring the
  pure tests cannot: storage writes, URL cleanup, fetch orchestration, and DOM
  state transitions. No integration test is deleted by this plan.
- The shuffle logic this refactor is meant to prepare for.

## Design

**One global, one invariant.** `web/pure.js` ends with a top-level
`var TrueShuffle = {...}`, which becomes a global property in a classic script
and lands on the context object under `vm.runInNewContext` identically. The
file's governing rule is that it may not reference `document`, `window`,
`fetch`, `localStorage`, `sessionStorage`, `crypto`, `location`, or `history`.
That rule is greppable, so it is checked rather than asserted.

**`encodeBase64URL` stays in `web/app.js`.** It calls `window.btoa`, which the
purity rule forbids. Dropping the `window.` qualifier would work under Node
itself, where `btoa` is a global, but not inside a bare `vm` context, where it
is undefined -- the pure tests would have to inject a platform global, which is
the fake-building this plan exists to stop. It is used only by
`randomBase64URL` and `codeChallenge`, both of which need Web Crypto anyway, so
it belongs beside the PKCE adapter.

**A pure test proves a function; only the harness proves the call site.**
Extraction moves value logic out; it does not move the obligation to prove that
production code invokes that logic at the right moment. The paging cursor check
is the case that matters, because the thing being prevented is sending a bearer
token off-origin. Today's integration test does not carry that weight: with the
guard deleted the fake `fetch` rejects the unrecognized URL itself, producing
the same failure message and the same hidden list, so the test passes either
way. It must assert that no request was ever issued to the off-origin URL,
which fails when the guard is gone. It is kept and strengthened, not replaced.

**Script order is an invariant, not a convention.** `app.js` reads
`TrueShuffle` while loading, so a reversed pair of tags breaks the page at
startup even though both tags are still present. `main_test.go` must compare
the positions of the two tags in the served page, not merely their presence.

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
  strengthen the cursor-rejection test to assert that no request reached the
  off-origin URL.
- `web/index.html`: load `/pure.js` with `defer` before `/app.js`.
- `main.go`: embed `web/pure.js` and serve it at `GET /pure.js` with the
  JavaScript content type and the existing browser security headers.
- `main_test.go`: assert the `/pure.js` route, content type, and headers; add
  `/pure.js/` to the exact-route cases; and replace the independent
  script-marker checks with a position comparison proving `/pure.js` is loaded
  before `/app.js`.
- `README.md`: the Test section names one browser test file and must name both.

No change is expected in the CSP constant, the OAuth scopes, the token storage
model, or any host configuration.

## Implementation Sequence

1. Create `web/pure.js` with the moved definitions, preserving behavior exactly.
2. Update `web/app.js` to consume the global and delete the moved copies.
3. Embed and route `/pure.js` in `main.go`, add the script tag to
   `web/index.html`, and update `main_test.go` for the route and markers.
4. Add `web/pure_test.js`.
5. Load `web/pure.js` into the `web/app_test.js` context and strengthen the
   cursor test. Verify it by deleting the guard in a scratch copy and
   confirming the test fails, then restoring it.
6. Update the README test command.
7. Run validation and confirm the surviving integration tests pass unmodified.
8. Commit and push. Deployment is a separate, gated step requiring explicit
   user direction and the private operations runbook named in `AGENTS.md`. The
   pending `20260809-playlist-listing.md` deployment is also outstanding, so
   when it is authorized the two can ship in one release.

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

Confirm the purity invariant as an assertion that fails loudly. `grep` exits
non-zero when it finds nothing, so the no-match case must be inverted rather
than read as success:

```sh
! grep -nE 'document|window|fetch|localStorage|sessionStorage|crypto|location|history' web/pure.js
```

Confirm the security wiring is actually load-bearing: delete the cursor guard
in a scratch copy of `web/`, run `node --test` against it, and require the
cursor test to fail. A guard whose removal keeps the suite green is not tested.

The strongest evidence of no behavior change is that every test in
`web/app_test.js` other than the strengthened cursor case passes with its
assertions unmodified. Any other edited assertion means behavior moved and must
be justified, not absorbed.

Manual browser validation, against the local server with no Spotify account
connected:

- Load the page and confirm both scripts load and the console reports no CSP
  violation and no missing-global error.

Validation requiring a live Spotify account -- confirming that listing,
selection, and disconnect still behave -- is performed only with explicit user
authorization, per `AGENTS.md`. Absent that, the deterministic tests in
`web/app_test.js` are the required evidence for those paths, and this plan does
not treat live confirmation as a precondition for completion.

Deployment validation, only once deployment is separately authorized and
performed under the private operations runbook:

- Confirm `/pure.js` returns 200 with the JavaScript content type and the
  security headers on the deployed origin.
- Confirm `trueshuffle.service` is active and `/healthz` responds.

## Success Criteria

- The moved logic is covered by tests that construct no fake DOM, storage,
  fetch, or window.
- `web/app.js` contains no remaining copy of the moved definitions.
- `grep` finds no browser global in `web/pure.js`.
- Deleting the paging cursor guard makes the cursor integration test fail.
- Every `web/app_test.js` test other than the strengthened cursor case passes
  with unmodified assertions, and the Go suite passes.
- `/pure.js` is served with the JavaScript content type and the existing
  security headers, is an exact route, and is proven by test to load before
  `/app.js`.
- The page loads with no missing-global error.
- The README names both browser test files in a single runnable command.
- Adding value logic in the next increment requires a new case in
  `web/pure_test.js` and no change to the harness.

## Execution Status

Implementation landed in `07eec92` (`Extract browser pure logic module`).
Steps 1 through 7 are complete and pushed; the gated deployment in step 8 is
not.

Implemented as planned, with two bounded corrections:

- `web/pure.js` wraps its definitions in an IIFE assigned to the single
  top-level `var TrueShuffle`, so helper names do not become additional
  globals. The one-global invariant is unchanged; `web/pure_test.js` asserts
  the context contains exactly `TrueShuffle`.
- `web/pure_test.js` normalizes vm-realm objects through JSON before strict
  deep equality, because objects built in the vm realm carry that realm's
  prototypes, which `assert.deepEqual` (strict) rejects. Content comparison
  remains strict.

Local validation, all passing:

- `gofmt -l main.go main_test.go`: no output.
- `go test ./...`, `go vet ./...`: ok, including the script-order position
  assertion, the `/pure.js` route, content type, headers, and exact-route
  cases.
- `node --check` on all four browser files: ok.
- `node --test web/pure_test.js web/app_test.js`: 25 passed, 0 failed.
- `! grep -nE 'document|window|fetch|localStorage|sessionStorage|crypto|location|history' web/pure.js`:
  no match, exit 0.
- Guard-deletion check: removing the cursor guard in a scratch copy made the
  strengthened cursor test fail (15 passed, 1 failed), proving the assertion
  is load-bearing; the scratch copy was discarded.
- Headless Chromium against a local server with a test client ID: the page
  reached the disconnected state with the connect control rendered and no CSP
  violation or script error, proving both scripts load in order and the
  global resolves.

Deployment, completed 2026-08-09 with explicit user direction under the
private operations runbook, as one release with the playlist-listing change:

- Release revision `869dbf8d969e4a299b118255808ab9af9b130486` (embedded
  `vcs.revision` verified, `vcs.modified` false), binary SHA-256
  `78800302947438eb9027e956cedd84fd3bfdc29889356d52ae2363ea2134fc1b`,
  installed with the previous release retained and the `current` symlink
  switched atomically.
- Host validation passed: Go suite, `go vet`, `node --check` on all four
  browser files, and 25 of 25 browser tests via direct `node` execution.
- Post-restart: service active, zero restarts, loopback-only listener, and
  `/pure.js` serving 200 with `text/javascript; charset=utf-8` on both the
  loopback listener and the public origin. Public `/` and `/healthz` healthy;
  no warning-or-higher journal entries.
