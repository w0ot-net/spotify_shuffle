# Documentation map

This page routes readers to the current authority for each kind of
information. Architecture pages explain stable system responsibilities; they
do not replace the user or contributor documentation.

## Current authorities

- [`README.md`](../README.md) is the user entry point: what TrueShuffle is,
  product goals, current status, and how to run and test it.
- [`AGENTS.md`](../AGENTS.md) owns contributor guardrails and the
  private-runbook boundary for production operations.
- The [architecture index](architecture/README.md) explains how the system
  fits together and lists the reading order.
- The code and its tests are the final authority for behavior detail.

## Architecture topics

- [Service model](architecture/service/SERVICE_MODEL.md)
- [Application model](architecture/browser/APPLICATION_MODEL.md)
- [Authorization model](architecture/browser/AUTHORIZATION_MODEL.md)
- [Security model](architecture/security/SECURITY_MODEL.md)
- [Spotify integration](architecture/integration/SPOTIFY_INTEGRATION.md)
- [Testing model](architecture/testing/TESTING_MODEL.md)
- [Deployment model](architecture/deployment/DEPLOYMENT_MODEL.md)

## Implementation records

[`plans/`](plans/) contains accepted work that has not been completed.
[`completed_plans/`](completed_plans/) contains historical execution
records. Plans are implementation documents, not current architecture; when
a plan changes the architecture, the affected pages above change with it.
