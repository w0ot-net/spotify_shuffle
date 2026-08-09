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

## Execution Notes

Completed on 2026-08-09.

Implemented behavior:

- Created the root-owned public checkout at `/root/tools/spotify_shuffle` with
  origin `https://github.com/w0ot-net/spotify_shuffle.git` on `main`.
- Ran the repository tests and built the application on the deployment host.
- Installed a clean build of commit
  `0e5b5da721d6b3aa8dc3ebe759bc14314d1cafe2` with SHA-256
  `03762697af6922e9824fa0afb0c28ea0ea3d6e9bbe11978dc2a918f8cc2d4c9d`.
- Retained the existing host-local unit and restarted it against the newly
  installed binary.
- Verified that future updates can begin with `git pull --ff-only`; the checkout
  reported `Already up to date` before this completion record was committed.

Changed ownership boundaries:

- `/root/tools/spotify_shuffle` now owns the administrative source checkout and
  remote test/build workflow.
- `/opt/spotify_shuffle/spotify_shuffle` remains the runtime executable owned by
  root.
- `spotify-shuffle.service` continues to own the process lifecycle and dynamic
  runtime identity without any unit-file change.

Deviations and corrections:

- The original version of this plan was partially executed before the user
  requested a remote checkout workflow. That execution created the existing
  unit and installed a transferred binary. Commit `0e5b5da` revised the plan;
  the healthy unit was retained while the source and binary update workflow was
  migrated.
- The first atomic replacement attempt correctly rolled back because a
  validation expression searched for a literal `\\t` rather than the tab in
  `go version -m` output. The previous binary and active service were confirmed
  restored, the check was changed to compare metadata values, and the same
  atomic replacement then succeeded.

Validation:

- Remote `go test ./...`: passed.
- Checkout origin, `main` branch, clean status, and exact commit: verified.
- `file` and `go version -m`: verified a Linux x86-64 Go binary with clean VCS
  revision `0e5b5da721d6b3aa8dc3ebe759bc14314d1cafe2`.
- Temporary and installed SHA-256: matched
  `03762697af6922e9824fa0afb0c28ea0ea3d6e9bbe11978dc2a918f8cc2d4c9d`.
- Service: enabled, active, `DynamicUser=yes`, and zero automatic restarts.
- Listener: only `127.0.0.1:5107`.
- Root page and `/healthz`: both returned status `200` with their complete
  documented content contracts.
- Systemd unit SHA-256 remained
  `46aefb541745c84527be634a7c96beffbec8f2a6dfb1652ceb5e978d9132cdaa`.
- Apache HTTP and HTTPS vhost hashes remained
  `defb4da4dd0c52e18b575cf64751d9132f447a8cf4771cff40483eee7bf8f29a`
  and `8580ee6b0f185bcd6f2e62813d2a68937e935629837613068805b9b4cbb2ee58`.
- Service journal contained no warning-or-higher entries after the successful
  deployment.
- No generated, staged, or rollback binary remained after validation.

Repository commits:

- `0e5b5da` (`Revise deployment for remote checkout`) is the plan revision and
  deployed source commit. Host deployment state has no separate implementation
  commit because the application code and private unit were unchanged.

Unresolved blockers and excluded follow-up:

- None. Apache proxying and public application routing remain deliberately
  outside this completed plan.
