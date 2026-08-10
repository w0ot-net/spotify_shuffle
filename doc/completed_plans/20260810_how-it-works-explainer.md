# Plan: How-It-Works Explainer

*Distilled: 2026-08-10*

## Summary

The page gets one short, readable "How it works" section inside the
workspace panel, taking the place of today's fine-print line, that states
the product's contract and its real limitations before the first click:
shuffling a playlist creates a private copy named after it (the first
shuffle creates that copy, every later shuffle rewrites the same copy,
originals never modified), the copy must be played with Spotify's own
shuffle off, a large playlist's first shuffle takes minutes while repeats
of an unchanged playlist take seconds, and Spotify-side changes appear
after a reload. A one-line note beside the Disconnect button adds
the last missing fact: disconnecting forgets this browser but does not
revoke the grant in Spotify. Everything is static HTML plus stylesheet
rules; no script changes.

## Problem

The derived-copy contract exists on the page today only as 0.72rem muted
fine print below the playlist list -- quiet enough that a careful reader
missed it and formed the mental model "this shuffles my playlist" rather
than "this writes a copy." Three facts a user needs are nowhere on the
page at all: the shuffled order is baked into the copy, so playing it with
Spotify's shuffle toggle on silently defeats the entire product; the
deliberately paced Spotify lane makes a multi-thousand-track first shuffle
take minutes (the countdown UI explains waits only after they begin); and
"Disconnect this browser" does not revoke the Spotify authorization
(README-only today). The page explains none of this where a first-time
visitor will read it.

## Scope

In scope:

- A static explainer block inside the workspace panel in `web/index.html`:
  a small heading and four short statements (derived-copy contract and
  never-modified guarantee; play the copy with Spotify shuffle off;
  first-shuffle duration expectation and fast unchanged repeats; reload
  for Spotify-side freshness).
- Retiring the workspace fine-print line, whose position and content the
  explainer takes over. The connect note (permissions and
  tokens-stay-here) is unchanged.
- A one-line disconnect note in the connection panel's actions --
  "forgets this browser; revoke in your Spotify account settings" in
  substance -- visible exactly when the Disconnect button is, by the same
  sibling-selector mechanism the connect note uses.
- Stylesheet rules in `web/styles.css`: explainer typography inside the
  existing workspace panel -- body text muted but readable (larger than
  `.fineprint`, smaller than body copy), a small muted heading in the
  existing type system; a `#logout[hidden] ~ .disconnect-note` visibility
  rule mirroring the connect note's.
- `main_test.go` served-page markers: replace the retired
  `Originals are never` marker with one distinctive phrase pinned from
  each new block (the derived-copy sentence, the shuffle-off sentence,
  and the disconnect note).
- Documentation whose contract changes: the fixed-document paragraph in
  `doc/architecture/browser/APPLICATION_MODEL.md` (the workspace note is
  replaced by the explainer section and the disconnect note joins the
  connect note as the second stylesheet-gated line), and one or two
  sentences in `README.md`'s status/theme description so the user entry
  point reflects the on-page explainer and the shuffle-off guidance.

Out of scope:

- Any change to `web/app.js`, `web/pure.js`, or their tests -- the
  explainer is static and no script reads or writes it.
- The duplicate-name shadowing explanation: the list status line already
  carries its own counting note when deduplication hides rows.
- The production Spotify write-403 registration problem -- an operational
  matter tracked outside the page, temporary by nature, and wrong to bake
  into permanent page copy.
- Restating the connect note's privacy content anywhere else, and any
  onboarding beyond this one section (tours, dismissible banners,
  accordions).

## Design

**Static content, existing theme, no new mechanisms.** The explainer is a
`class="explainer"` block inside the workspace panel, standing exactly
where the retired fine-print line stands today, at the panel's end. The
position is load-bearing: before connecting, everything else in the
workspace carries `hidden`, so the explainer is the panel's entire
visible content -- the visitor reads "How it works" directly beneath the
Connect action, and the panel never renders as an empty glass box (which
deleting the fine print without a replacement would cause, since `.panel`
chrome -- tint, border, padding, shadow -- renders unconditionally).
After connecting, the playlist list leads and the explainer settles
beneath it as reference. No third panel is added; the page keeps its two.
The block is plain HTML: one small heading ("How it works") and four
short statements -- rendered as a tight list -- in the page's existing
voice. No script touches it, so the purity rule, the app harness, and the
CSP posture (no inline style or script) are all untouched.

**Reference copy** (final wording may be tuned at implementation, keeping
one pinned marker phrase per block intact):

