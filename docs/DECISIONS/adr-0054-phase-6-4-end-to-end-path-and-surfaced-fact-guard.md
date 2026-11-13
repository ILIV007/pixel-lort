# ADR-0054: Phase 6.4 — the end-to-end path review and the surfaced fact-guard report

- Status: Accepted (V4 local engineering round; Posidon independent acceptance still outstanding for every live surface)
- Date: 2026-11-11 (Asia/Tehran)
- Round: 1.21.0 / schema 6 (no migration)
- Baseline: d72e5c6cfb3c856087f60473da1620c5e0991c80 (the post-6.3 tick record tip)
- Roadmap anchor: «۶.۴ مسیر سرتاسری: source snapshot→draft فارسی→post با provider fake؛ timeout، quota، late response و نسخه‌های نامعتبر. مدل زنده صرفاً توسط Posidon با مجوز و سهمیهٔ واقعی.»
- Owner directive in force: FULLER steps — every round delivered at full depth (2026-11-10 order).

## Context

The Phase 6.3 round (ADR-0053) delivered the deterministic fact-guard
report as an additive `factGuard` key inside `drafts.document_json`, but
the read-only `/drafts <id>` review view did not render it — the report
was stored yet invisible to the reviewing admin. Separately, the
failure taxonomy of the editorial chain (provider deadline, quota,
late responses, invalid output) was pinned at the unit/service level
(A1–A5/B1–B5/U1–U3) and partially at the integration level, but had
never been walked END-TO-END over the real durable chain: real source
snapshot → real durable job → real engine dispatch → real prepare-draft
handler → real budget authority + allowlist ladder + wall deadline +
output validation → real fenced commit.

## Decision

1. **E2E failure-path re-verification (tests only).** A new integration
   suite (`tests/integration/editorial-64-end-to-end.test.ts`, registered
   in the `test:db` subset) drives the REAL chain with the ONE artificial
   piece being the provider PORT (the documented ADR-0042 §6 seam; zero
   network, zero live inference). It re-verifies, over real workerd D1:
   - provider `deadline_exceeded` → engine `retry_wait`, honest `failed`
     ai_run (`deadline_exceeded`, null tokens), NO draft;
   - the wall-deadline race with a LATE response: the deadline fires
     while the call is in flight (the injectable manual scheduler — the
     documented 1.10.6.1 test seam), the late resolution is ABSORBED
     (no commit, no resurrection, ever), the attempt stays charged
     (conservative, no refund), and the legitimate retry is the ONLY
     draft (its own traced content proves the late value never lands);
   - budget-first quota denial: the bucket exhausted BEFORE the chain →
     ZERO port calls, the budget row unchanged, honest `budget_denied`
     ai_run, typed retry;
   - invalid provider output (unknown evidence reference): the ladder
     retries the NEXT allowlist model (invalid output is not a refusal —
     2 calls for the 2-model workers-ai ladder), then exhausts to the
     typed `provider_unavailable` retry; every real call stays charged;
   - retry exhaustion → `dead_letter` with `job_exhausted` after exactly
     max_attempts, still NO draft;
   - terminal safety refusal → `dead_letter` `editorial_ai_refused` with
     the honest `provider_safety_refusal` run;
   - the R1.11.1 acceptance guard: a schema-valid draft with NO traced
     claim is TERMINAL `editorial_no_traced_claim` with an `invalid` run.
2. **The surfaced fact-guard report (additive view change).** The review
   view's defensive projection reads the stored `factGuard` key through
   its OWN strict reader (`readFactGuardReport`); the renderer adds ONE
   section in the exact house pattern of the other five stored reports:
   - ok → one summary line (`status: evaluated · N (X requiring review /
Y unwitnessed)`) + one `findings:` line (the four bounded lens
     counts summed) + the mandatory note RESERVED before variable
     content (the R1.18.1 S1 discipline): «Lexical observations only —
     never truth verdicts; headline and summary are explicitly
     UNASSESSED.» (fa: «فقط مشاهدات واژگانی — هرگز حکم حقیقت نیستند؛
     تیتر و خلاصه صراحتاً ارزیابی نشده‌اند.»);
   - absent / unsupported_version / malformed → the shared honest-state
     line under its own reservation (identical treatment to the other
     reports; the absent line now appears for legacy documents exactly
     like the other five absent reports);
   - a stored lie (corrupted counts) renders as malformed — never
     guessed into ok, never a crash; the core document still renders.
3. **The view stays read-only.** ZERO new SQL statements (the existing
   two bounded SELECTs), zero writes, zero provider calls, zero
   recomputation from mutable source rows; the stored document is the
   ONLY input.

## Alternatives considered

- Recomputing the fact-guard report fresh in the view: REJECTED — the
  view shows the SAVED document (R1.18 invariant); recomputation would
  fabricate a "current assessment" the stored commit never made.
- Surfacing only when the flag is currently ON: REJECTED — the flag
  gates COMPUTATION at commit time; the view displays what is STORED
  (a stored report exists regardless of the operator's current flag).
- Keeping the fact-guard invisible until a richer UI round: REJECTED —
  the reviewing admin is the report's audience; an invisible P1-relevant
  observation layer is storage without purpose.

## Consequences

- The reviewing admin now sees the fact-guard observations alongside the
  evidence guard, candidates, mentions and relation — in the same
  bounded, budget-first, reserved-note discipline.
- The failure taxonomy is pinned END-TO-END; a future regression in the
  chain's handling of deadline/quota/late/invalid output fails a named
  integration test, not just a unit cell.
- The flag-OFF accepted path stays byte-identical at the DOCUMENT level
  (no factGuard key — asserted) while the VIEW gains the honest absent
  line for it — the same treatment every legacy document already gets
  for the other five reports.
- The two honest in-round assertion corrections are recorded in
  VERSION.json: the ladder's per-model invalid-output retry (2 calls,
  not 1) and the acceptance guard's distinct `editorial_no_traced_claim`
  reason code.

## Non-goals / unchanged invariants

- No flag changes: every gate ships OFF; the view surfacing is
  flag-independent (it displays stored state, it computes nothing).
- No new SQL, no schema change (6), no migration, no provider calls,
  no live AI, no Telegram send, no Cloudflare operation (BLOCKED_LIVE:
  Posidon only), OD-009 stays OPEN, Free readiness NOT_READY.
- The Evidence Guard v1 contract stays FROZEN; the fact-guard report
  contract (factGuardVersion 1) is unchanged — this round only READS it.
