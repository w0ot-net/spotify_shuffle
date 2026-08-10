# Plan: Open-in-Spotify Result Link

## Summary

A successful shuffle ends with one tap into the result: an "Open in
Spotify" link appears beside the Created/Updated message, pointing at the
derived playlist on `open.spotify.com`. The link is a single fixed-label
anchor whose URL is constructed against a fixed origin with the encoded
playlist id, shown only while a just-written result is on screen, and
styled as a quiet action in the existing theme.

## Problem

The result message names the derived playlist ("Updated \"Liked Songs
TrueShuffle\" with 4,549 tracks in 13.5s.") but the user's next act --
listening to it -- requires leaving the page and finding the playlist by
name in Spotify. The app holds the playlist id at that moment; making the
user retype the name into Spotify search is a needless seam at the exact
point the product delivers its value.

## Scope

In scope:

- A static anchor in the workspace panel, `id="open-target"`, label "Open
  in Spotify", `target="_blank"` and `rel="noopener"`, hidden by default.
- On a successful write, `web/app.js` sets its `href` to
  `https://open.spotify.com/playlist/` plus the URI-encoded target id and
  unhides it; the link hides again when a new chain starts, on any chain
  failure, and on disconnect.
- Harness cases: the link appears with the exactly constructed `href`
  after a created and an updated result; it is hidden during a running
  chain, after a failed chain, and after disconnect.
- The served-page marker in the Go page test; a `.fineprint`-consistent
  quiet-action style in `web/styles.css`.
- One sentence each in the application-model page (the result state
  offers the link) and the security-model page (outbound navigation link
  to a fixed origin with an encoded id, carrying no token; CSP is
  unaffected because `connect-src` governs fetches, not navigations).

Out of scope:

- Deep links into the Spotify native app (`spotify:` URIs);
  `open.spotify.com` already hands off to the installed app on phones.
- Links anywhere else (list rows, failure states, the shadowed note).
- Any change to the write flow, messages, or the ownership invariant.

## Design

**The label is fixed text; only the URL is dynamic.** The status lines
keep their textContent-only discipline: the anchor is a separate static
element whose label never changes, and the only dynamic part is `href`,
built as fixed origin plus `encodeURIComponent(target.id)` -- the same
constructed-URL rule every API request already follows, applied to a
Spotify-supplied id. The URL carries no token or account data; `noopener`
severs the opened tab from the page.

**Visibility equals a standing result.** The link is shown at the one
moment the Created/Updated message renders and hidden by the same paths
that retire that message: chain start, chain failure, disconnect. It
therefore never points at a playlist whose write did not verify, and a
"may be incomplete" failure never carries an invitation to open the
wreckage.

**Placement and tone.** The anchor sits with the track status line and
takes a quiet-action treatment from the existing theme -- visible when
wanted, silent otherwise, no button chrome competing with the real
actions.

## Affected Components

- `web/index.html`: the anchor element.
- `web/app.js`: setting, showing, and hiding the link at the named
  moments.
- `web/app_test.js`: the appearance, exact-href, and hiding cases.
- `web/styles.css`: the quiet-action link style.
- `main_test.go`: the `open-target` marker.
- `doc/architecture/browser/APPLICATION_MODEL.md` and
  `doc/architecture/security/SECURITY_MODEL.md`: one sentence each as
  named in scope.

## Implementation Sequence

Single-step change: element, wiring, tests, style, markers, and the two
doc sentences in one commit; validate, push, and deploy per the standing
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

The harness must prove the exact `href` for a created and an updated
target, and that the link is absent during chains and after failure and
disconnect. Live confirmation: shuffle a real playlist and follow the
link into the derived playlist.

## Success Criteria

- Every successful shuffle ends with a working one-tap "Open in Spotify"
  link to the exact derived playlist, opened in a new tab with
  `noopener`.
- The link never appears alongside a failure, during a chain, or after
  disconnect, and its label never carries dynamic text.
- The purity grep stays clean; all prior tests pass unmodified.

## Execution Notes

Executed 2026-08-10. Implementation commit `ff04415`.

Implemented as planned: the static anchor beside the track status line,
`href` set at the success render in `writeShuffled` from the fixed origin
plus the encoded target id, hidden at chain start in `runShuffle`, in
`clearPlaylists` on disconnect, and implicitly on every failure since
only success unhides it; the `.quiet-link` accent style; the
`open-target` page marker; and the security-model and application-model
sentences. One comprehensive harness case drives the whole lifecycle:
created href, hidden while a gated chain runs, updated href on the same
target, hidden after a failed write, restored by the next success, and
retired by disconnect.

Deviations: as with the companion plan, execution ran in a clean worktree
at `origin/main` because the primary worktree carried unrelated
in-progress theme work in the same files; those changes are untouched.

Validation, all passing in that worktree: `gofmt -l main.go main_test.go`
(no output), `go test ./...`, `go vet ./...`, `node --check` on both web
scripts, `node --test web/pure_test.js web/app_test.js` three consecutive
runs (121 pass, 0 fail each), `git diff --check`, and the inverted purity
grep.
