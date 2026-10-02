# Open decisions — log

All Phase-0 open decisions (OD-001..OD-008) were **closed by Alexios in the
Phase-0 review / correction pass on 2026-10-02**. Entries are preserved below
for history; each records the original context, the decision, and the closing
ADR. New unresolved decisions would be added here with status Open.

| ID     | Title                                    | Status | Decided    | ADR      |
| ------ | ---------------------------------------- | ------ | ---------- | -------- |
| OD-001 | TARGET_CHANNEL: secret or config?        | Closed | 2026-10-02 | ADR-0009 |
| OD-002 | Zod adoption timing                      | Closed | 2026-10-02 | ADR-0010 |
| OD-003 | Queue handler ack-all semantics          | Closed | 2026-10-02 | ADR-0011 |
| OD-004 | `/version` endpoint timing               | Closed | 2026-10-02 | ADR-0012 |
| OD-005 | `nodejs_compat` flag                     | Closed | 2026-10-02 | ADR-0013 |
| OD-006 | Per-secret fail-closed readiness phasing | Closed | 2026-10-02 | ADR-0014 |
| OD-007 | `degraded` readiness semantics           | Closed | 2026-10-02 | ADR-0015 |
| OD-008 | Worker name and environment resources    | Closed | 2026-10-02 | ADR-0016 |

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
