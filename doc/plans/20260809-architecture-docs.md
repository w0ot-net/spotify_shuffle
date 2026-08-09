# Plan: Architecture Documentation Tree

*Distilled: 2026-08-09*

## Summary

Create a `doc/README.md` documentation map and a `doc/architecture/` tree of
topic pages, modeled on the structure used by the `static_bins` repository: an
index that owns authority rules and a reading order, plus short pages that each
own one stable system concern. The tree records what TrueShuffle is today --
sourced from the current code and completed-plan execution notes -- so future
feature design can happen as reviewable edits to named pages instead of
re-deriving the system from `main.go` and `web/app.js` each time.

## Problem

The repository has no current-state architecture documentation. What exists is:

- `README.md`, a user entry point that compresses status, security, and test
  commands into a few paragraphs.
- `AGENTS.md`, contributor guardrails with no system description.
- Eight completed plans that each describe one increment. They are historical
  records: correct about their change, silent about everything since, and
  explicitly not maintained as current truth.

The consequences are concrete:

- Design conversations have no shared reference. Deciding where playlist-item
  caching or shuffle ordering belongs requires re-reading the code and several
  completed plans to reconstruct invariants that are load-bearing but recorded
  nowhere current: the server never sees a token, `web/pure.js` may not
  reference platform globals, a listing failure must not clear authorization,
  the deployed revision must equal its release-directory name.
- Every new plan re-states architecture from scratch. The two 20260809 plans
  each spend paragraphs re-deriving the token lifecycle and test harness before
  proposing anything.
- There is exactly one place -- this repository -- where the design is
  recoverable, and it is recoverable only by reading all of it.

## Goal

After implementation:

- `doc/README.md` routes each kind of information to exactly one authority.
- `doc/architecture/` pages own the stable responsibilities, boundaries, and
  invariants of the system as it exists at head, each page one concern.
- Planned behavior appears only where explicitly marked as planned, per the
  `AGENTS.md` rule against describing planned behavior as implemented.
- The next feature plan can name the pages it changes in Affected Components
  and state its design as a delta against them.

## Scope

In scope:

- `doc/README.md`: the documentation map.
- `doc/architecture/README.md`: the index with a system diagram, authority
  rules, and reading order.
- Seven topic pages, listed under Affected Components.
- A pointer from the root `README.md` and an architecture-ownership rule in
  `AGENTS.md`.

Out of scope:

- Any code, test, route, CSP, or deployment change. This is documentation only.
- Restating the private runbook. The deployment page describes the production
  model using only facts already committed to this repository; access
  procedure stays machine-local per `AGENTS.md`.
- A roadmap document. Product intent stays in the root `README.md` Goals
  section; the architecture pages record what is, not what is hoped.
- Rewriting or moving completed plans, and any change to their content.
- Diagram tooling. Diagrams are ASCII text, as in `static_bins`.

## Design

**The `static_bins` conventions, adopted as-is.** Each topic page opens with
"This page owns ..." and a link back to the index, so ownership is declared,
not implied. The index owns the one system diagram, the authority rules, and
the reading order. The map at `doc/README.md` routes to authorities and states
that plans are implementation records, not current architecture. Area
subdirectories (`service/`, `browser/`, `security/`, `integration/`,
`testing/`, `deployment/`) group pages so future design work has a defined
home -- a data-model page will belong under `browser/`, a rate-limit page
under `integration/` -- without renaming anything.

**Pages own concerns, not files.** The split follows the system's real
boundaries, which do not coincide with its four source files:

- The service model is `main.go` alone, but the security model spans the
  headers `main.go` sets and the rules `web/app.js` obeys.
- The browser application model covers the two-script structure; the
  authorization model covers a lifecycle that lives in `web/app.js` and
  `web/pure.js` jointly.

**Current truth is sourced, not invented.** Every statement in the pages must
be checkable against head: the code for behavior, `main_test.go` and the two
JavaScript test files for the proven contract, and completed-plan execution
notes for production facts (the `/opt/trueshuffle` layout, the release
identity invariant, the loopback listener behind the reverse proxy). Facts
that exist only in the private runbook do not enter the pages.

**Planned behavior is quarantined.** Exactly two forward-looking facts are
permitted, both already public in `README.md`: the modify scopes are granted
but unexercised, and selection state is the attachment point for the next
increment. Each mention is marked as planned in place; no other future
behavior enters the pages.

**Each page carries a revision date.** `AGENTS.md` requires a revision date
near the top when an architecture document is rewritten; the pages start with
one so the rule applies from the first edit.

**Authority rules prevent drift with `README.md`.** The root README keeps user
entry points: what the project is, how to run it, how to test it, current
status. Architecture pages own the deeper system description. The README gains
a two-line Documentation section pointing at `doc/README.md`; nothing is
removed from it, because its Status and Browser security sections are the
user-facing summary the authority rules assign to it.

## Affected Components

- `doc/README.md` (new): documentation map routing to the root README,
  `AGENTS.md`, the architecture index, and the plan directories, with the
  plans-are-records rule stated.
