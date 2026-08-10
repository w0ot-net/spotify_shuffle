# Plan: Page Expectation Language

## Summary

The page states, in three short sentences at the two moments they matter,
what connecting asks for and what clicking does: a fine-print line under
the Connect button covering permissions and the tokens-stay-in-this-
browser fact, and a fine-print line in the workspace covering the derived
"TrueShuffle" copy, the never-modified originals, and page-load freshness.
Both render as small muted text inside the existing panels and theme --
no new widgets, dialogs, or states.

## Problem

A first visitor sees only "Spotify is not connected in this browser" and
a Connect button, then a consent screen requesting modify permissions,
with no explanation of what the app does, why it needs writes, or that
its architecture keeps tokens client-side -- the most reassuring fact the
product has, currently stated only in the README. After connecting, the
list says "Select a playlist to shuffle it." with no warning that the
first click creates a playlist in the user's account, no statement that
originals are never touched, and no hint that edits made in Spotify after
page load are invisible until reload. Everything the page communicates
today is accurate but retroactive; expectations are set only by outcomes.

## Scope

In scope:

- A fine-print paragraph in the connection panel, visible exactly when
  the Connect button is visible: connecting asks Spotify for permission
  to read playlists and create the shuffled copies, and the Spotify login
  and tokens stay in this browser -- the server never sees the account.
- A static fine-print paragraph in the workspace panel: each shuffle
  writes a playlist's own "<em>playlist name</em> TrueShuffle" copy,
  created the first time and rewritten after; originals are never
  modified; changes made in Spotify after the page loads appear after a
  reload.
- A single shared fine-print style in `web/styles.css` consistent with
  the current theme's muted text; visibility of the connect note follows
  the Connect button via a CSS sibling rule so no render function
  changes.
- Served-page markers for both paragraphs in the Go page test; a harness
  assertion is not needed because the copy is static and the connect
  note's visibility is a stylesheet rule the harness cannot see.
- One sentence in the application-model page's document description
  naming the two fine-print lines.

Out of scope:

- The open-in-Spotify result link: the companion plan
  `20260810-open-target-link.md`.
- Any change to the dynamic status messages, the shadowed-duplicates
  note, or the consent scope list.
- Restating the duplicate-name limitation statically; the conditional
  note already covers it for exactly the users it affects.
- Marketing or help pages; the copy budget is three sentences total.

## Design

**Copy is fine print, not chrome.** Both paragraphs are small, muted,
single-purpose lines inside panels that already exist, styled by one
`.fineprint` rule drawn from the theme's existing muted-text treatment.
The masthead tagline stays the only voice line; these two lines are
contract language, kept short enough to be read rather than skipped.

**Visibility follows the Connect button by stylesheet, not by wiring.**
The connect note sits immediately after the buttons in the connection
panel and a `#connect[hidden] ~ .connect-note` rule hides it whenever the
Connect button is hidden. Every render function already sets that
attribute, so no JavaScript changes and no new state; the note is exactly
as visible as the action it explains.

**The words are the contract.** Exact copy, subject only to typographic
fitting during execution:

- Connect note: "Connecting asks Spotify for permission to read your
  playlists and create your shuffled copies. Your Spotify login and
  tokens stay in this browser; the TrueShuffle server never sees your
  account."
- Workspace note: "Each shuffle writes to a playlist's own
  '<em>playlist name</em> TrueShuffle' copy -- created the first time,
  rewritten every time after. Originals are never modified. Changes made
  in Spotify after this page loads appear after a reload."

## Affected Components

- `web/index.html`: the two fine-print paragraphs.
- `web/styles.css`: the `.fineprint` rule and the connect-note sibling
  visibility rule.
- `main_test.go`: served-page markers for both paragraphs.
- `doc/architecture/browser/APPLICATION_MODEL.md`: the fixed document
  description names the two fine-print lines.

## Implementation Sequence

Single-step change: markup, style, markers, and the doc sentence in one
commit; validate, push, and deploy per the standing directive through the
private runbook.

## Validation

```sh
gofmt -l main.go main_test.go
go test ./...
go vet ./...
node --check web/pure.js
node --check web/app.js
node --test web/pure_test.js web/app_test.js
git diff --check
```

Visual confirmation on the deployed page: the connect note appears only
while Connect is offered, both lines sit quietly in the theme, and
nothing shifts in the connected layout.

## Success Criteria

- Before connecting, the page states what will be asked for and that
  tokens never leave the browser; after connecting, that line is gone.
- The workspace states the derived-copy behavior, the never-modified
  guarantee, and the reload-for-freshness rule in one fine-print line.
- No JavaScript, state, or dynamic message changes; the JavaScript suites
  pass unmodified.
- The lines render in the existing theme as quiet fine print on desktop
  and phone widths.

## Execution Notes

Executed 2026-08-10. Implementation commit `2d3212b`.

Implemented as planned: the connect note sits inside the connection
panel's actions block after the buttons, hidden by the
`#connect[hidden] ~ .connect-note` stylesheet rule; the workspace note
closes the workspace panel; both share the new `.fineprint` rule built on
the theme's `--muted` token; the served-page test gained the
`sees your account.` and `Originals are never` markers; the
application-model fixed-document description names both lines. The copy
uses typographic quotes and an em dash via HTML entities, the fitting the
plan allowed. No JavaScript changed.

Deviations: the execution ran in a clean worktree at `origin/main`
because the primary worktree carried unrelated in-progress theme work in
the same files; those changes were left untouched and are not part of
this commit.

Validation, all passing in that worktree: `gofmt -l main.go main_test.go`
(no output), `go test ./...`, `go vet ./...`, `node --check` on both web
scripts, `node --test web/pure_test.js web/app_test.js` (120 pass,
0 fail), `git diff --check`. Visual confirmation on the deployed page is
recorded with the companion plan's deployment.
