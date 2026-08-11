# Plan: Repository Truth and Hygiene

## Summary

Make the repository entry points concise and accurate for the post-ownership
implementation, and keep routine generated output out of status. Add one
proportional-planning guardrail for future agent work without rewriting
historical records or introducing new tooling.

## Problem

The README calls the implemented application "planned," advertises Go 1.22
although the module and current SQLite dependency require Go 1.25, and gives a
stale rationale for `playlist-modify-public`. Its current-status section is a
dense implementation narrative rather than a scannable user entry point. The
root build artifact is not ignored and already appears as an untracked 15 MB
file. The repository also has far more completed-plan prose than current
architecture, but deleting historical evidence would create churn rather than
improve current authority.

## Scope

In scope:

- Describe TrueShuffle as an early-stage application with current behavior,
  reserving planned language for unimplemented work.
- Reorganize the README's status into concise current behavior and practical
  limits while preserving run, privacy, authorization, and test instructions.
- Align the supported Go version with `go.mod` and the dependency graph.
- Align the public modification scope explanation with the current
  architecture and safe managed-target behavior.
- Ignore only the root `/trueshuffle` build artifact.
- Bring the live rate-limit note up to date without rewriting its historical
  observation.
- Add an `AGENTS.md` rule that planning depth should be proportional to risk
  and scope and that completed plans are not rewritten merely for brevity.

Out of scope:

- Downgrading Go or SQLite dependencies to restore Go 1.22 support.
- Deleting, condensing, or reformatting completed plans.
- Rewriting stable architecture pages that remain accurate after the managed
  target plan.
- Removing product features, telemetry, visual assets, or the active playlist
  filter plan.
- Adding a formatter, documentation generator, or package manager.

## Design

Execute this plan after the safe-managed-target plan so the README is edited
once against the final ownership contract. Keep `README.md` user-oriented:
lead with what works now, use short paragraphs or bullets for the shuffle and
cache behavior, and move implementation detail behind existing architecture
links. Preserve important limitations such as paced cold reads, Liked Songs
lockouts, browser-held tokens, derived-copy playback, and local disconnect
semantics.

Set both Go requirement statements to 1.25 or later; do not imply that source
syntax alone determines the supported version. Explain that
`playlist-modify-public` keeps an explicitly managed target writable if its
visibility becomes public, matching the authorization and integration models.

Add `/trueshuffle` to `.gitignore`, leaving similarly named files in nested
directories unaffected. Do not delete a developer's existing untracked binary
as part of the repository change.

Update `doc/notes.md` so the 1,000 ms governor is clearly historical and the
current 250 ms policy is acknowledged while retaining any genuinely pending
live experiment. Add only a short proportionality rule to `AGENTS.md`; the
existing focus, validation, and documentation rules remain authoritative.

## Affected Components

- `README.md`: correct current/planned wording, runtime requirements, scope
  rationale, and status readability.
- `.gitignore`: ignore the root build artifact.
- `doc/notes.md`: distinguish the initial governor from the current policy.
- `AGENTS.md`: add the proportional-planning and historical-record guardrail.

## Implementation Sequence

1. Reconcile the README against `go.mod`, the post-ownership behavior, and the
   current architecture pages, then shorten duplicated implementation detail.
2. Update the live note and contributor guardrail.
3. Add the exact root artifact ignore rule and verify its scope.

## Validation

```sh
git diff --check
git check-ignore -v trueshuffle
test -z "$(git check-ignore nested/trueshuffle 2>/dev/null)"
! rg -n 'Go 1\.22|upcoming in-place|A planned mobile-friendly' README.md doc/notes.md
rg -n 'Go 1\.25|playlist-modify-public|early-stage' README.md
```

Review README links and commands directly. Code and behavior are unchanged, so
aggregate Go and browser suites are not required by this documentation-only
plan.

## Success Criteria

- A new reader can distinguish current behavior, limitations, and future work
  without consulting implementation history.
- The documented Go floor and scope rationale match the repository's current
  executable contract.
- The root build binary no longer dirties `git status`, without a broad ignore
  pattern.
- Historical completed plans remain untouched, and future planning guidance
  explicitly favors proportional scope.
