# Phase 13 — the readiness matrix and the READY_FOR_POSIDON handoff

- Version: 1.30.0; schema 6; branch `review/r1.10.3-sql-design`; PR #11
  (open DRAFT — merged by Posidon only); the delivery HEAD and the exact
  SHA chain are recorded in `PROJECT_STATUS.md` and in the backup ZIPs'
  `SHA256SUMS`.

## 1. The readiness matrix (the engineering verdict per lane)

| #   | Lane                 | State                                            | The exact evidence                                                                                                                                                                                                 |
| --- | -------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | Baseline/hygiene     | DONE_ENGINEERING                                 | the tested backup chain (d272909→daff8d3→26e7cf9→08b9096→7ddb0ff→1.30.0); every ZIP restore-tested (checksums + clone + `git fsck --full` + HEAD/tree match); `npm run check` + `test:db` exit 0 at EVERY delivery |
| 1   | Worker/D1/jobs       | DONE_ENGINEERING                                 | migration chain 0001→0006 append-only; the claim/lease/fence/DLQ machinery pinned by the job suites + the 8.2 outbox store; rollback = the tested restore path                                                     |
| 2   | Telegram/admin-post  | DONE_ENGINEERING (live-OFF)                      | the parser/transport/UTF-16 suites; the private sessions, the version/fingerprint binding, the approval binding, the RBAC; the send gate ships OFF                                                                 |
| 3   | Registry/config      | DONE_ENGINEERING                                 | the registry seed suites; fail-closed flag parsing (invalid-present = disabled) for EVERY gate incl. the new `ADMIN_QUEUE_ENABLED`                                                                                 |
| 4   | Ingestion            | DONE_ENGINEERING (not-ready verdict stands)      | the connector/security/budget suites; the Free-plan verdict stays `NOT_READY` until the owner's live quotas are observed                                                                                           |
| 5   | Story/evidence       | DONE_ENGINEERING (offline)                       | the 5.x suites (fingerprints/matching/adjudication/mentions/relations), no merge execution, provenance preserved                                                                                                   |
| 6   | AI/editorial         | DONE_ENGINEERING (AI OFF everywhere)             | the 6.x suites; fail-closed providers; the fact-guard report surfaced (NOT enforced against AUTO — the enforcement rides the rollout gate)                                                                         |
| 7   | Media/album          | DONE_ENGINEERING (A1–A6 closed)                  | the 7.2/7.3/7.4 suites; the review's five blockers fixed RED→GREEN; the album WIRING to the outbox remains the tracked carry (the send identity + the attachments contract exist)                                  |
| 8   | Publishing/scheduler | DONE_ENGINEERING (ADR-0032 gate at engine level) | 8.1 policy + 8.2 durable scheduler + 8.4 edit/correction (ADR-0057/58/59); the LIVE wiring (cron route, real transport, the enablement flag) stays BLOCKED_LIVE                                                    |
| 9   | Admin screens        | DONE_ENGINEERING (the queue slice)               | R1.18/R1.18.1 + the 9A `/queue` surface; the story screen and the write-capable dispositions remain the carry                                                                                                      |
| 10  | Security/budget      | DONE_ENGINEERING                                 | the Phase 10 sweep + the audit doc; zod v4 migration TRACKED (bounded exposure); no blind force-fixes                                                                                                              |
| 11  | Shadow               | TOOLING DONE, RUN BLOCKED_LIVE                   | `shadow-report.ts` (shd1) + the gates + `PHASE_11_SHADOW_RUNBOOK.md`; ZERO shadow days elapsed                                                                                                                     |
| 12  | Private channel      | KIT DONE, EXECUTION BLOCKED_LIVE                 | `PHASE_12_PRIVATE_CHANNEL_KIT.md` (the matrix + the evidence template); no real-client evidence exists                                                                                                             |
| 13  | Rollout to AUTO      | READY_FOR_POSIDON                                | this matrix; the staged `safe_auto → AUTO` plan with the stop conditions below                                                                                                                                     |

## 2. The rollout plan Posidon executes (the summary)

1. Posidon provisions/verifies the preview environment, applies the six
   migrations IN ORDER on a RESTORED-FROM-BACKUP scratch D1 first, then
   the real D1 (append-only; rollback = the restore path).
2. The flags stay OFF; the shadow run executes per the Phase 11 runbook
   (7–14 days, the daily `shd1` samples, the typed gates).
3. The private-channel matrix executes per the Phase 12 kit (the
   evidence per scenario).
4. `safe_auto` is enabled ONLY with: ALL shadow gates PASS for seven
   consecutive days, the parked-uncertain family at zero, the budget
   consumption inside the recorded free-tier thresholds, and the
   owner's explicit go.
5. `AUTO` widens gradually from `safe_auto` with the SAME gate set plus
   the running duplicate-pressure watch; ANY stop condition pauses and
   defers (never a paid fallback, never a blind resend).

**The stop conditions (ANY one):** a shadow STOP verdict; a near-quota
alarm; a parked ADR-0032 outcome without a disposition; an incident the
owner flags; the duplicate share over the ceiling.

## 3. The honest boundaries (what this handoff does NOT claim)

- NO live send, NO real Telegram/Cloudflare/AI/R2 operation, NO billing
  change, NO production data touch has happened by GLM — all live
  surfaces are Posidon-only by design (the flags ship OFF and several
  have NO production wiring at all: the scheduler cron route, the real
  publication transport, the album wiring).
- NO shadow day has elapsed; NO real-client verification exists; the
  Free-plan readiness verdict stands `NOT_READY` until the owner
  observes the real quotas.
- CI observations are recorded per-SHA in `PROJECT_STATUS.md`; a queued
  run is PENDING, never claimed success.
- The percent-free completion numbers are intentionally absent: the
  lanes above are state + evidence, and the carries are explicit.

**Final engineering state: READY_FOR_POSIDON** — every executable
engineering lane is closed at engine level with real tests and a tested
backup chain; every remaining lane needs the owner's live operations,
permissions, or decisions (the flags, the cron wiring, the shadow run,
the private-channel matrix, the `safe_auto→AUTO` go).
