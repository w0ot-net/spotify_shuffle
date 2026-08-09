# Plan: Remote Checkout Service Deployment

## Summary

Establish a remote Git checkout as the source for the existing private Spotify
Shuffle service. Clone the public repository into `/root/tools/spotify_shuffle`,
test and build the exact checked-out commit on the host, atomically replace the
installed binary, and verify the unchanged service on `127.0.0.1:5107`.

## Problem

The first deployment installed and validated a locally built binary, and the
service is currently enabled, active, and healthy. The host does not yet have a
repository checkout, so future updates would require transferring binaries
instead of using the requested `git pull --ff-only` workflow.

## Scope

In scope:

- Clone `https://github.com/w0ot-net/spotify_shuffle.git` into the currently
  absent `/root/tools/spotify_shuffle` path.
- Verify the checkout's origin, clean state, branch, and exact source commit.
- Run the repository tests and build a temporary Linux x86-64 binary on the
  deployment host.
- Verify the binary's embedded Git revision and record its checksum.
- Atomically replace `/opt/spotify_shuffle/spotify_shuffle`, retaining the old
  binary only long enough to support rollback.
- Restart the existing `spotify-shuffle.service` without changing its unit.
- Validate the service identity, restart state, loopback listener, logs, home
  page, and health response.
- Record the deployed source commit and binary checksum in the completed plan.

Out of scope:

- Repository application, test, README, build-script, or deployment-file
  changes beyond revising and finalizing this plan record.
- Committing binaries, systemd configuration, or host credentials to Git.
- Changing the installed systemd unit, port, dynamic-user model, or boot state.
- Apache proxy changes, public application routing, DNS, certificates, or
  firewall changes.
- Spotify configuration, secrets, OAuth, API access, or persistent state.
- Automated deployment scripts, hooks, scheduled pulls, or monitoring.

## Design

Keep the root-owned checkout as administrative deployment state, not as the
runtime path. The dynamic service user cannot and should not traverse `/root`;
the existing unit continues to execute the root-owned binary under
`/opt/spotify_shuffle`. Future manual updates can use `git pull --ff-only`,
tests, a temporary build, atomic installation, and service restart.

Clone only the public repository. Do not transfer the ignored local `.env` or
`cookie.txt`, and do not create credentials in the remote checkout. Build into
an OS temporary directory so generated binaries never enter the checkout.
`go version -m` must report the checkout's clean Git revision, and the installed
binary checksum must match the verified temporary build.

Preserve the currently running binary during the build and tests. Stage the new
binary beside the installed target, stop the service only for the final rename,
and retain the old binary under one explicit backup name until the new service
passes activation and HTTP checks. On failure, stop the unit, restore the old
binary, start it again, and leave the checkout available for diagnosis. Remove
the backup after successful validation.

## Affected Components

- `/root/tools/spotify_shuffle` on the deployment host: root-owned public Git
  checkout used for manual pull, test, and build operations.
- `/opt/spotify_shuffle/spotify_shuffle` on the deployment host: atomically
  replaced installed executable.
- `spotify-shuffle.service` runtime state: restarted and validated without
  changing `/etc/systemd/system/spotify-shuffle.service`.

No repository implementation component changes during execution.

## Implementation Sequence

1. Recheck that the service is healthy, the checkout target is absent, and the
   repository URL is publicly cloneable.
2. Record the existing binary checksum plus the systemd unit and Apache vhost
   hashes.
3. Clone the repository, verify its origin and clean default branch, and record
   the checked-out commit.
4. Run `go test ./...`, build into an OS temporary directory, and verify the
   binary revision, file type, and checksum.
5. Stage the new binary under `/opt/spotify_shuffle`, stop the service, exchange
   the installed and staged binaries with an explicit rollback backup, then
   start the service.
6. Validate the unit, listener, logs, `/`, and `/healthz`; remove the old binary
   only after every check succeeds.
7. Confirm the systemd unit and Apache vhost hashes remain unchanged.

## Validation

- Verify the remote checkout is on `main`, has origin
  `https://github.com/w0ot-net/spotify_shuffle.git`, and has no local changes.
- Record the deployed commit with `git rev-parse HEAD`.
- Run `go test ./...` in the remote checkout.
- Inspect the build with `file` and `go version -m`; require the recorded clean
  Git revision.
- Compare the temporary and installed SHA-256 checksums.
- Confirm `systemctl is-enabled spotify-shuffle.service` is `enabled` and
  `systemctl is-active spotify-shuffle.service` is `active`.
- Confirm `DynamicUser=yes`, the restart count is stable, and `ss` shows only
  `127.0.0.1:5107` for the application listener.
- Verify the root response's status, HTML content type, viewport, heading, and
  not-configured status markers.
- Verify `/healthz` returns status `200`, plain-text content type, and `ok\n`.
- Inspect the service journal for activation or repeated-restart errors.
- Compare the systemd unit and Apache vhost hashes captured before deployment.
- Confirm no rollback binary or generated build remains after success.

## Success Criteria

- `/root/tools/spotify_shuffle` is a clean root-owned clone of the expected
  public repository and can support future `git pull --ff-only` updates.
- The installed binary records the checkout's exact commit and matches its
  verified build checksum.
- The existing unit remains enabled, active, unchanged, and free of restart
  loops under its dynamic identity.
- The application listens only on `127.0.0.1:5107`, and both HTTP contracts
  pass against the installed service.
- No credentials or ignored local files are present in the remote checkout.
- No temporary or rollback binary remains after success.
- Apache, DNS, certificates, public routing, and repository implementation code
  remain unchanged.
