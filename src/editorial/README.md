# src/editorial — Phase 5A (source→draft vertical path) implemented

Phase 5A (R1.11, ADR-0042) implements the FIRST integrated local path from
a durable `source_items` row to a stable Persian draft:

- `src/domain/editorial/identity.ts` — deterministic, versioned identity
  (job idempotency key, story key, row ids, AI input hash). No randomness,
  no timestamps in identity; one item snapshot = one story.
- `src/domain/editorial/mapper.ts` — pure conservative shapes: traceable
  excerpt, `source_report` claim (unverified, confidence 0), `mentions`
  evidence, draft document/facts/warnings (model claims stay unverified).
- `src/adapters/db/editorial-store.ts` — ALL editorial SQL; the fenced
  atomic commit (job/generation/lease ownership predicates inside SQL).
- `src/application/editorial/prepare-draft-handler.ts` — the durable job
  handler behind `EDITORIAL_ENABLED` (fail-closed).
- `src/application/editorial/enqueue-prepare-draft.ts` — the ONLY job
  creation boundary (reference-only payload; no endpoint, no cron).

The deterministic renderer, Persian normalization contract, and prompt
contract storage from the blueprint (§13, persona §4) remain FUTURE work;
the model still never emits Telegram HTML and nothing is published by this
phase. The Persian AI output demonstrated in tests is an OFFLINE FIXTURE.
