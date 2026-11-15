# ADR-0050 — R1.22 Phase A: the editorial→post bridge (`/post_from_draft`)

Date: 2026-11-05 · Status: Accepted (local candidate) · Version: 1.17.0 · Schema: 6 (LOCAL-ONLY 0006)

## Context

Phase A of the R1.22 map is the missing link between the two working halves
of the product: the REAL news pipeline (source item → `editorial.prepare_draft`
job → `drafts` row, ADR-0042; read-only `/drafts` review, ADR-0046) and the
admin post pipeline (`/post` capture → preview → version-bound approval →
safe publication outbox, ADR-0049). Until this round the only way to prepare
a channel post was manual capture; an editorial draft could be LOOKED at but
never turned into a post without retyping it — an error-prone, unverifiable
copy step.

## Decision

1. **ONE command, ONE new version, EXISTING downstream.** `/post_from_draft
<editorialDraftId>` (private chat, `draft.create`, own fail-closed
   `EDITORIAL_TO_POST_ENABLED` gate) converts ONE stored READY editorial
   draft into a NEW admin post version. Everything after the conversion is
   the EXISTING R1.20-R1/R1.21 flow unchanged — preview, version-bound
   approval, fingerprint re-derivation, honest outcomes, the live-publish
   gate. No bypass path exists anywhere.

2. **Deterministic, honest render — no fabrication, no truncation.** The
   post text is composed ONLY from the stored document's own fields:
   headline (one bold entity at offset 0), summary, model claims (`• `),
   the FIXED unverified note, and the source attribution. Empty sections
   stay absent. The claim status is structural: an entry not exactly
   `status: 'unverified'` fails the conversion — the unverified status can
   never be laundered into a post. Over-limit compositions fail TYPED with
   the envelope's own reason (never shortened). The raw source excerpt
   deliberately stays in the editorial draft: the channel carries the
   editorial OUTPUT, the evidence stays linkable via `/drafts <id>`.

3. **Durable per-version provenance — the database itself refuses
   fabrication.** Migration 0006 (append-only, schema 5 → 6) rebuilds
   `admin_post_versions`: `source_update_id` becomes NULLABLE, two nullable
   provenance columns (`editorial_draft_id`, `editorial_draft_version`) are
   added, and a table CHECK admits EXACTLY ONE origin per version — captured
   rows keep their real update id, derived rows carry the complete editorial
   pair, and any mixed/neither shape (a fabricated update id, an origin-less
   version, an incomplete pair) is rejected by SQLite itself. No FK is added
   (the R1.20-R discipline: service-level consistency; a deleted editorial
   draft must never retroactively break a published post's history). Legacy
   rows are copied byte-identically with NULL provenance.

4. **Per-source idempotency.** A partial UNIQUE index on
   `(editorial_draft_id, editorial_draft_version) WHERE editorial_draft_id
IS NOT NULL` admits at most ONE derived version per editorial draft
   version. A second conversion — even by a different admin, even
   concurrent — is an honest pointer reply (or, in the index race, one
   rolled-back storage failure), never a duplicate of the news. This is the
   bridge-side complement of the publication outbox's one-primary-per-version
   invariant.

5. **Existing-draft conversion = a normal content update.** Converting while
   the caller has an open draft adds the editorial content as the NEXT
   version of THAT draft; the same atomic batch invalidates every older
   approval (the R1.20-R1 invariant, reused — never reimplemented).

## Consequences

- The manual post pipeline and the news pipeline now share ONE content
  identity model (post-content document + fingerprint) and ONE approval/
  publication path — a single place for integrity, recovery and audit.
- New capability ships default-OFF (`EDITORIAL_TO_POST_ENABLED`); it can
  never enable capture or any send by itself, and the live-publish gate
  always separately gates sends. No Cloudflare operation was performed; 0006
  remains a LOCAL-ONLY candidate until the owner separately authorizes
  remote application.
- The editorial document schema (schemaVersion 1) is unchanged; the render
  is additive and re-runnable. If the document schema evolves, the render's
  strict `schemaVersion === 1` gate fails future documents TYPED — never
  guesses.
- Out of scope (later phases): media-bearing editorial posts (Phase D),
  automatic conversion without a human command (that is the AUTO rollout,
  Phase 13, gated separately), and any unverified-claim promotion.
