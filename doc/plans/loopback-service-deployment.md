# Plan: Loopback Service Deployment

## Summary

Deploy the existing committed Go application as a private host service bound
only to `127.0.0.1:5107`. Build one Linux x86-64 binary from the clean
repository, install it and a host-local systemd unit outside the repository,
then prove both HTTP routes directly over loopback before involving Apache.

## Problem

The application builds and runs locally, but the deployment host has no
installed binary or service. Apache therefore has no upstream application to
proxy to, and the dedicated HTTPS hostname still serves an empty document root.
The next independent step is to establish and validate only that private
upstream process.

## Scope

In scope:

- Revalidate the current repository before building.
- Build a temporary Linux x86-64 executable from the exact clean commit being
  deployed.
- Install the binary at `/opt/spotify_shuffle/spotify_shuffle` with root-owned,
  executable permissions.
- Install a private host-only `spotify-shuffle.service` unit that runs with a
  dynamic unprivileged identity.
- Set `LISTEN_ADDR=127.0.0.1:5107` in that host-local unit.
- Enable and start the unit, then validate its process, listener, logs, home
  page, and health response over loopback.
- Record the deployed source commit and binary checksum in the completed plan's
  execution notes.

Out of scope:

- Repository application, test, README, build-script, or deployment-file
  changes.
- Committing the binary or systemd unit to Git.
- Apache proxy changes, public application routing, DNS, certificates, or
  firewall changes.
- Spotify configuration, secrets, OAuth, API access, or persistent state.
- Release automation, remote build tooling, rolling deployment, extensive
  systemd hardening, or monitoring.

## Design

Use the existing `LISTEN_ADDR` contract rather than changing the application's
default or adding deployment-specific code. Build locally because both the
workspace and deployment host are Linux x86-64; transfer through a uniquely
named temporary file, compare SHA-256 checksums, and atomically install it into
the otherwise-unused `/opt/spotify_shuffle` directory. Do not copy `.env`,
`cookie.txt`, source files, or the repository checkout to the host.

Keep the service unit on the host under `/etc/systemd/system/`. Its only
application configuration is `LISTEN_ADDR=127.0.0.1:5107`; it runs the installed
binary directly, uses `DynamicUser=yes` to avoid a persistent account, and uses
`Restart=on-failure`. Validate the staged unit before installation. Enabling the
unit makes this private upstream survive reboots, but does not expose it because
the process binds only to loopback and Apache remains unchanged.

Preflight execution must recheck that the port, target directory, and unit name
remain unused. If any appeared after this plan was written, stop rather than
overwrite unknown host state. If first activation fails, stop and disable the
new unit, remove only the newly installed unit and binary, reload systemd, and
leave Apache untouched.

## Affected Components

- `/opt/spotify_shuffle/spotify_shuffle` on the deployment host: installed
  application executable; this path is outside Git.
- `/etc/systemd/system/spotify-shuffle.service` on the deployment host: private
  process ownership, loopback address, restart behavior, and boot activation;
  this file is not added to the repository.
- systemd manager state on the deployment host: daemon reload plus enabled and
  active state for the new unit.

No repository implementation component changes during execution.

## Implementation Sequence

1. Recheck the clean repository, run its existing tests, and record the source
   commit selected for deployment.
2. Recheck the remote port, install path, and unit name for conflicts.
3. Build the executable into an OS temporary directory and record its checksum
   and file type.
4. Stage the binary and unit under unique remote temporary names, verify the
   checksum and unit syntax, then install both to their final host-only paths.
5. Reload systemd, enable and start `spotify-shuffle.service`.
6. Validate the unit, loopback-only listener, logs, `/`, and `/healthz` without
   changing Apache.

## Validation

- Run `go test ./...` before building.
- Run `git status --short --branch` and record the deployed commit with
  `git rev-parse HEAD`.
- Inspect the local build with `file` and `go version -m`, then compare local
  and remote SHA-256 checksums before installation.
- Run `systemd-analyze verify` against the staged unit.
- Confirm `systemctl is-enabled spotify-shuffle.service` reports `enabled` and
  `systemctl is-active spotify-shuffle.service` reports `active`.
- Confirm `ss` shows only `127.0.0.1:5107` for the application listener.
- Request `http://127.0.0.1:5107/` and verify the embedded page status, content
  type, viewport, heading, and not-configured status markers.
- Request `http://127.0.0.1:5107/healthz` and verify status `200`, plain-text
  content type, and body `ok\n`.
- Inspect the new unit's journal for startup or repeated-restart errors.
- Confirm the Apache configuration and public hostname were not changed by this
  execution.

## Success Criteria

- The exact recorded repository commit is represented by the installed binary.
- `spotify-shuffle.service` is enabled, active, and runs without restart loops
  under a dynamic unprivileged identity.
- The application listens only on `127.0.0.1:5107`.
- Both existing HTTP contracts pass directly against the installed service.
- No credentials or repository checkout are copied to the host.
- Apache, DNS, certificates, public routing, and repository implementation files
  remain unchanged.
