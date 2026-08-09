# Plan: Self-Contained Production Layout

## Summary

Consolidate TrueShuffle's production-owned checkout, executable releases, and
environment file under one root-owned `/opt/trueshuffle` tree. Keep only the
systemd unit and its enablement symlink in systemd's standard paths, while
leaving Apache and Let's Encrypt assets with the services that own them. Use a
commit-addressed release plus an atomic `current` symlink so the migration and
future deployments retain the existing rollback and provenance guarantees.

## Problem

The production application currently works, but its owned files are split
across `/root/tools/trueshuffle`, `/opt/trueshuffle`, and
`/etc/trueshuffle`. The systemd configuration is also divided between the main
unit and an OAuth environment drop-in. This is conventional filesystem layout,
but it makes a small, self-contained service harder to inspect, back up,
deploy, and remove as one unit.

The current checkout is clean at commit
`eebb98056056ec16840237025c547828970c2464`, and the installed binary records
that same unmodified Git revision. The service is enabled and active as
`trueshuffle.service`, runs under a systemd dynamic user, listens on
`127.0.0.1:5107`, and exposes the health check needed for a bounded migration.

## Scope

In scope:

- Establish this application-owned layout:

  ```text
  /opt/trueshuffle/
  |-- repo/
  |-- releases/
  |   `-- <full-git-revision>/
  |       `-- trueshuffle
  |-- current -> releases/<full-git-revision>/
  `-- config/
      `-- environment
  ```

- Preserve the root-owned clean Git checkout and its existing public origin.
- Preserve the installed binary exactly, including its Git revision and
  checksum, while moving it into the initial release directory.
- Preserve the environment file without printing or committing its value;
  keep its directory root-only and the file mode `0600`.
- Point `trueshuffle.service` at
  `/opt/trueshuffle/current/trueshuffle`, place the environment-file directive
  in the main unit, and remove the now-unnecessary drop-in.
- Retain the old executable, environment, checkout, and unit configuration
  until the renamed layout passes local and public health checks; restore them
  on failure.
- Remove the superseded application-owned paths after successful validation.
- Update the active OAuth hardening plan to use the consolidated deployment
  paths and workflow.

Out of scope:

- Application behavior, browser storage keys, OAuth scopes, or Spotify
  dashboard changes.
- Containers, package creation, deployment automation, release-retention
  policy, or a new deployment script.
- Apache virtual hosts, the `shuffle.p.a-9.co` hostname, TLS certificates,
  firewall rules, or journald storage.
- Moving or rewriting historical records under `doc/completed_plans/`.

## Design

`/opt/trueshuffle` becomes the sole owner of TrueShuffle-specific production
state. The top-level tree remains root-owned and traversable for the dynamic
service user. `config/` is mode `0700`, `config/environment` remains mode
`0600`, and repository and release content remain root-owned. No credential or
environment file enters `repo/`.

The initial release directory is named with the checkout's full Git revision.
The copied executable must retain the current installed checksum, and
`go version -m` must report the same revision with `vcs.modified=false`.
`current` is a relative symlink to that release directory. Future deployments
can build a verified commit into another release directory and atomically
replace `current`; no manifest or separately maintained deployed-version file
is introduced.

The deployed revision is defined by the release-directory name and the
binary's embedded `vcs.revision`, which must agree exactly. The clean production
checkout may be ahead of that revision after documentation-only commits; in
that case the deployed revision must remain an ancestor of the checkout. This
keeps documentation synchronization independent from executable identity and
does not require no-op rebuilds.

The main systemd unit remains at
`/etc/systemd/system/trueshuffle.service`, because systemd owns unit discovery
and boot enablement. It directly declares both
`EnvironmentFile=/opt/trueshuffle/config/environment` and
`ExecStart=/opt/trueshuffle/current/trueshuffle`. The separate
`trueshuffle.service.d/oauth.conf` is deleted after its directive is merged.
The enablement symlink under `multi-user.target.wants` remains systemd-owned.

Migration is fail-closed and bounded. Stage the new tree and a revised unit
while the existing service remains active. Preserve exact rollback copies of
the original unit and drop-in in an OS temporary directory, stop the service
only for the unit switch, and use a short bounded readiness loop. Any failure
before final cleanup restores the original unit paths and restarts the old
binary. Delete the split paths and disposable rollback material only after the
new layout passes service, loopback HTTP, and public HTTPS checks.

Apache configurations and Let's Encrypt material remain in their current
service-owned locations. They are integration dependencies, not TrueShuffle
application state, and the migration must not alter them.

## Affected Components

- Production `/opt/trueshuffle/*`: replace the top-level binary with the
  consolidated `repo/`, `releases/`, `current`, and `config/` layout.
- Production `/etc/systemd/system/trueshuffle.service`: point at the
  consolidated executable and environment file.
- Production `/etc/systemd/system/trueshuffle.service.d/oauth.conf`: merge its
  one directive into the main unit and remove the drop-in.
- Production `/root/tools/trueshuffle` and `/etc/trueshuffle`: migrate their
  contents into `/opt/trueshuffle` and remove the empty superseded paths after
  validation.
