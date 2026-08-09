# Agent Guidance

This repository is `spotify_shuffle`, a mobile-friendly web utility for
reshuffling large Spotify playlists efficiently. The project is in its initial
implementation phase; do not describe planned behavior as already shipped.

Architecture guidance:

- Keep the browser a lightweight control surface. It may cache non-sensitive
  playlist data, but Spotify and the backend remain authoritative.
- Prefer a small Go backend and a simple web frontend. Add frameworks,
  services, queues, or databases only when the demonstrated need outweighs
  their operational cost.
- The backend owns Spotify OAuth, token refresh, playlist reads and writes,
  rate-limit handling, and any long-running shuffle job.
- Never store Spotify access tokens or refresh tokens in `localStorage` or
  IndexedDB. Prefer secure, HTTP-only cookies for browser sessions and keep
  provider tokens server-side.
- Treat IndexedDB as an optional performance cache. Mobile browsers may evict
  it at any time, so a missing or stale cache must cause a safe Spotify resync,
  not data loss or a broken account.
- Preserve playlist occurrences and ordering. A playlist may contain duplicate
  URIs; do not model membership as a set or key records only by track URI.
- Optimize a full random shuffle as a local Fisher-Yates permutation followed
  by the fewest safe bulk playlist writes. Do not move thousands of items one
  at a time unless a verified API constraint requires it.
- Keep Spotify-specific code behind a narrow boundary so API changes, fixtures,
  and retry behavior do not leak throughout the application.

Behavior and compatibility:

- The initial product is a personal-use utility that works well from iPhone
  Safari and modern desktop browsers. Do not expand it into a public multi-user
  service without explicit direction.
- Spotify is the source of truth for playlist membership. Cached state may
  accelerate a shuffle but must never silently override an ambiguous remote
  change.
- A changed `snapshot_id` indicates that the remote playlist changed; it does
  not describe how it changed. A count increase alone does not prove that an
  item was appended. Use a verified delta path or fall back to a URI-only full
  resync.
- Preserve duplicates, episodes, and other supported playlist item types. Make
  unsupported local files or unavailable items visible to the user instead of
  silently dropping them.
- A shuffle must either finish with the intended complete ordering or report a
  clear partial-failure state. Never claim success based only on the local
  permutation.
- Surface useful progress for large playlists and Spotify `429` delays. A
  transient browser disconnect must not make an active server-side mutation
  look like a new safe-to-run job.
- Behavior that can remove, replace, or duplicate playlist items requires
  explicit tests and a documented recovery strategy before release.

Spotify API and OAuth rules:

- Spotify API behavior, endpoint availability, scopes, quotas, and batch limits
  are changeable external facts. Verify them against current official Spotify
  documentation before implementing or changing API-dependent behavior.
- Request the minimum OAuth scopes needed for the selected operation.
- Use Authorization Code with PKCE where appropriate. Validate OAuth `state`,
  restrict redirect URIs, and never log authorization codes, provider tokens,
  cookies, client secrets, or full credential-bearing responses.
- Keep credentials in environment variables or an ignored local configuration
  file. Commit an example configuration containing placeholders only.
- Handle `429 Too Many Requests` using Spotify's current retry guidance,
  including `Retry-After` when supplied. Bound retries and make cancellation
  possible.
- Playlist writes are order-dependent. Apply them sequentially unless current
  Spotify guarantees and the algorithm prove that concurrency is safe.
- Use field filtering and pagination for playlist reads. Avoid fetching track
  titles, artwork, albums, and artist metadata when only item identifiers and
  occurrence order are needed.
- Chain and persist returned snapshot identifiers when Spotify exposes them.
  Do not rely on a pre-mutation snapshot after a successful write.
- Do not attempt to evade Spotify quota modes by rotating client IDs, accounts,
  or credentials.

Cache and shuffle invariants:

