# Plan: Deterministic Browser Test Time

## Summary

Remove the browser suite's only wall-clock retry wait by keeping the telemetry
case focused on telemetry. Use a valid `Retry-After` above the inline retry
ceiling so the case records the header and structured reason without entering
the independently tested retry/countdown path.

## Problem

The telemetry test `a 429 with Retry-After and a structured reason is recorded`
uses a seven-second retry delay. Without a manual clock, the fake timer fires
on microtasks while real `Date.now()` advances, so the countdown loop consumes
about seven seconds. That case accounts for nearly the entire browser-suite
runtime and contradicts the testing model's no-wall-clock-wait invariant.

Retry timing, countdowns, and cooldown persistence already have dedicated
manual-clock tests. Adding more clock orchestration to this telemetry-only case
would duplicate their responsibility.

## Scope

In scope:

- Change the telemetry case to a valid `Retry-After` greater than the existing
  60-second inline retry ceiling.
- Keep assertions that the first event records `429`, the valid header value,
  `QUOTA_EXCEEDED`, and no raw Spotify message.
- Confirm the full browser suite no longer waits on elapsed wall time.

Out of scope:

- Production retry, cooldown, countdown, or telemetry behavior.
- New fake-clock APIs or broad test-harness refactoring.
- Arbitrary test-count reduction or assertion cleanup.

## Design

Use a value such as `61` seconds. It remains a valid bounded delta under
`normalizeRetryAfter`, but `shouldRetry429` rejects an inline retry because it
exceeds `maxCooldownWaitMs`. The operation therefore settles immediately with
one recorded request event. Existing manual-clock cases remain the sole owners
of short-retry and countdown behavior.

## Affected Components

- `web/app_test.js`: adjust the telemetry fixture and expected header value;
  retain its sanitization assertions.

## Implementation Sequence

Single-step change: update the fixture and assertion, then time the focused
file and the documented combined browser suite.

## Validation

```sh
time node --test --test-name-pattern='a 429 with Retry-After and a structured reason is recorded' web/app_test.js
time node --test web/pure_test.js web/app_test.js
```

## Success Criteria

- The telemetry case records the same fields without exercising an inline
  retry.
- The browser suite passes without a multi-second wall-clock wait.
- Production files and the test harness remain unchanged.
