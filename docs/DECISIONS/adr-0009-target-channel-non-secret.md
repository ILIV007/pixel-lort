# ADR-0009 — TARGET_CHANNEL is non-secret configuration

- **Status:** Accepted (closes OD-001)
- **Phase:** 0 (correction pass)
- **Date:** 2026-10-02
- **Decided by:** Alexios

## Context

Blueprint §4 lists `TARGET_CHANNEL=@pixellort` under "Required secrets", but
the channel username is publicly observable (it also appears in the
blueprint's own footer HTML) and is not credential material. Open question
OD-001 asked the owner to confirm the classification.

## Decision

`TARGET_CHANNEL` is **non-secret configuration**. The public channel username
is not credential material and must stay OUTSIDE `PixelSecrets`. It is typed
in `PixelConfig` (`src/shared/types/env.ts`) and is NOT part of the future
secret catalog. It is introduced as configuration in the phase that consumes
it (phase 2) and is validated there as plain config.

## Consequences

- `FUTURE_SECRET_CATALOG` no longer lists `TARGET_CHANNEL`.
- `.env.example` documents it under non-secret configuration, not secrets.
- The blueprint's secrets-list layout is knowingly deviated from; the
  deviation is recorded here and in ADR-0008.
