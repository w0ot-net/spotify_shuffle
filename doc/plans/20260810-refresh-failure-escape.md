# Plan: Refresh-Failure Escape Hatch

## Summary

The "Spotify could not be reached. Reload to try again." state stops being
a dead end: it keeps the stored token and its reload advice, but now also
shows the existing "Disconnect this browser" button, whose unchanged flow
clears the stale token and lands on the ordinary Connect screen. A browser
stuck with a token that can never refresh recovers in one tap on the page,
with no per-site data surgery in browser settings.

## Problem

A refresh failure that is not proof of revocation deliberately keeps the
stored token and asks for a reload. When the failure is actually
persistent -- observed live on 2026-08-10: an iPhone whose stored token
fails refresh on every reload while a desktop connection works -- the page
renders only the error text: `renderError` hides the disconnect button
unconditionally and this call site passes no reconnect. There is no
control on the page at all, so the only recovery is deleting the site's
browser data in device settings, which is unacceptable UX and effectively
unreachable for most users.

The disconnect flow that already exists is exactly the needed escape: it
aborts active work, clears the token and page state, and renders the
disconnected screen with Connect available.

## Scope

In scope:

- `renderError` takes an explicit third argument, `canDisconnect`, wired
  at every existing call site; only the temporary-refresh-failure site
  passes true. The button keeps its label and its existing click flow
  unchanged.
- The refresh-failure message becomes "Spotify could not be reached.
  Reload to try again, or disconnect this browser and connect again."
- Extend the existing temporary-refresh-failure harness cases to assert
  the disconnect button is visible and enabled, and add one case driving
  the full escape: refresh fails, disconnect is clicked, the token is
  cleared, and the disconnected state offers Connect. The message-text
  assertions in those cases move to the new wording; this is the planned
  behavior change, not absorption.
- One sentence each in the authorization-model failure-classification
  section (reload advice now comes with a local disconnect escape) and the
  application-model connection-state vocabulary (the error state may offer
  disconnect).

Out of scope:

- Reclassifying token-endpoint errors such as `invalid_client` as
  terminal. Distinguishing permanently-doomed refreshes from transient
  ones risks clearing tokens on outages; the escape hatch makes the
  distinction unnecessary for recovery.
- The crypto-unsupported and configuration-failure error states. Neither
  is recoverable by disconnecting (no PKCE without WebCrypto; no connect
  without configuration), so they keep their current rendering.
- Any automatic refresh retry or backoff; the fail-fast posture stands.

## Design

**The escape is the existing disconnect, not a new flow.** The logout
listener already aborts the active chain, clears the pending
authorization, token, caches, and page state, and renders the disconnected
screen. This plan only makes the button reachable from the one stuck state
whose whole problem is a retained token, so there is no new state,
listener, or teardown logic.

**Explicit at every call site.** `renderError(message, canReconnect,
canDisconnect)` with all sites updated keeps the rendering rule visible
where each state is produced, matching the repository preference for
explicit invariants over defaults. Revocation and callback failures keep
disconnect hidden: their token is already cleared, so Connect alone is the
honest offer.

**Failure scope.** The kept-token contract of temporary refresh failures
is untouched -- nothing is cleared until the user taps the button -- and
no other state's rendering changes.

## Affected Components

- `web/app.js`: the `renderError` signature and its call sites; the
  refresh-failure message text.
- `web/app_test.js`: the temporary-refresh-failure cases assert the
  visible, enabled disconnect button and the new message; one new case
  proves the full tap-through recovery.
- `doc/architecture/browser/AUTHORIZATION_MODEL.md`: the
  failure-classification sentence gains the escape.
- `doc/architecture/browser/APPLICATION_MODEL.md`: the connection-state
  vocabulary notes the error state may offer disconnect.

## Implementation Sequence

Single-step change: signature, call sites, message, tests, and the two doc
sentences in one commit; validate, push, and deploy per the standing
directive through the private runbook.

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

The harness must prove: every temporary-refresh-failure case shows the
enabled disconnect button while the token remains stored; clicking it
clears the token and renders the disconnected state with Connect; the
revocation, callback-failure, crypto-unsupported, and
configuration-failure states render exactly as before. Live confirmation
is the stuck iPhone itself: after deployment, reload the page there, tap
"Disconnect this browser", and connect again.

## Success Criteria

- The temporary-refresh-failure state renders the new message with an
  enabled "Disconnect this browser" button; tapping it lands on the
  ordinary Connect screen with the stale token gone.
- No token is cleared and no other state's rendering changes until the
  user taps the button.
- The stuck iPhone recovers entirely from the page, with no browser
  settings involved.
- The purity grep stays clean; all prior tests pass unmodified except the
  refresh-failure message and visibility assertions named in scope.
