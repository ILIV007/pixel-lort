# Open decisions

Unresolved implementation decisions requiring the project architect's input.
Nothing here is silently decided; each entry records the current
Phase-0-compatible default and what is needed to close it.

| ID     | Title                                    | Status | Owner   |
| ------ | ---------------------------------------- | ------ | ------- |
| OD-001 | TARGET_CHANNEL: secret or config?        | Open   | Alexios |
| OD-002 | Zod adoption timing                      | Open   | Alexios |
| OD-003 | Queue handler ack-all semantics          | Open   | Alexios |
| OD-004 | `/version` endpoint timing               | Open   | Alexios |
| OD-005 | `nodejs_compat` flag                     | Open   | Alexios |
| OD-006 | Per-secret fail-closed readiness phasing | Open   | Alexios |
| OD-007 | `degraded` readiness semantics           | Open   | Alexios |
| OD-008 | Worker name and queue names              | Open   | Alexios |

---

## OD-001 — TARGET_CHANNEL: secret or config?

**Context:** Blueprint §4 lists `TARGET_CHANNEL=@pixellort` under "Required
secrets", but the channel username is publicly observable (it also appears in
the blueprint's own footer HTML) and is not credential material.

**Current Phase-0 default:** Classified as non-secret configuration
(`PixelConfig.TARGET_CHANNEL`, phase 2). Phase 0 does not consume it.

**Needed to close:** Confirm classification; if it must stay in the secrets
inventory, move it to `PixelSecrets` in the phase that consumes it.

---

## OD-002 — Zod adoption timing

**Context:** Blueprint §12 mandates Zod parsing for AI provider outputs. The
Phase-0 configuration validator is deliberately dependency-free (ADR-0003).
Phase 0 adds no AI SDKs and no schema library.

**Current Phase-0 default:** Hand-rolled config validator; Zod is introduced
with the AI contract phase (roadmap phase 6) — or earlier if Alexios prefers
to reuse it for configuration/queue envelope validation (phase 3).

**Needed to close:** Confirm the introduction phase.

---

## OD-003 — Queue handler ack-all semantics

**Context:** The Phase-0 queue handler acknowledges every message to prevent
unbounded redelivery of a skeleton consumer. No queue exists in Phase 0.

**Current Phase-0 default:** Ack-all + structured log. The job framework
phase (roadmap phase 3) replaces this with claim/lease/idempotent processing
and explicit ack/retry per message.

**Needed to close:** Confirm the replacement plan and that no intermediate
deployment will occur before phase 3 (Phase 0 forbids deployment anyway).

---

## OD-004 — `/version` endpoint timing

**Context:** Blueprint §5 specifies `GET /version` (version, build commit,
schema version). Build-commit injection implies CI changes.

**Current Phase-0 default:** Deferred to phase 2 with the full public HTTP
surface; `/health` already reports `APP_VERSION` (default
`0.0.0-phase0`, injected via wrangler vars).

**Needed to close:** Confirm phase and the build-metadata injection mechanism
(e.g., CI-generated wrangler var).

---

## OD-005 — `nodejs_compat` compatibility flag

**Context:** Phase 0 uses only Web-standard APIs; no Node-only APIs. Blueprint
principles require avoiding Node-only APIs unless supported and necessary.

**Current Phase-0 default:** Flag not enabled.

**Needed to close:** Revisit when the first dependency actually requires it
(e.g., an RSS/XML library); decide via ADR at that point.

---

## OD-006 — Per-secret fail-closed readiness phasing

**Context:** Blueprint §1.10 requires fail-closed readiness ("missing secrets
make readiness fail"). Phase 0 binds no secrets and must run without
credentials; validating all blueprint secrets now would make every Phase-0
deployment permanently `not_ready`.

**Current Phase-0 default:** Readiness checks only the Phase-0 config subset;
`FUTURE_SECRET_CATALOG` (src/shared/config/phase0.ts) records each secret
with the phase that starts consuming it. Each phase adds its secrets to the
readiness check when its feature lands.

**Needed to close:** Confirm Alexios accepts phase-scoped readiness gating as
the faithful interpretation of the fail-closed principle.

---

## OD-007 — `degraded` readiness semantics

**Context:** Blueprint §5 allows `ready/degraded/not_ready`. Phase 0 has no
subsystems that can degrade, so only `ready`/`not_ready` are emitted.

**Current Phase-0 default:** `degraded` is reserved for phase 2 (when webhook
secret, D1, and queue checks exist).

**Needed to close:** Define which failures constitute `degraded` vs
`not_ready` when those checks are introduced.

---

## OD-008 — Worker name and queue names

**Context:** wrangler.jsonc uses `name: "pixel"`; blueprint names queues
`pixel-jobs`/`pixel-dlq`. Actual resource names may need environment
prefixes (preview vs production).

**Current Phase-0 default:** Blueprint names as-is, single environment.

**Needed to close:** Confirm naming and whether separate preview/production
Workers are desired.
