# Plan: Stable Service User and App Data Directory

## Summary

Keep systemd only as TrueShuffle's process supervisor, but replace its dynamic
runtime identity with a stable, non-login `trueshuffle` service account. Give
that account one writable directory, `/opt/trueshuffle/data`, while preserving
the existing root-owned checkout, releases, configuration, listener, proxy,
and release workflow. This creates the smallest durable-state foundation for
later SQLite work without adding a container or another supervisor.

## Problem

The current service is intentionally stateless and runs with
`DynamicUser=yes`. That is a good match today, but a dynamic identity makes a
persistent database under TrueShuffle's existing `/opt/trueshuffle` tree
awkward to own safely. Moving lifecycle management away from systemd would
replace one small unit with a larger process-management problem.

TrueShuffle therefore needs a stable least-privilege identity and one explicit
writable corner, without changing application behavior or scattering its
future data into a systemd-managed state tree.

## Scope

In scope:

- Create a system-owned `trueshuffle` user and group with no interactive
  login, password, or home directory; do not pin a numeric UID or GID.
- Add `/opt/trueshuffle/data`, owned by that account and mode `0700`.
- Change `trueshuffle.service` from `DynamicUser=yes` to the named user and
  group, and explicitly allow writes only beneath the data directory while
  preserving its other directives.
- Preserve the current binary, release pointer, protected environment file,
  listener, proxy, health checks, boot enablement, and journald logging.
- Perform the live identity switch with a saved unit, bounded validation, and
  exact unit rollback on failure.
- Update the authoritative deployment model and the private operations
  runbook after the migration is proven.

Out of scope:

- Creating a SQLite database, choosing its schema or driver, adding telemetry,
  or changing rate-limit behavior.
- Removing systemd, adding containers, or introducing another supervisor.
- Adding deployment scripts or checking a service-unit template into the
  repository.
- Changing Go or browser code, configuration values, Apache, TLS, DNS,
  firewall rules, or log storage.
- Rewriting historical completed plans that accurately describe the old
  dynamic-user state.

## Design

Systemd remains responsible only for starting, stopping, restarting, and
logging the process. The named service account supplies stable filesystem
ownership; it is not an interactive account and owns no checkout, release, or
configuration content.

The production ownership boundary becomes:

```text
/opt/trueshuffle/                root:root, not writable by the service
|-- repo/                        root-owned
|-- releases/                    root-owned
|-- current -> releases/...      root-owned release pointer
|-- config/                      root-only; unchanged
`-- data/                        trueshuffle:trueshuffle, mode 0700
```

The unit names `User=trueshuffle` and `Group=trueshuffle`, no longer enables
`DynamicUser`, and declares `/opt/trueshuffle/data` as its writable path. The
existing root-owned executable remains readable and executable, while ordinary
Unix permissions and the unit's filesystem restrictions keep the checkout,
releases, and configuration unwritable. The current Go binary still writes
nothing, so the new directory starts empty.

The migration changes no release identity. The active `current` target,
binary checksum and embedded revision, environment-file checksum and mode,
listener, and HTTP behavior must remain unchanged. If activation fails, restore
the saved unit and restart the dynamic-user service; remove the newly created
account and directory only when they were created by this migration and the
directory is still empty.

The public deployment model records the stable ownership contract only after
the host matches it. The private runbook owns the actual service-change and
future deployment checks; no access details or captured host output enter the
repository.

## Affected Components

- Production service identity: add the non-login `trueshuffle` user and group.
- Production `/opt/trueshuffle/data`: establish the sole service-writable
  application-state directory.
- Production `/etc/systemd/system/trueshuffle.service`: replace the dynamic
  identity with the named account and data-directory write allowance.
- `doc/architecture/deployment/DEPLOYMENT_MODEL.md`: revise the production
  tree, ownership rules, and service identity.
- Private `/root/ops/trueshuffle/RUNBOOK.md`: revise current-state inspection,
  deployment validation, and ownership checks without mirroring it into Git.

No application source, tests, README content, or historical plan changes are
expected.

## Implementation Sequence

1. With separate explicit authorization for the live operation, follow the
   private runbook to confirm the checkout, release, unit, listener, and health
   checks are clean and stable. Record the active unit and release facts needed
   for rollback without copying private output into the repository.
2. Refuse to proceed if a `trueshuffle` account or data path already exists
   with conflicting ownership or purpose. Otherwise create the non-login
   system user/group and the empty mode-`0700` data directory, leaving every
   existing path untouched.
3. Save the installed unit in an OS temporary directory. Stage the minimal
   identity change plus the data-directory write allowance, and validate the
   staged unit before installation.
4. Install the unit, reload systemd, restart the service, and use a bounded
   readiness loop. On failure, restore the saved unit, reload, restart, and
   verify the old service before removing only newly created empty state.
5. Confirm the service runs as the named account, can write the data directory
   but not the checkout, releases, or configuration, and retains its prior
   release identity, listener, health behavior, and stable restart count.
6. After the host migration succeeds, update the deployment model and private
   runbook to describe the verified state. Commit and push only the public
   architecture change; keep the private runbook and all operational evidence
   outside Git.

## Validation

- Confirm the named user and group are system identities with a non-login
  shell, no password, and no usable home directory; do not require particular
  numeric IDs.
- Inspect the installed unit with systemd's verifier and effective-property
  view: `User` and `Group` are `trueshuffle`, dynamic users are disabled, and
  the executable, environment file, restart policy, and listener configuration
  are otherwise unchanged.
- Verify `/opt/trueshuffle/data` resolves inside the application tree, is owned
  by the named account, and is mode `0700`. As that account, verify it is
  writable and that `repo/`, `releases/`, `current`, and `config/` are not.
- Confirm the active release target, binary checksum, embedded revision,
  environment checksum and permissions, and checkout cleanliness are unchanged.
- Confirm the service is enabled and active with no restart loop, the listener
  remains loopback-only, and both loopback and public health checks pass.
- Inspect only bounded post-activation journal output and retain no raw output
  in the repository.
- Run `git diff --check` and the architecture Markdown link-integrity check for
  the documentation change. No Go or browser suite is needed because no
  application file changes.

## Success Criteria

- The service runs reliably as the stable, non-login `trueshuffle` account and
  no longer uses systemd dynamic users.
- `/opt/trueshuffle/data` is the account's only writable application path; all
  code, releases, configuration, and release pointers remain root-controlled.
- Application behavior, release identity, protected configuration, listener,
  proxying, boot startup, health checks, and logging are unchanged.
- The production architecture page and private runbook accurately describe the
  verified ownership model without exposing private operations context.
- SQLite telemetry and rate-limit work remain independently executable follow-up
  plans rather than hidden additions to this migration.
