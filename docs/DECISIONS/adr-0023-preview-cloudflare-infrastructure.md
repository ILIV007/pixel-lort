# ADR-0023: Provision isolated Cloudflare preview infrastructure

- **Status:** Accepted
- **Date:** 2026-10-02
- **Phase:** 1B

## Context

Phase 1A produced a tested D1 migration and runtime schema-health contract. A remote preview environment is required before any production resource or Telegram workflow is introduced.

## Decision

- Provision only the preview D1 database: `pixel-db-preview`.
- Bind it as `DB` in Wrangler environment `preview`.
- Deploy the preview Worker as `pixel-preview`.
- Keep production resources unprovisioned until a later release gate.
- Apply migrations remotely only to the preview database.
- Inject the exact Git commit at deploy time; never commit a generated SHA into configuration.
- Keep deployment credentials outside Git and logs.

## Consequences

Preview and production state cannot be confused. `/version` identifies the deployed commit, while `/health/ready` verifies that the remote schema matches schema version 1. Repository-to-Worker build integration is configured only after the first manual preview deployment is verified.
