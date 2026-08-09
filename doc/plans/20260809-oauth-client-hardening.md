# OAuth Client Hardening

## 1. Summary and Goal

Harden the existing browser OAuth flow in three focused areas before playlist work begins:

- clear saved authorization only when Spotify explicitly returns `invalid_grant` during refresh;
- make temporary `sessionStorage` failures safe, including guaranteed callback URL cleanup;
- commit a small, dependency-free behavioral test suite for the token lifecycle.

Keep the current single-file browser application and current authentication architecture. This plan does not introduce a framework, package manager, general storage layer, or retry subsystem.

## 2. Scope Boundaries and Non-Goals

### In scope

- Classify Spotify refresh failures as permanent only when the token response contains `error: "invalid_grant"`.
- Retain the saved token record for rate limits, server failures, network failures, non-JSON failures, unexpected OAuth errors, and malformed successful responses.
- Prevent `sessionStorage` read, write, or removal failures from interrupting callback cleanup or causing a second failure in the connect error path.
- Add committed browser-script behavioral tests using only Node's built-in modules.
- Document the additional test command.
- Deploy and verify the updated application through the existing repository-based workflow.

### Out of scope

- Automatic retries, backoff, or `Retry-After` scheduling.
- Playlist reads, caching, shuffling, or writes.
- Refactoring `web/app.js` into modules or introducing a frontend framework.
- Adding npm dependencies, a package manifest, a test framework, or browser automation.
- Changing OAuth scopes, token-storage architecture, Apache, systemd, DNS, TLS, or Spotify dashboard settings.
- Addressing unrelated server hardening or UI polish.

## 3. Current-State Findings

- `web/app.js` uses `TokenRejectedError` for every non-successful token response and for malformed successful responses.
- The refresh handler deletes the saved token record whenever it catches that broad error, so a Spotify `429`, `5xx`, or other temporary failure can force an unnecessary login.
- `clearPendingAuthorization()` directly removes `sessionStorage` entries and can throw.
- Callback processing reads `sessionStorage` before removing OAuth parameters from the URL, so an unavailable storage API can leave `code` and `state` visible in the address bar.
- The connect error handler calls the same throwing cleanup function, allowing cleanup to mask the original error and leave the UI in an inconsistent state.
- The repository has Go handler tests but no committed behavioral tests for the 325-line browser authentication script.
- Spotify's documented refresh flow treats `invalid_grant` as the signal to discard a refresh token; other failures are surfaced without clearing it.

## 4. Proposed Design

### 4.1 Narrow permanent refresh failure classification

Keep token requests and refresh orchestration in `web/app.js`, but replace the broad permanent-error behavior with one explicit invariant:

> Only a parsed token error response whose OAuth error code is `invalid_grant` may cause refresh-token deletion.

The token request path will distinguish that response from all other failures. The refresh handler will:

1. clear the saved token record and show the reconnect state for `invalid_grant`;
2. retain the saved token record and show the existing reload/retry error state for every other failure.

This includes `429`, `5xx`, network errors, non-JSON error bodies, other OAuth error codes, and incomplete successful responses. Existing behavior that preserves the old refresh token when Spotify omits a replacement will remain unchanged.

No automatic retry behavior is added in this change.

### 4.2 Safe pending-authorization storage operations

Add only the small helpers needed for the two pending OAuth values:

- a write helper that stores state and verifier together, clears any partial result on failure, and reports one controlled error;
- a read helper that treats unavailable storage as missing pending authorization;
- a cleanup helper that makes best-effort removals and never throws.

Callback processing will remove the OAuth query parameters from browser history before a storage read can fail. A storage failure will then produce the existing safe authorization-failed UI without leaving callback credentials in the address bar.

The connect error path will use non-throwing cleanup so the original storage error is rendered and the button returns to a usable state.

These helpers remain specific to `sessionStorage`; no reusable storage abstraction is introduced.

### 4.3 Minimal committed behavioral tests

Add `web/app_test.js` using Node's built-in `node:test`, `assert`, and `vm` facilities. The test harness will evaluate the existing browser IIFE with small fakes for the DOM, browser history, storage, crypto, and `fetch`.

Cover only the lifecycle behaviors at issue:

