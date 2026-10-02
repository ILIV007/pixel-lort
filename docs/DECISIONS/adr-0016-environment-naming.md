# ADR-0016 — Environment naming: separate preview and production resources

- **Status:** Accepted (closes OD-008)
- **Phase:** 0 (correction pass)
- **Date:** 2026-10-02
- **Decided by:** Alexios

## Context

wrangler.jsonc uses `name: "pixel"`; blueprint names queues
`pixel-jobs`/`pixel-dlq`. OD-008 asked for the final Worker/resource naming
and whether preview and production must be separated.

## Decision

Preview and production use **separate resources** with the following planned
names:

**Workers**

| Environment | Worker name     |
| ----------- | --------------- |
| Production  | `pixel`         |
| Preview     | `pixel-preview` |

**Production resources**

- `pixel-db-production`
- `pixel-cache-production`
- `pixel-jobs-production`
- `pixel-dlq-production`
- `pixel-media-production`

**Preview resources**

- `pixel-db-preview`
- `pixel-cache-preview`
- `pixel-jobs-preview`
- `pixel-dlq-preview`
- `pixel-media-preview`

These resources are **NOT created during the correction pass** (and none were
created in Phase 0). Resource creation happens in the phase that binds them,
with explicit owner approval.

## Consequences

- `wrangler.jsonc` commented placeholders record the planned names.
- Binding names (DB, CACHE, JOBS, MEDIA, AI) remain fixed by the blueprint;
  only resource names gain environment suffixes.
