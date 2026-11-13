# Open decisions — log

All Phase-0 open decisions (OD-001..OD-008) were **closed by Alexios in the
Phase-0 review / correction pass on 2026-10-02**. Entries are preserved below
for history; each records the original context, the decision, and the closing
ADR. New unresolved decisions would be added here with status Open.

| ID     | Title                                              | Status   | Decided    | ADR      |
| ------ | -------------------------------------------------- | -------- | ---------- | -------- |
| OD-001 | TARGET_CHANNEL: secret or config?                  | Closed   | 2026-10-02 | ADR-0009 |
| OD-002 | Zod adoption timing                                | Closed   | 2026-10-02 | ADR-0010 |
| OD-003 | Queue handler ack-all semantics                    | Closed   | 2026-10-02 | ADR-0011 |
| OD-004 | `/version` endpoint timing                         | Closed   | 2026-10-02 | ADR-0012 |
| OD-005 | `nodejs_compat` flag                               | Closed   | 2026-10-02 | ADR-0013 |
| OD-006 | Per-secret fail-closed readiness phasing           | Closed   | 2026-10-02 | ADR-0014 |
| OD-007 | `degraded` readiness semantics                     | Closed   | 2026-10-02 | ADR-0015 |
| OD-008 | Worker name and environment resources              | Closed   | 2026-10-02 | ADR-0016 |
| OD-009 | Source-data retention enforcement (`storeRawDays`) | **Open** | —          | —        |

---

## OD-001 — TARGET_CHANNEL: secret or config? — **CLOSED**

