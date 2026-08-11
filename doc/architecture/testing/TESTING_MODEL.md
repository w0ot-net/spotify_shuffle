# Testing model

*Revised: 2026-08-11*

This page owns the layered test strategy and the rules that keep it cheap.
Return to the [architecture index](../README.md).

Three layers, no external dependency in any of them:

1. **`web/pure_test.js` -- value logic, nothing faked.** The pure module is
   evaluated in an empty `vm` context, which itself proves the purity rule:
   the script runs with no browser or platform interface present. Tests call
   the functions directly -- record building and expiry arithmetic, page
   parsing and null-placeholder skipping, label pluralization, cursor
   acceptance and rejection.
2. **`web/app_test.js` -- wiring, through a fake browser.** A `vm` harness
   with a fake `window`, `document`, `fetch`, and storages boots the real
   two-script pair and runs `initialize()` to completion. It proves what
   pure tests cannot: storage writes, callback URL cleanup, fetch
   orchestration, DOM state transitions, and that production code invokes
   the pure logic at the right moments.
3. **`main_test.go` -- the served contract.** `httptest` against the real
   handler proves the route table and its exactness, content types, the
   literal CSP `connect-src` origins, the page's element markers, and that
   `/pure.js` is loaded before `/app.js` by position. `telemetry_test.go`
   proves the telemetry contract against temporary databases: secure
   creation, strict validation, idempotent duplicate acknowledgement,
   provenance and rate gates, failure-preserving retention, and that a
   dead store answers `503` while every other route stays healthy. The
   harness additionally captures submitted telemetry reports so wiring
   cases can assert evidence content and the absence of any Spotify
   identity, and its fake IndexedDB hosts the delivery queue so cases can
   prove persistence precedes transport, only a `204` removes a report,
   reloads drain oldest-first, and corruption or missing storage degrades
   to an honest one-shot send. Timing is deterministic: a manually
   advanced clock takes over `Date`, `performance`, and timers for pacing,
   retry-delay, and cooldown cases, so no test sleeps on the wall clock;
   harnesses without a clock run timers on the next microtask, which keeps
   paced waits free everywhere else.

```sh
go test ./...
node --test web/pure_test.js web/app_test.js
```

GitHub Actions runs these existing layers automatically for every pull request
and every push to `main`. One read-only Ubuntu job, bounded at ten minutes,
selects Go from `go.mod` and runs the browser suite on the documented Node 18
minimum. Go formatting, `go test`, `go vet`, the pure-module boundary, and the
two browser test files all gate that job; CI adds no package manager, external
account, deployment, or separate test framework.

## Rules

- **New value logic lands in `web/pure.js` with direct tests.** The harness
  must not grow a fake DOM behavior for logic that has no business touching
  the DOM.
- **The purity rule is validated by grep**, inverted so that no match is
  the passing case:

  ```sh
  ! grep -nE 'document|window|fetch|localStorage|sessionStorage|crypto|location|history' web/pure.js
  ```

- **A security guard's test must fail when the guard is removed.** A guard
  whose deletion keeps the suite green is not tested; it is decoration. The
  paging cursor guard is the standing example: its test asserts that no
  request ever reached the off-origin URL, verified by deleting the guard in
  a scratch copy and watching the test fail.
- **Assertions are not edited to absorb behavior changes.** An integration
  test that needs its assertions changed is evidence that behavior moved,
  and the move must be justified in the change that makes it.