- `doc/architecture/README.md` (new): system summary, ASCII diagram of the
  browser/service/Spotify trust boundary, authority rules, reading order.
- `doc/architecture/service/SERVICE_MODEL.md` (new): the Go service as a
  stateless shell -- embedded assets, the exact route table, the public-config
  endpoint exposing only the public client ID, the health endpoint, listen
  address model. Owns the invariant that the service stores nothing and never
  receives a token.
- `doc/architecture/browser/APPLICATION_MODEL.md` (new): the two-script
  structure -- `web/pure.js` value logic under the greppable purity rule,
  `web/app.js` as the platform adapter consuming the `TrueShuffle` global,
  script-order dependency, and the structural lifecycle: `initialize()` as the
  sole entry point and the page-state vocabulary. Which authorization outcome
  produces which state belongs to the authorization page.
- `doc/architecture/browser/AUTHORIZATION_MODEL.md` (new): Authorization Code
  with PKCE entirely in-browser; the storage model (versioned `localStorage`
  token key retaining the legacy namespace, `sessionStorage` state and
  verifier); refresh only during `initialize()` under the expiry skew; failure
  classification stated per path -- any callback failure clears the stored
  record, a refresh failure clears it only on a parsed `invalid_grant`, and a
  listing failure never does; disconnect semantics. Owns how authorization
  outcomes map onto the page states.
- `doc/architecture/security/SECURITY_MODEL.md` (new): the CSP and its
  rationale directive by directive, the response header set, the connect-src
  origin allowlist, bearer-token origin confinement via the cursor guard,
  third-party text rendered only through `textContent`, the no-third-party-
  script rule for the authenticated origin.
- `doc/architecture/integration/SPOTIFY_INTEGRATION.md` (new): the endpoints
  in use (authorize, token, playlists), paging bounds and fail-fast posture,
  scopes granted versus exercised (modify scopes marked planned), the deferred
  retry/backoff stance.
- `doc/architecture/testing/TESTING_MODEL.md` (new): the layered strategy --
  `web/pure_test.js` with no fakes, the `web/app_test.js` vm harness proving
  wiring and DOM transitions, `main_test.go` proving the served contract; the
  rule that new value logic lands in `web/pure.js` with direct tests; the rule
  that a security guard's integration test must fail when the guard is
  removed.
- `doc/architecture/deployment/DEPLOYMENT_MODEL.md` (new): the
  `/opt/trueshuffle` tree, commit-addressed releases with the
  release-directory-equals-embedded-revision invariant, the atomic `current`
  switch, the systemd dynamic-user unit, the loopback listener behind the
  TLS reverse proxy, and the boundary statement that access procedure lives in
  the machine-local runbook.
- `README.md`: add a short Documentation section linking `doc/README.md` and
  the architecture index.
- `AGENTS.md`: add one Documentation rule naming `doc/architecture/` as the
  authority to consult for stable system design. The existing rule to update
  affected documentation alongside code already covers keeping it current and
  is not restated.

## Implementation Sequence

1. Write `doc/architecture/README.md`, fixing the diagram, authority rules,
   and reading order first so the topic pages have a frame to fit.
2. Write the seven topic pages from the current code and test files, checking
   each claim against head rather than against plan documents.
3. Write `doc/README.md` linking every page and both plan directories.
4. Add the `README.md` Documentation section and the `AGENTS.md` rule.
5. Run validation, then commit the new and edited files by explicit path and
   push.

## Validation

```sh
git diff --check
LC_ALL=C grep -rn '[^ -~]' doc/README.md doc/architecture/ && echo NON-ASCII || echo ok
```

Link integrity: every relative Markdown link target under `doc/README.md` and
`doc/architecture/` must exist on disk, every topic page must be linked from
both the index and the map, and each topic page must link back to the index.
Checked with a shell loop over `grep -oE '\]\([^)]+\)'` output at execution
time; nothing is committed for this.

Content review against the sources of truth:

- Route table and headers against `main.go`; lifecycle and storage claims
  against `web/app.js` and `web/pure.js`; test-contract claims against
  `main_test.go`, `web/pure_test.js`, `web/app_test.js`.
- Production facts only from completed-plan execution notes already in the
  repository; no hostname, path, or procedure that exists solely in the
  private runbook.
- Only the two permitted planned facts appear, every mention marked planned.

No Go, Node, or live-service validation applies to a documentation-only
change.

## Success Criteria

- `doc/README.md` names one authority for each kind of information, and the
  architecture index states the authority rules and reading order.
- Each topic page owns one concern, opens with its ownership statement, links
  back to the index, and carries a revision date.
- Every statement in the pages is checkable against head; planned behavior
  is limited to the two permitted facts, every mention marked planned.
- No page contains runbook-only access details.
- All links resolve, all files are ASCII, and the root `README.md` and
  `AGENTS.md` point contributors at the tree.
- The next feature plan can list the architecture pages it changes as
  affected components.