- `doc/plans/20260809-oauth-client-hardening.md`: update the planned deployment
  step and affected production component to the final self-contained layout.

No Go, browser asset, test, README, Apache, TLS, or Spotify configuration file
changes are expected.

## Implementation Sequence

1. Reconfirm the service is enabled, active, healthy, and listening only on
   `127.0.0.1:5107`; record the checkout revision, clean status, origin,
   executable metadata and checksum, environment checksum and permissions,
   unit/drop-in contents, restart count, and Apache virtual-host hashes.
2. Create the root-owned `releases/<full-revision>` and `config` directories
   beneath `/opt/trueshuffle`. Copy the installed executable and environment
   file to their final locations, then verify hashes, executable provenance,
   ownership, and permissions before changing the service.
3. Create a relative `current` symlink targeting the verified initial release.
   Stage a revised main unit that uses the consolidated paths and contains the
   environment-file directive formerly owned by the drop-in. Validate the unit
   before activation.
4. Preserve the current unit and drop-in in an OS temporary directory. Stop
   `trueshuffle.service`, install the revised unit, remove the drop-in, reload
   systemd, start the service, and wait for readiness with bounded retries.
   Restore the original unit, drop-in, and service on any failure.
5. Verify the new unit, dynamic-user identity, listener, loopback routes,
   public HTTPS routes, restart count, and journal before removing any old
   application-owned path.
6. Move the clean checkout to `/opt/trueshuffle/repo`, verify it again in its
   final location, remove the superseded top-level executable,
   `/etc/trueshuffle`, `/root/tools/trueshuffle`, and the obsolete systemd
   drop-in directory, then reload systemd and repeat the health checks.
7. Update the active OAuth hardening plan with the final checkout, release,
   environment, and unit paths. Commit and push only the plan-document changes;
   then fast-forward `/opt/trueshuffle/repo` so the production checkout remains
   clean and synchronized without rebuilding the already verified binary. The
   commit-addressed release, not the newer documentation-only checkout HEAD,
   remains the deployed revision.
8. Remove disposable migration and rollback material after all filesystem,
   service, Git, and HTTP checks pass.

## Validation

- Verify checkout identity and cleanliness with `git status --short --branch`,
  `git remote -v`, and `git rev-parse HEAD` under
  `/opt/trueshuffle/repo`.
- Run `go test ./...` from the relocated checkout to prove the repository still
  works in its final location.
- Compare the pre-migration executable checksum with
  `/opt/trueshuffle/releases/<revision>/trueshuffle` and inspect it with
  `file` and `go version -m`; require the release-directory name to equal the
  embedded revision, require `vcs.modified=false`, and require that revision to
  be an ancestor of the clean production checkout.
- Resolve `/opt/trueshuffle/current` and require it to target exactly the
  verified release directory within `/opt/trueshuffle/releases`.
- Inspect ownership and modes for the top-level tree, repository, release,
  executable, config directory, and environment file. Confirm no environment,
  token, cookie, or generated binary exists inside the Git checkout.
- Run `systemd-analyze verify` on the installed unit. Confirm
  `trueshuffle.service` is enabled and active, has no drop-ins, uses the exact
  consolidated `ExecStart` and `EnvironmentFile`, retains `DynamicUser=yes`,
  and has no automatic restart loop.
- Confirm `ss` reports the application listener only on `127.0.0.1:5107`.
  Check `/`, `/api/config`, and `/healthz` through loopback without printing the
  client ID, then check `/` and `/healthz` through
  `https://shuffle.p.a-9.co`.
- Run `apache2ctl configtest` and compare the Apache virtual-host hashes with
  the pre-migration values to prove proxy and TLS configuration were untouched.
- Inspect the service journal since activation for warning-or-higher entries.
- Confirm `/root/tools/trueshuffle`, `/etc/trueshuffle`, the old top-level
  executable, the systemd drop-in, and all temporary or rollback artifacts no
  longer exist after success.
- Run `git diff --check` for the documentation updates and confirm local and
  production checkouts are clean and synchronized with `origin/main`.

No live Spotify authorization, external-account mutation, or playlist access
is required for this filesystem-only migration.

## Success Criteria

- All TrueShuffle-owned production checkout, executable, release pointer, and
  environment state exists beneath `/opt/trueshuffle` in the documented tree.
- The only TrueShuffle-specific filesystem objects outside that tree are the
  systemd unit and its systemd-owned enablement symlink; Apache, certificate,
  and journal assets remain with their owning services.
- `trueshuffle.service` is enabled, active, stable, and uses the consolidated
  executable and environment paths under its existing dynamic-user model.
- The deployed binary's embedded Git revision matches its release-directory
  name, is an ancestor of the verified clean checkout, and `current` resolves
  only within the releases tree.
- Loopback and public health checks pass without changing the hostname,
  callback, Apache, TLS, OAuth, or application behavior.
- The former split paths and systemd drop-in are absent, with no compatibility
  symlinks or duplicate configuration left behind.
- The active deployment documentation names the final layout, and both Git
  checkouts are clean and synchronized after the documentation commit.