- Cache records must include the playlist ID, snapshot ID, ordered occurrences,
  item type/URI data needed to write them back, and a schema version.
- Cache migration and corruption handling must fail safe by discarding the
  cache and resyncing from Spotify.
- Validate the cached snapshot before using cached items unless the cache was
  updated from the complete response chain of the application's own mutation.
- Generate randomness with an appropriate system source. Tests may inject a
  deterministic source; production shuffles should not use a fixed seed.
- Avoid needless metadata retention. Persist only the data needed to validate,
  shuffle, recover, and present essential status.
- Keep a recoverable copy of the pre-shuffle order for any workflow that
  destructively replaces playlist contents. Define its lifetime and cleanup
  explicitly.

Documentation rules:

- `README.md` is the user-facing entry point and must distinguish implemented
  features from goals.
- Put durable architecture decisions in `doc/architecture/` as the design
  stabilizes. Keep temporary implementation plans in `doc/plans/`.
- Document required Spotify app settings, redirect URIs, environment variables,
  scopes, local development commands, deployment steps, and recovery behavior
  as each becomes real.
- When changing an external API assumption, update the relevant documentation,
  code, and tests together.
- Never put real account IDs, playlist contents, credentials, OAuth responses,
  or sensitive logs in documentation or fixtures.

Validation efficiency:

- Use the narrowest validation that covers the change, then run the repository's
  standard test suite before pushing when its runtime is reasonable.
- Add or update tests for behavior changes, especially pagination, duplicates,
  cache invalidation, partial writes, OAuth validation, and `429` handling.
- Mock Spotify responses in routine tests. Live-account integration tests must
  be explicit, opt-in, and operate only on a dedicated test playlist.
- Never run a destructive test against Liked Songs or an ordinary user
  playlist.
- Before validation expected to exceed 10 minutes or mutate Spotify remotely,
  tell the user what will run and what data it can affect.

Git workflow:

- Always commit and push after code or documentation changes.
- Never use `git add .` or `git add -A`.
- Stage explicit paths only.
- Commit only files touched for the task.
- Preserve unrelated user changes.
- Do not commit generated binaries, local caches, databases, `.env` files,
  credentials, tokens, or captured Spotify payloads.

Engineering preferences:

- Target a Go backend and standards-based HTML, CSS, and JavaScript frontend,
  with iPhone Safari as a first-class client.
- Keep code and scripts ASCII unless a file already uses another character set
  or the change clearly requires it.
- Minimize dependencies and complexity while preserving correctness, security,
  observability, performance, accessibility, and readability.
- Prefer explicit invariants, bounded retries, idempotency keys or job guards,
  and fail-fast validation over fallback-heavy behavior.
- Use structured logs with request/job correlation, but redact sensitive data
  at the boundary before it reaches a logger.
- Use context cancellation and timeouts for outbound HTTP calls. Do not leave
  shuffle jobs or OAuth requests waiting indefinitely.
- Make progress UI accessible and touch-friendly. Critical actions must not
  depend on hover, tiny targets, or a continuously foregrounded browser tab.

Local tooling:

- Once the Go module exists, format changed Go files with `gofmt` and use
  `go test ./...` as the default backend validation unless the repository
  defines a narrower command.
- Keep frontend tooling minimal. If a package manager is introduced, commit its
  lockfile and document the supported runtime version and commands.
- Prefer repository-owned scripts for repeatable development, generation, and
  validation tasks over undocumented shell history.

Artifact handling:

- Keep local tokens, caches, SQLite databases, browser profiles, trace files,
  response captures, and benchmark output out of Git.
- Store sanitized fixtures under a clear test-data directory. Use synthetic
  playlist IDs and item URIs; never copy a user's real library into the repo.
- Summarize performance results with playlist size, request counts, pacing,
  quota mode, failures, and methodology. Do not publish sensitive raw logs.
- Use OS temporary directories for disposable test output and document any
  retained artifact location needed to reproduce a result.
