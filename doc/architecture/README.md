# System architecture

*Revised: 2026-08-09*

This tree owns the stable responsibilities, boundaries, and invariants of
TrueShuffle as it exists at head. TrueShuffle is a browser-centric Spotify
utility: the browser owns authorization and every Spotify interaction, while
the Go service is a stateless shell that serves the embedded application and
its public configuration.

```text
        +-----------------------------------------------+
        | browser                                       |
        | owns tokens, PKCE, and all Spotify traffic    |
        +------+--------------------------+-------------+
               |                          |
     page, scripts,             authorize and tokens
     public client ID           -> accounts.spotify.com
               |                playlist reads
               v                -> api.spotify.com
        +-----------------------------------------------+
        | Go service: embedded assets, no storage,      |
        | never receives a Spotify token                |
        +-----------------------------------------------+
```

## Authority rules

- The root [`README.md`](../../README.md) owns user entry points and product
  goals: what the project is, how to run and test it, and current status.
- [`AGENTS.md`](../../AGENTS.md) owns contributor guardrails and the
  private-runbook boundary for production operations.
- These architecture pages own stable system responsibilities, boundaries,
  and invariants.
- Active plans in [`doc/plans/`](../plans/) and records in
  [`doc/completed_plans/`](../completed_plans/) are implementation documents,
  not current architecture.
- The code and its tests are the final authority for behavior detail.

## Reading order

1. [Service model](service/SERVICE_MODEL.md) for the Go shell and its routes.
2. [Application model](browser/APPLICATION_MODEL.md) for the two-script
   browser structure and lifecycle.
3. [Authorization model](browser/AUTHORIZATION_MODEL.md) for PKCE, token
   storage, and failure classification.
4. [Security model](security/SECURITY_MODEL.md) for the CSP and the rules
   that confine Spotify data.
5. [Spotify integration](integration/SPOTIFY_INTEGRATION.md) for the
   endpoints, paging bounds, and scopes.
6. [Testing model](testing/TESTING_MODEL.md) for the layered test strategy.
7. [Deployment model](deployment/DEPLOYMENT_MODEL.md) for the production
   layout and release identity.

The broader [documentation map](../README.md) routes every kind of
information to its authority.
