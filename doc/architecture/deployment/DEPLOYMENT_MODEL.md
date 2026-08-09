# Deployment model

*Revised: 2026-08-09*

This page owns the production layout, release identity, and the boundary
between repository documentation and private operations. Return to the
[architecture index](../README.md).

Production state lives in one root-owned tree:

```text
/opt/trueshuffle/
|-- repo/                      clean production checkout of this repository
|-- releases/
|   `-- <full-git-revision>/
|       `-- trueshuffle        the deployed static binary
|-- current -> releases/<full-git-revision>/
`-- config/
    `-- environment            root-only (0600) service environment
```

## Release identity

The deployed revision is defined twice and the two must agree exactly: the
release-directory name and the binary's embedded `vcs.revision`, built from
a clean checkout (`vcs.modified=false`). That revision must be an ancestor
of `repo/` HEAD -- documentation-only commits may advance the checkout
without a rebuild. Deployment builds a verified commit into a new release
directory and atomically repoints `current`; rollback is repointing it back.

## Service

`/etc/systemd/system/trueshuffle.service` is the only TrueShuffle-specific
object outside the tree. It runs `current/trueshuffle` under
`DynamicUser=yes` with the environment file above, listening on
`127.0.0.1:5107`. Apache terminates TLS for `https://shuffle.p.a-9.co` and
reverse-proxies to that loopback listener; Apache, Let's Encrypt, and
journald assets belong to those services, not to TrueShuffle. `/healthz`
answers on both the loopback and the public origin.

## The private boundary

These pages describe the model; they never contain access details or live
procedure. Production operations -- deployment, rollback, configuration,
diagnostics -- follow the machine-local private runbook per
[`AGENTS.md`](../../../AGENTS.md), require explicit user direction, and are
never authorized by a repository task alone.
