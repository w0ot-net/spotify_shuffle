# Plan: Minimal Go HTTP Server

## Summary

Establish the smallest runnable Go foundation for the project: one module, one
HTTP entry point, and one health endpoint. The server will bind to a configurable
address, remain free of external dependencies, and include a focused handler
test and accurate run instructions.

## Problem

The repository currently contains only project guidance and a planning README;
there is no executable application or validation path. Before adding Spotify or
browser behavior, the project needs a minimal server that can be built, run, and
tested locally.

## Scope

In scope:

- Initialize the Go module as `github.com/w0ot-net/spotify_shuffle` using the
  locally supported Go 1.22 language version.
- Add one executable at the repository root.
- Listen on `127.0.0.1:8080` by default and honor `LISTEN_ADDR` when it is set.
- Serve `GET /healthz` as plain text with status `200 OK` and body `ok\n`.
- Add one focused HTTP handler test for the health response.
- Update `README.md` with implemented status and local run/test commands.

Out of scope:

- Spotify API access, OAuth, credentials, playlists, caching, and shuffle jobs.
- User interface or other application routes.
- Persistent state, sessions, background workers, and progress reporting.
- Apache, TLS, systemd, domain configuration, or other deployment files.
- Graceful shutdown, production hardening, observability, and additional health
  semantics beyond proving that the HTTP process is serving requests.

## Design

Keep the initial implementation in the module root to avoid choosing a package
hierarchy before the application has multiple responsibilities. `main.go` will
construct an `http.ServeMux` through a small `newHandler` function shared by the
executable and its test. The Go 1.22 method-aware route pattern will restrict the
health handler to `GET /healthz`.

`main` will read `LISTEN_ADDR` directly, apply `127.0.0.1:8080` only when the
variable is empty, and start the standard-library HTTP server. Startup or bind
failure will be reported and terminate the process with a non-zero status rather
than being hidden by fallback behavior. No third-party router, configuration
package, or derived configuration state is needed for this outcome.

The health contract is intentionally small and deterministic: `200 OK`, plain
text, and `ok\n`. The test will exercise the handler in memory with
`net/http/httptest`; it will not open a port or require external services.

## Affected Components

- `go.mod`: declare the module identity and Go language version.
- `main.go`: own address configuration, HTTP routing, and process startup.
- `main_test.go`: materially cover the new `/healthz` contract.
- `README.md`: replace the no-implementation status with exact local run and
  validation instructions while retaining future goals as goals.

## Implementation Sequence

1. Initialize `go.mod` without third-party dependencies.
2. Add the standard-library server, direct address configuration, and health
   handler in `main.go`.
3. Add the focused handler test in `main_test.go`.
4. Update `README.md` to describe only the behavior now implemented and the
   commands to run and test it.

## Validation

- Run `gofmt -w main.go main_test.go`.
- Run `go test ./...`.
- Start the server with a non-default local address, request `/healthz`, and
  verify status `200`, plain-text content, and body `ok`; then stop the process.
- Run `git diff --check` before committing.

## Success Criteria

- `go run .` starts an HTTP server on `127.0.0.1:8080` when `LISTEN_ADDR` is
  unset.
- Setting `LISTEN_ADDR` changes the bind address without changing code.
- `GET /healthz` returns the documented deterministic health response.
- The focused test passes without network access or external services.
- The README accurately separates this implemented foundation from planned
  Spotify functionality.
- No Spotify, frontend, storage, proxy, service-manager, or production-hardening
  behavior is introduced.

## Execution Notes

Completed on 2026-08-08.

Implemented behavior:

- Added the `github.com/w0ot-net/spotify_shuffle` Go 1.22 module.
- Added a root standard-library HTTP server with a default
  `127.0.0.1:8080` listener and `LISTEN_ADDR` override.
- Added the deterministic `GET /healthz` response and its focused in-memory
  test.
- Updated the README with the implemented status and exact run, override,
  health-check, and test commands.

Changed ownership boundaries:

- `main.go` owns process startup, listen-address selection, and routing.
- `main_test.go` owns the health endpoint contract test.
- No package hierarchy or external dependency was introduced.

Deviations:

- None.

Validation:

- `gofmt -w main.go main_test.go`: completed successfully.
- `go test ./...`: passed for `github.com/w0ot-net/spotify_shuffle`.
- Temporary-build smoke check with `LISTEN_ADDR=127.0.0.1:18080`: returned
  status `200`, `Content-Type: text/plain; charset=utf-8`, and body `ok\n`.
- `git diff --check`: passed before the implementation commit.

Implementation commit:

- `7985e61` (`Add minimal Go HTTP server`).

Unresolved blockers and excluded follow-up:

- None. Spotify integration, frontend behavior, storage, deployment,
  observability, graceful shutdown, and production hardening remain deliberately
  outside this completed plan.
