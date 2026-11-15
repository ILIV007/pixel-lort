# Phase 5.1 provenance recon (plan-only, 2026-11-07)

> Authority: V2 continuation guide §6, Phase 5.1 — "review the EXISTING
> 5A–5E code, preserve the progress already made". This record is a
> REVIEW deliverable: no new capability, no schema change, no flag
> change, no Cloudflare operation, no deletion. Code observed at
> `a77ad89` (v1.17.0 / schema 6). Values not independently verified are
> marked UNKNOWN; nothing here restarts finished work.

## 1. What exists (5A–5E inventory, verified against the current tree)

| Slice                                           | Domain modules (`src/domain/editorial/`)                                                   | Application (`src/application/editorial/`)             | REAL-D1 integration suites in `test:db` | Status                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------- |
| 5A source→draft (R1.11, ADR-0042)               | `identity.ts`, `mapper.ts`                                                                 | `prepare-draft-handler.ts`, `enqueue-prepare-draft.ts` | `editorial-source-to-draft.test.ts`     | ACCEPTED offline; `EDITORIAL_ENABLED=false` everywhere                |
| 5B Evidence Guard v1 (R1.12)                    | `evidence-guard.ts`                                                                        | (rides in the handler's fenced commit)                 | `evidence-guard-persistence.test.ts`    | implemented; typed outcomes, never false                              |
| 5C-1 fingerprints + discovery (R1.13, ADR-0043) | `story-fingerprints.ts`, `candidate-discovery.ts`                                          | (handler, ≤3 bounded probes)                           | `story-candidates.test.ts` + demo       | implemented; NOT a merge                                              |
| 5C-2 candidate assessment (R1.14)               | `candidate-assessment.ts`                                                                  | (pure evaluator, zero new SQL)                         | same suite + demo                       | implemented; `unrelatednessConcluded: false` fixed                    |
| 5C-3 exact-content reuse (R1.15/15.1/15.2)      | `exact-content.ts`                                                                         | (fenced reuse commit)                                  | `exact-content-reuse.test.ts` + demo    | INDEPENDENTLY ACCEPTED (R1.15.2, Posidon, offline)                    |
| 5D entity mentions (R1.16/16.1, ADR-0044)       | `entity-mentions.ts`                                                                       | (post-gate resolution)                                 | `entity-mentions.test.ts` + demo        | ACCEPTED offline (R1.16.1)                                            |
| 5E-1 event relations (R1.17/17.1, ADR-0045)     | `event-relation-candidates.ts`, `event-relation-evidence.ts`, `event-relation-decision.ts` | (relation step inside handler)                         | `event-relations.test.ts` + demo        | implemented, UNDER INDEPENDENT REVIEW, `EVENT_RELATION_ENABLED=false` |

Flag state verified in the tree this tick: `EDITORIAL_ENABLED=false` and
`EVENT_RELATION_ENABLED=false` in BOTH `wrangler.jsonc` environments and
`.env.example`; the global `AI_ENABLED` kill switch additionally gates
all relation work (R1.17.1 G1). Nothing was enabled.

## 2. The 5.1 provenance requirements mapped onto existing code

**Requirement 1 — every source item, excerpt and version/source
traceable.**

- Item → source: `source_items.source_id` FK + `canonical_url` +
  `content_hash` + `raw_json` (schema 0001); per-source dedup keys
  `UNIQUE(source_id, external_id)` and `UNIQUE(source_id,
canonical_url)`.
- Draft → snapshot: 5A's deterministic versioned snapshot identity with
  stored-hash verification (typed terminal mismatch — a snapshot that
  does not byte-verify is never silently accepted).
- Claim → excerpt: the single `source_report` claim carries the
  traceable `object_text`; `mentions` evidence references the exact
  stored excerpt identity (5A).
- Reuse → origin: 5C-3 adds the second provenance WITHOUT rewriting the
  reused draft; R1.15.2 Q1 makes the reuse relation carry a VERSIONED
  claim identity derived from (target story, item id, CURRENT snapshot
  hash) — a new snapshot can never be acknowledged by an old relation.
- Decision → evidence: 5E-1 stores every relation verdict with explicit
  candidate origins (`fingerprint:<signal>` / `entity:<id>`), pair
  basis ids and evidence ids; every REAL provider attempt gets its own
  deterministic `event_relation` `ai_runs` row (R1.17.1 A1 keeps
  charges recorded even on first-commit throw).
- Editorial draft → publication: migration 0006 (schema 5→6) added
  append-only provenance columns to `admin_post_versions`
  (`source_update_id`, draft id/version, `origin_kind`) — the R1.22
  Phase A bridge; the conversion is a TEXT-ONLY document through the
  strict typed readers (R1.22 recon notes in PROJECT_STATUS).

**Requirement 2 — corrupt and missing data explicit, never inferred.**
The typed-reader discipline is uniform across every report stored in
`document_json`: `absent` (pre-slice historical rows, honestly not
backfilled), `unsupported_version` and `malformed` remain DISTINCT
(5B/5C-1/5C-2/5D readers; R1.15.2 Q2 guards `readReuseDocumentBasis`
against malformed present data; 5E-1 types missing/stale candidate
bases as `basis_unavailable` — never skipped, never a different-event
verdict). Observation vs verification stays separated by contract:
`direct_text_observed` is presence, never confirmation (5B);
`unrelatednessConcluded: false` is FIXED (5C-2); verdicts are
`*_proposed` / `insufficient_evidence`, never truth (5E-1).

**Requirement 3 — claim model independent from publication.**
Claims/evidence/guards live inside `drafts.document_json`/
`facts_json` as `unverified` with confidence 0; `ready` means only "a
draft is stored"; NO path from any claim or guard outcome to
validated/auto_approved/published exists in the editorial path —
publication is the SEPARATE admin pipeline (R1.20-R1/R1.21) with its
own approval binding and fingerprint re-derivation before every send
(ADR-0046 read-only review for editorial drafts). The event-relation
step (5E-1) writes proposals and ledger rows only — no merge, no
adjudication consumption, no publication effect.

## 3. Gaps (explicitly NOT started — recorded, not opened)

1. **Story engine / Phase 5 adjudication consumption** — the roadmap
   states it is NOT complete and NOT claimed: matching, adjudication
   and merging "stay pending separate independent decisions"
   (`docs/ROADMAP.md`, Phase 5A section tail). This is an OWNER /
   Posidon decision gate, not an autopilot action.
2. **Full semantic Fact Guard** — explicitly future; 5B is a LIMITED
   Evidence Guard, not truth verification.
3. **5E-1 independent review** — implemented and OFF; its acceptance
   belongs to Posidon, not to this autopilot.
4. **Live provenance evidence** — everything above is code + REAL-D1
   test evidence on a LOCAL proxy; end-to-end cloud provenance evidence
   remains the owner/Posidon NOT_READY gate (Free readiness unchanged).

## 4. Conclusion and exact next action

Progress through 5E-1 is PRESENT in the current tree, gated OFF, and
preserved byte-for-byte — nothing to restart. Phase 5.1 (provenance
review) is CLOSED with this record. The next Phase 5 sub-phase per the
V2 guide order (5.2 matching) coincides with the roadmap's
owner-decision-gated engine work; therefore the honest next EXACT
action is: **owner/Posidon decision requested on starting 5.2
matching/adjudication** — until that decision, autopilot ticks perform
cheap observation + honest recording only (no heartbeat commits, no new
capability, no flag change). If the owner instead assigns any other
permitted work (e.g. plan-only design for the matching slice), that
instruction supersedes.