- a `429` refresh response retains the saved token;
- a `5xx` or other representative temporary refresh failure retains the saved token;
- `invalid_grant` clears the saved token and requires reconnection;
- a successful refresh without a new refresh token preserves the existing one;
- callback URL cleanup still occurs when `sessionStorage` reads or removals throw;
- a connect-time `sessionStorage` write failure is handled without an unhandled cleanup exception and leaves the UI usable.

Do not expose production-only internals solely for testing. Drive behavior through the script's event handlers and observable storage, history, fetch, and DOM effects.

### 4.4 Test documentation

Extend the README test section with the Node requirement and the exact built-in test command. Keep the existing Go commands unchanged and do not add npm setup steps.

## 5. Affected Components

- `web/app.js`
  - narrow refresh-token invalidation;
  - safe pending OAuth storage helpers;
  - guaranteed callback URL cleanup.
- `web/app_test.js` (new)
  - dependency-free authentication lifecycle tests.
- `README.md`
  - reproducible JavaScript test instructions.
- Deployed `spotify-shuffle` binary
  - rebuilt and installed through the established remote repository workflow after validation.

No changes are expected in `main.go`, `main_test.go`, the HTML/CSS, server configuration, or Spotify application configuration.

## 6. Implementation Steps

1. Update the token request and refresh error handling in `web/app.js` so only an explicit `invalid_grant` response is classified as revoked authorization.
2. Add the three narrow pending-authorization storage helpers and order callback cleanup so URL parameters are removed before storage access can interrupt the flow.
3. Add `web/app_test.js` with the focused token and storage failure cases listed above.
4. Update the README test section with `node --test web/app_test.js` and the supported Node version.
5. Run all local validation commands and inspect the final diff for accidental scope growth.
6. Commit and push the implementation, pull it into the existing remote clone, rebuild, atomically install, restart, and verify the live service.

## 7. Validation Strategy

### Automated validation

Run locally:

```sh
node --check web/app.js
node --check web/app_test.js
node --test web/app_test.js
go test ./...
go vet ./...
git diff --check
```

The JavaScript tests must prove both sides of the refresh boundary: `invalid_grant` deletes authorization, while temporary or unexpected failures do not.

### Manual browser validation

- Complete a normal connect/callback flow and confirm the callback query is removed from the address bar.
- Reload while connected and confirm a valid saved token restores the connected state.
- Log out and confirm local authorization state is cleared.
- Confirm the connect button recovers to a usable error state when pending authorization cannot be stored, using the committed fake-storage test as the reproducible fault injection.

### Deployment validation

- Pull the pushed commit with `git pull --ff-only` in the existing remote clone.
- Run the Go tests and build on the remote host.
- Install the binary atomically and restart the existing service.
- Confirm the service is active with no restart loop.
- Confirm the local health endpoint and public HTTPS routes still respond successfully.

No live Spotify rate-limit or server-failure injection is required; those cases are deterministic in the committed test harness.

## 8. Risks and Mitigations

- **Risk:** An OAuth error is accidentally treated as permanent.
  - **Mitigation:** Centralize the `invalid_grant` check and test temporary HTTP failures separately.
- **Risk:** A malformed token response causes stale UI while retaining the token.
  - **Mitigation:** Show the existing reload/retry error state; retaining the record is safer than destroying authorization without proof of revocation.
- **Risk:** The browser test harness becomes a second application implementation.
  - **Mitigation:** Keep fakes minimal, assert observable behavior, and use no third-party libraries.
- **Risk:** Storage cleanup partially succeeds.
  - **Mitigation:** Treat cleanup as best effort and ensure failures cannot block URL cleanup or UI recovery.

## 9. Success Criteria

- A Spotify refresh response with `error: "invalid_grant"` clears the saved token and presents reconnection.
- `429`, `5xx`, network, parsing, and other unexpected refresh failures retain the saved token and present a retry/reload error.
- An omitted replacement refresh token does not overwrite the existing refresh token.
- `sessionStorage` failures cannot leave OAuth parameters in the callback URL or cause cleanup to mask the original connect error.
- The repository contains a passing, no-dependency JavaScript lifecycle test suite alongside the existing Go tests.
- The README gives reproducible commands for both test suites.
- The deployed application remains healthy and the existing connect, callback, logout, and authenticated reload flows continue to work.

## 10. Deferred Follow-Up

- Retry and backoff behavior for Spotify `429` and transient server failures.
- Playlist API integration and browser-side playlist caching.
- Any broader frontend modularization or end-to-end browser test tooling, if future complexity justifies it.
