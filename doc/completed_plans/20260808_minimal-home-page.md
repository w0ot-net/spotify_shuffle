# Plan: Minimal Home Page

## Summary

Add the project's first browser-facing response as a static HTML page served at
the exact root path. Embed one HTML file into the existing Go binary, register
it on the current handler, and cover the response contract without introducing
templates, frontend tooling, or interactive behavior.

## Problem

The current server exposes only `/healthz`, so opening it in a browser does not
provide a project page. The next small foundation is a mobile-compatible root
document that identifies the application and accurately states that Spotify is
not connected yet.

## Scope

In scope:

- Add one semantic HTML document containing the `Spotify Shuffle` heading.
- Include UTF-8 metadata and a mobile viewport declaration.
- Display the status text `Spotify connection is not configured yet.`
- Embed the document into the Go executable at build time.
- Serve it as `text/html; charset=utf-8` from `GET /` only.
- Add focused in-memory coverage for the root response.
- Update the README status and local browser URL while preserving planned work
  as planned work.

Out of scope:

- Spotify configuration, OAuth, API calls, credentials, or connection state.
- Buttons, forms, navigation, client-side JavaScript, or interactive behavior.
- CSS, images, icons, manifests, service workers, or frontend build tooling.
- Templates, shared layouts, asset pipelines, or a general static-file server.
- Deployment, browser automation, accessibility audits, and visual polish.

## Design

Place the source document at `web/index.html` so browser content remains
separate from Go source. `main.go` will use `//go:embed` to compile that single
file into a package variable and register a handler on the existing mux. No
runtime filesystem access, template engine, or new package is needed.

Use the Go 1.22 pattern `GET /{$}` rather than `GET /`. The `{$}` marker makes
the route exact, preventing the home page from becoming a catch-all for unknown
paths while preserving the existing, more specific `GET /healthz` behavior.
The handler will set the HTML content type explicitly and write the immutable
embedded document.

Extend `main_test.go` with one root-page test using `net/http/httptest`. Directly
assert the status and content type, then check the response for the viewport,
heading, and not-configured status markers. Reuse `newHandler`; do not introduce
a renderer or testing-only abstraction.

## Affected Components

- `web/index.html`: own the complete minimal browser document.
- `main.go`: embed the document and register the exact root handler.
- `main_test.go`: materially cover the new root response contract.
- `README.md`: describe the now-implemented minimal browser page and its local
  URL without claiming Spotify integration exists.

## Implementation Sequence

1. Add the standalone semantic document at `web/index.html`.
2. Embed it in `main.go` and register `GET /{$}` on the existing mux.
3. Add focused root-response coverage to `main_test.go`.
4. Update the README status and local-use instructions.

## Validation

- Run `gofmt -w main.go main_test.go`.
- Run `go test ./...` to cover both the new page and existing health contract.
- Build the executable into a temporary directory, run it from that directory
  without a `web/` tree, and request `/` to prove the page is embedded.
- Verify the live root response has status `200`, HTML content type, viewport,
  heading, and status markers.
- Recheck `/healthz` in the same smoke run to ensure it remains unchanged.
- Run `git diff --check` before committing.

## Success Criteria

- Opening `/` returns a valid minimal HTML document identifying Spotify
  Shuffle and stating that Spotify is not configured.
- The document includes mobile viewport metadata and requires no JavaScript or
  external assets.
- The page is served from the compiled binary without runtime source files.
- `/healthz` retains its existing response contract.
- Tests pass without a browser, network access, Spotify credentials, or
  external services.
- No authentication, interactive UI, styling system, or deployment behavior is
  introduced.

## Execution Notes

Completed on 2026-08-08.

Implemented behavior:

- Added a semantic, mobile-compatible document at `web/index.html` with the
  project heading and not-configured status.
- Embedded that document into the Go executable and served it from the exact
  `GET /{$}` route with an explicit HTML content type.
- Added focused in-memory coverage for the root response while retaining the
  existing health test.
- Updated the README status and local browser URL.

Changed ownership boundaries:

- `web/index.html` owns the complete static home document.
- `main.go` owns embedding and serving the document through the existing mux.
- `main_test.go` owns the root response contract alongside the existing health
  contract.
- No template engine, static-file server, frontend dependency, or new package
  was introduced.

Deviations:

- None.

Validation:

- `gofmt -w main.go main_test.go`: completed successfully.
- `go test ./...`: passed for `github.com/w0ot-net/spotify_shuffle`.
- Temporary-directory binary smoke check: `/` returned status `200`, the
  expected HTML content type, viewport metadata, heading, and status without a
  runtime `web/` tree.
- The same smoke process returned the unchanged `/healthz` status, content
  type, and `ok\n` body.
- `git diff --check`: passed before the implementation commit.

Implementation commit:

- `87eca6b` (`Add minimal embedded home page`).

Unresolved blockers and excluded follow-up:

- None. Spotify configuration and authentication, interactive controls,
  JavaScript, styling, and deployment remain deliberately outside this
  completed plan.