**Context (as opened):** Blueprint §4 lists `TARGET_CHANNEL=@pixellort` under
"Required secrets", but the channel username is publicly observable (it also
appears in the blueprint's own footer HTML) and is not credential material.
The Phase-0 default classified it as non-secret configuration
(`PixelConfig.TARGET_CHANNEL`, phase 2); phase 0 does not consume it.

**Decision (Alexios, 2026-10-02):** TARGET_CHANNEL is **non-secret
configuration**. The public channel username is not credential material.
Keep it outside `PixelSecrets`.

**Implementation:** removed from `FUTURE_SECRET_CATALOG`; documented under
non-secret configuration in `.env.example`. See ADR-0009.

**Owner amendment (Round 1.10.5, 2026-10-27):** the channel was renamed by the
owner to **pixel lores** (`@pixellores`, https://t.me/pixellores). The
"as opened" quote above is preserved verbatim as history; the current
intended value is `TARGET_CHANNEL=@pixellores` (still non-secret — ADR-0009
classification unchanged).

---

## OD-002 — Zod adoption timing — **CLOSED**

**Context (as opened):** Blueprint §12 mandates Zod parsing for AI provider
outputs. The Phase-0 configuration validator is deliberately dependency-free
(ADR-0003); phase 0 adds no AI SDKs and no schema library.

**Decision (Alexios, 2026-10-02):** Introduce Zod in **Phase 3**, when queue
envelopes and durable job payload contracts are implemented. Reuse it later
for AI structured outputs in Phase 6. The current lightweight configuration
validator may remain dependency-free.

**Implementation:** recorded for phases 3 and 6 in `docs/ROADMAP.md`. See
ADR-0010.

---

## OD-003 — Queue handler ack-all semantics — **CLOSED**

**Context (as opened):** The Phase-0 queue handler acknowledges every message
to prevent unbounded redelivery of a skeleton consumer. No queue exists in
Phase 0; the job framework phase (roadmap phase 3) was expected to replace
this.

**Decision (Alexios, 2026-10-02):** Ack-all is **approved only for the
non-deployed Phase 0 skeleton**. It must be replaced before any real queue
consumer is bound or deployed. **No intermediate deployment with ack-all
behavior is allowed.**

**Implementation:** constraint recorded in the queue entrypoint docs and
`docs/ROADMAP.md` phase 3. See ADR-0011 (amends ADR-0007).

---

## OD-004 — `/version` endpoint timing — **CLOSED**

**Context (as opened):** Blueprint §5 specifies `GET /version` (version,
build commit, schema version). Build-commit injection implies CI changes;
the Phase-0 default deferred the endpoint to phase 2.

**Decision (Alexios, 2026-10-02):** Implement in **Phase 1**. It should
return safe build metadata: application version, commit identifier, schema
version, and deployment environment. Use development-safe defaults locally;
CI/deployment metadata injection will be finalized with the deployment
workflow.

**Implementation:** `docs/ROADMAP.md` moved `GET /version` to phase 1. See
ADR-0012.

---

## OD-005 — `nodejs_compat` compatibility flag — **CLOSED**

**Context (as opened):** Phase 0 uses only Web-standard APIs; no Node-only
APIs. Blueprint principles require avoiding Node-only APIs unless supported
and necessary.

**Decision (Alexios, 2026-10-02):** **Do not enable it now.** Only introduce
it later when an approved dependency has a demonstrated requirement,
accompanied by an ADR.

**Implementation:** `wrangler.jsonc` has no compatibility flags; gate
recorded. See ADR-0013.

---

## OD-006 — Per-secret fail-closed readiness phasing — **CLOSED**

**Context (as opened):** Blueprint §1.10 requires fail-closed readiness
("missing secrets make readiness fail"). Phase 0 binds no secrets and must
run without credentials; validating all blueprint secrets now would make
every Phase-0 deployment permanently `not_ready`. ADR-0008 proposed
phase-scoped gating and asked for confirmation.

**Decision (Alexios, 2026-10-02):** **Phase-scoped fail-closed readiness is
approved.** A credential or binding becomes required when the feature
consuming it is introduced.

**Implementation:** `FUTURE_SECRET_CATALOG` remains the typed per-phase gate
source. See ADR-0014 (confirms ADR-0008).

---

## OD-007 — `degraded` readiness semantics — **CLOSED**

**Context (as opened):** Blueprint §5 allows `ready/degraded/not_ready`.
Phase 0 has no subsystems that can degrade, so only `ready`/`not_ready` are
emitted; the definitions for `degraded` were needed before phase 2 checks
land.

**Decision (Alexios, 2026-10-02):**

- `ready`: all required core dependencies for the deployed phase are
  functional.
- `degraded`: core publishing control remains safe and functional, but a
  non-critical source, optional provider, fallback provider, or optional
  media subsystem is unavailable.
- `not_ready`: required configuration is missing or a core dependency
  required for safe operation is unavailable.

Core dependencies in later phases include required Telegram authentication,
D1, and any queue path required by enabled publishing workflows.

**Implementation:** recorded as the contract for future readiness checks.
See ADR-0015.

---

## OD-008 — Worker name and queue/environment resource names — **CLOSED**

**Context (as opened):** wrangler.jsonc uses `name: "pixel"`; blueprint names
queues `pixel-jobs`/`pixel-dlq`. Actual resource names may need environment
prefixes (preview vs production).

**Decision (Alexios, 2026-10-02):** Separate preview and production
resources. Planned names — Production Worker: `pixel`; Preview Worker:
`pixel-preview`. Production resources: `pixel-db-production`,
`pixel-cache-production`, `pixel-jobs-production`, `pixel-dlq-production`,
`pixel-media-production`. Preview resources: `pixel-db-preview`,
`pixel-cache-preview`, `pixel-jobs-preview`, `pixel-dlq-preview`,
`pixel-media-preview`. Do not create these resources during the correction
pass.

**Implementation:** `wrangler.jsonc` placeholders record the planned names;
no resources were created. See ADR-0016.

---

## OD-009 — Source-data retention enforcement (`storeRawDays = 90`) — **OPEN**

**Context (as opened, R1.22 autopilot tick, 2026-11-06, code @ 2dfba5a,
v1.17.0/schema 6):** the blueprint registry's `globalPolicies.storeRawDays
= 90` is validated by the runtime registry schema
(`src/domain/source/source-registry.ts`) but has NO enforcement path in
product code: no durable job and no DELETE/purge statement touches
`source_items` or `raw_json` (verified by search this round; the "cleanup"
mentions in `prepare-draft-handler.ts` are attempt-scoped in-memory
union-row cleanup, unrelated to retention). `docs/ROADMAP.md` Phase 5 is
honestly marked PARTIAL and claims no retention enforcement, so this is an
OPEN product decision, not a false claim to correct. The Free-plan resource
ledger records storage arrival/retention as UNMEASURED (risk R-STORAGE);
the D1 Free cap is 500 MB per database.

**Why it is not implemented unilaterally:** auto-deleting stored provenance
data is a product/security decision. Raw payloads back the honest
verification chains (evidence provenance, editorial snapshot verification,
exact-content reuse), and a wrong purge silently destroys reproducibility.

**Interactions every option must respect (verified against schema
@ 2dfba5a):**

1. `UNIQUE(source_id, external_id)` and `UNIQUE(source_id, canonical_url)`
   are the ITEM-level dedup boundary — deleting whole rows removes the
   dedup memory: a re-fetched old item re-enters as NEW (re-derived, new
   editorial-draft path). The story-level `story_fingerprints`
   `PRIMARY KEY(kind, value)` remains as the guard, conditional on
   fingerprint coverage.
2. `evidence.source_item_id` is a NOT NULL FK and each evidence row stores
   its own excerpt — purging raw-payload COLUMNS does not destroy existing
   evidence provenance; deleting ROWS needs an explicit FK policy decision.
3. Editorial exact-reuse / snapshot verification relies on stored item
   snapshot identity (`content_hash` / snapshot hashes) — whole-row
   deletion ends future re-verification of old drafts (historical
   auditability loss).
4. Any enforcement must be a DURABLE job with the standard fail-closed gate
   pattern (independent flag, default OFF), budget accounting, bounded
   batches and its own real-path test suite — never an ad-hoc cron DELETE.

**Options (for the owner):**

- **A — purge `raw_json` only** for rows older than `storeRawDays` (rows,
  normalized fields, `content_hash` and URLs retained): preserves dedup
  memory, the evidence FK and the audit trail; loses only the bulk raw
  provider payload, which is the dominant storage component. LEAST
  destructive.
- **B — delete whole rows** older than `storeRawDays`: strongest storage
  relief; breaks item-level dedup memory (re-ingestion risk), needs an
  explicit evidence-FK policy and an accepted historical-auditability loss.
- **C — defer enforcement, measure first**: per the ledger, arrival/
  retention actuals are UNMEASURED and 14 sources with bounded per-item
  caps may stay far under the 500 MB Free cap for a long time; retention
  may be unnecessary in the near term.
- **D — stop storing `raw_json` (or shrink it) at ingestion time**: a
  pipeline/schema change that affects the reproducibility of the
  normalization itself; NOT a retention decision and wider-reaching than
  the others.

**Recommendation recorded for the owner:** Option A if/when enforcement is
wanted, or Option C until a storage measurement exists. Any implementation
is a separate authorized round (durable job + independent fail-closed gate
default OFF + real-path tests); NO activation without an explicit owner
decision, consistent with every other gate in the project.

**Decision:** none yet — **Open**. No ADR filed; this entry records the
options only.

## OD-010 — The media rights-EVIDENCE model (scope / expiry / attribution) — **OPEN**

**Opened:** the a279e13 review round (1.35.0). **Status:** Open — owner
decision required BEFORE any live media publication.

**Context.** The independent review of a279e13 (item 3) re-confirmed: the
officialness of a source (`official_api` origin, or official/verified
source metadata) proves neither a republication license, nor its
scope/destination, nor an expiry, nor attribution compliance. The code now
holds the fail-closed posture end-to-end: `rightsStateFor` feeds ONLY the
mrp1 staging decision (an allow was always strictly scoped
`r2_temporary_only` — fetch + stage into the 72h temporary store, never a
publish grant), and the durable echo of every machine-staged asset is
`unknown` — the publication allowlist (PUBLICATION_MEDIA_RIGHTS_V1:
official / licensed / attribution_required) and the reuse predicate both
refuse it. The machine INVENTS no permission: an affirmative status can
only be recorded by an explicit, evidence-backed owner action (no such
write surface exists yet — deliberately).

**The consequence (honest, by design).** Until the owner records an
affirmative status for a specific asset, NOTHING the machine staged can be
published or reused: the scheduler's send-time/evidence-time rights gate
dead-letters typed (`media_rights_not_publishable`) and the upload path
re-stages instead of reusing. The reuse economy (zero-fetch replays)
applies ONLY to evidence-cleared rows.

**Decision required from the owner (before any live activation):**

1. The evidence model: WHICH records establish `official` / `licensed` /
   `attribution_required` for a specific asset (license text, written
   permission, platform ToS analysis, attribution obligations), and WHERE
   the evidence is stored (schema 6 is frozen — likely a new migration).
2. The scope discipline: per-destination? per-campaign? time-bounded
   (expiry) or perpetual?
3. The attribution workflow: which statuses demand an attribution line,
   and how it is rendered into the caption envelope.
4. The write surface: who records affirmative statuses (owner-only? an
   admin command?), with what audit trail.
5. Whether the upload path's own group send (currently BLOCKED_LIVE with
   no production caller) must consume the same evidence model before any
   live activation — recommended: yes.

**Recommendation recorded for the owner:** keep the fail-closed default
(`unknown` refuses everything) until 1–4 exist; do NOT widen the
allowlist as a shortcut; do NOT map provenance to clearance again.

**Decision:** none yet — **Open**. No ADR filed; this entry records the
required decision only.