1. Shuffling a playlist creates a private copy named after it: shuffle
   "Road Trip" and you get "Road Trip TrueShuffle". The first shuffle
   creates that copy; every shuffle after rewrites the same copy, so
   playlists never pile up. Your original playlist is never modified.
2. Play the copy with Spotify's shuffle turned off: the random order is
   the playlist itself, and Spotify's own shuffle would reshuffle it.
3. TrueShuffle is deliberately gentle with Spotify, so the first shuffle
   of a large playlist takes a few minutes. Repeat shuffles of an
   unchanged playlist take seconds.
4. Changes made in Spotify after this page loads appear after a reload.

**Visibility follows the action it explains.** The disconnect note copies
the connect note's proven pattern -- a `.fineprint` sibling of the button,
shown and hidden purely by stylesheet rule (`#logout[hidden] ~
.disconnect-note`), so no script manages it and it can never contradict
the visible controls.

**Tone and type.** Simple, clean, professional: the existing dark-glass
panel, the existing muted color token, no icons, no new colors or assets.
The explainer body sits between `.fineprint` (0.72rem) and body copy --
around 0.8rem with generous line height -- because this is content meant
to be read once by everyone, not legalese. The retired workspace
fine-print element is deleted, not hidden.

## Affected Components

- `web/index.html`: the explainer block inside the workspace panel, the
  disconnect note, removal of the workspace fine-print line.
- `web/styles.css`: explainer typography and spacing; the disconnect-note
  visibility rule.
- `main_test.go`: updated served-page markers pinning the new copy.
- `doc/architecture/browser/APPLICATION_MODEL.md`: the fixed-document
  paragraph names the explainer and the second gated note.
- `README.md`: brief mention of the on-page explainer and the
  shuffle-off guidance.

## Implementation Sequence

Single-step change: markup, styles, markers, and the two document touches
in one commit; validate, push, and deploy per the standing directive
through the private runbook.

## Validation

```sh
gofmt -l main_test.go
go test ./...
git diff --check
```

No JavaScript changes, so the Node suites are not required; `go test`
re-proves the served page (markers, no inline style or script, script
order). Visual confirmation: run the server locally
(`SPOTIFY_CLIENT_ID=dummy TELEMETRY_DB_PATH=/tmp/ts.sqlite go run .`),
load the page disconnected and connected, and confirm the explainer reads
cleanly in the theme, the connect note appears only when Connect does,
and the disconnect note only when Disconnect does.

## Success Criteria

- Before connecting, a visitor can read on the page that shuffling a
  playlist creates a private copy named after it which every later
  shuffle rewrites in place, that originals are never modified, that the
  copy must be played with Spotify's shuffle off, that a large first
  shuffle takes minutes while unchanged repeats take seconds, and that
  Spotify-side changes need a reload.
- The workspace panel is never an empty glass box: disconnected, its
  visible content is exactly the explainer.
- The disconnect note is visible exactly when the Disconnect button is,
  with no script involvement.
- The retired fine print is gone; the connect note is unchanged; the
  served-page test pins one phrase from each new block; `go test ./...`
  passes; the page still contains no inline style or script.

## Execution Notes

Executed 2026-08-10. Implementation commit `7c43f47`.

Implemented as planned: the `class="explainer"` section closes the
workspace panel where the retired fine-print line stood -- an uppercase
muted "How it works" heading and the four statements as a tight list,
0.8rem muted body against the 0.72rem fine print; the disconnect note
joins the connection panel's actions under the mirrored
`#logout[hidden] ~ .disconnect-note` rule; the served-page test pins
`never pile up`, `shuffle turned off`, and `forgets this browser` in
place of the retired `Originals are never`; the application model's
fixed-document paragraph now names three explanatory blocks; the README
status paragraph states the explainer and the shuffle-off guidance.

One bounded deviation: the explainer's top margin is conditional
(`.workspace > :not([hidden]) ~ .explainer`), so the disconnected panel
-- where the explainer is the only visible content -- carries no stray
top gap, while the connected panel keeps a clear seam between the list
and the copy. Same outcome, purely presentational, no new mechanism
beyond one selector.

Validation, all passing: `gofmt -l main_test.go` (no output),
`go test ./...`, `git diff --check`, and a local serve
(`SPOTIFY_CLIENT_ID=dummy ... go run .`) confirming the page delivers
the explainer and disconnect note, the stylesheet delivers their rules,
and `/healthz` answers ok. No JavaScript changed, so the Node suites
were not run, per the plan.
