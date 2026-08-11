# Agent Guidance

This repository is `trueshuffle`. It is an early-stage project; do not
describe planned behavior as implemented behavior.

Repository workflow:

- Read the nearest relevant documentation and code before making changes.
- Preserve established behavior unless the task explicitly requires changing
  it or there is a clear correctness, security, operational, or performance
  reason.
- Keep changes focused on the requested task. Do not redesign unrelated areas.
- When intentionally changing established behavior, document why and address
  compatibility or migration consequences.
- Preserve unrelated user changes in the worktree.

Private production operations:

- Before any TrueShuffle hosted-service, remote-server, deployment, rollback,
  production-configuration, or live diagnostic work, read the machine-local
  `/root/ops/trueshuffle/RUNBOOK.md` completely.
- Treat that runbook as private context. Never copy its access details into the
  repository, repository plans or documentation, issues, commit messages, or
  public examples.
- If the private runbook is absent or unreadable, stop and request the private
  operations context instead of guessing access or deployment details.
- A repository code or documentation task does not by itself authorize remote
  access or deployment; require explicit user direction for a live production
  operation.

Documentation rules:

- Keep `README.md` accurate as the user-facing entry point.
- `doc/architecture/` is the authority for stable system design; consult the
  relevant page before design work.
- Update affected documentation alongside code when commands, configuration,
  behavior, or architecture change.
- Distinguish clearly between current behavior, planned work, and historical
  notes.
- When rewriting an architecture document, add or update its revision date near
  the top.
- Do not put credentials, tokens, private account data, or sensitive logs in
  documentation or examples.
- Keep planning depth proportional to scope and risk. Do not create multi-phase
  plans for small local changes, and do not rewrite completed plans merely to
  make their historical record shorter.

Validation efficiency:

- Use the narrowest validation that covers the change.
- Do not run an aggregate, integration, or release suite unless the user asks
  for it or the change cannot be validated responsibly without it.
- Avoid validators that redundantly invoke one another.
- Before starting validation expected to exceed 10 minutes, tell the user what
  will run and the estimated duration.
- Do not use live external accounts or mutate remote data during validation
  without explicit user direction.

Git workflow:

- Always commit and push after code or documentation changes.
- Never use `git add .` or `git add -A`.
- Stage explicit paths only.
- Commit only files touched for the task.
- Preserve unrelated user changes.
- Do not commit generated binaries, caches, databases, `.env` files,
  credentials, tokens, or captured private data.

Engineering preferences:

- Keep code and scripts ASCII unless a file already uses another character set
  or the change clearly requires it.
- Minimize code, dependencies, and complexity while preserving correctness,
  security, performance, observability, and readability.
- Prefer explicit invariants and fail-fast behavior over fallback-heavy code.
- Use timeouts, bounded retries, and cancellation for external operations.
- Keep external-service details behind narrow interfaces where practical.
- Add comments for non-obvious constraints and decisions, not for behavior that
  is already clear from the code.

Local tooling:

- Prefer repository-owned scripts and pinned tooling for repeatable development,
  generation, and validation tasks.
- Use the formatter and targeted tests appropriate to the files changed.
- If a package manager is introduced, commit its lockfile and document the
  supported runtime version and common commands.
- Do not add large third-party tools or generated dependencies to the
  repository when they can be installed or cached externally.

Artifact handling:

- Keep raw logs, traces, browser profiles, benchmark output, response captures,
  and other generated artifacts out of Git unless they are intentional,
  sanitized fixtures.
- Use OS temporary directories for disposable invocation scratch.
- Store retained artifacts outside the repository and publish only concise,
  reproducible conclusions and relevant paths in the appropriate documentation.
- Never rewrite historical evidence solely to apply newer formatting or
  artifact conventions retroactively.
