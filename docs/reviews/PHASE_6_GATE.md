# Phase 6 gate — V4 local engineering review (2026-11-11)

**Gate question (roadmap §9, «گیت»):** «هیچ ادعای دقت عددی یا صلاحیت مدل بدون
benchmark واقعی؛ همهٔ خروجی‌های مشکوک fail-closed یا review شوند» — no claim
of numeric accuracy or model competence without a REAL benchmark, and every
suspicious output fail-closed or sent to review. Does the delivered Phase 6
surface (AI adapter contract, generation contract, deterministic fact-guard,
the end-to-end path and its surfaced report) meet BOTH pillars on the
evidence of the tree this document is committed to?

**Verdict: PASS FOR LOCAL ENGINEERING HAND-OFF** — Phase 7 offline work
(media/album inventory, rights policy design, album model design) may proceed
on this tree. The gate does NOT claim Phase 6 "complete": the adapter
foundation remains UNDER INDEPENDENT REVIEW (OFF), Gemini Free-tier
eligibility is UNVERIFIED (the fallback stays structurally OFF even with its
operator flag 'true'), OD-009 stays OPEN, and every live surface (real
providers, real inference, real Telegram delivery, Cloudflare operations)
requires Posidon — BLOCKED_LIVE unchanged. Free readiness stays NOT_READY.

Scope reviewed: the delivered 6.1–6.4 surfaces at the tree this document is
committed to (baseline chain through `b458b63`, v1.21.0, schema 6, every
flag OFF, PR #11 open/draft, CI completed:success on the pushed tip).

---

## 1. Pillar 1 — no accuracy/competence claim without a real benchmark

**Method (reproducible):** a full-text scan of `docs/`, `src/`, `tests/` and
`VERSION.json` for accuracy/competence vocabulary (`accuracy`, `precision`,
`recall`, `F1`, `success rate`, `benchmark`, `دقت`, `نرخ`, `٪`, `درصد`,
percentage literals), with every hit manually classified as (a) a CLAIM of
achieved capability, (b) a REQUIREMENT/target for future measurement, (c) an
explicit DISCLAIMER of capability, or (d) unrelated vocabulary.

**Results — zero claims in class (a) anywhere in the delivered surface:**

1. **The shipped reports structurally cannot claim accuracy.** The fact-guard
   report carries the mandatory note «فقط مشاهدات واژگانی - هرگز حکم حقیقت
   نیستند» / "Lexical observations only - never truth verdicts; headline and
   summary are explicitly UNASSESSED" RESERVED before variable content in
   every rendered view (pinned by the 6.4 view suite); its lens lists are
   FIXED and labelled non-exhaustive in every report; a truncated excerpt
   adds "NO false precision" (unit cell) — coverage flags and honest caps
   travel in every output. The matching/adjudication reports carry the same
   discipline (unassessed tuples verbatim; observation-not-truth notes).
2. **The demos assert the disclaimer in code.** The event-relations demo
   suite asserts the rendered line "The fixture verdicts prove
   plumbing/contract correctness, NOT live-model semantic accuracy" — the
   honesty boundary is itself a tested output, not a comment.
3. **The only `≥95%` entries in the tree are class (b):** `docs/blueprint/
v1/PIXEL_IMPLEMENTATION_SPEC_v1.md` §25 lists "duplicate precision ≥ 95%"
   and "update-vs-duplicate accuracy ≥ 95%" as REQUIRED METRICS of the future
   SHADOW GATE (Phase 11 entry criteria, 7–14 days of real shadow run to be
   measured by Posidon). They are forward-looking acceptance thresholds — the
   opposite of an achieved-capability claim; no delivered document, report or
   version record cites them as met. They remain Posidon's to measure live.
4. **Every "benchmark" hit otherwise** is either the 198.18/15 benchmark IP
   range in the SSRF guard, the editorial persona rules for NEWS benchmark
   content (manufacturer-only results are a REJECTION rule G41), or the
   honesty boundary itself.
5. **VERSION.json and the round records state the inverse:** "no verified
   semantic accuracy", "NEVER live-model semantic accuracy", "no
   Phase-6-completion claim"; the VERSION.json `status` line enumerates the
   NOT-ACTIVATED / OFF / NOT_READY posture verbatim.

**Structural conclusion:** on this tree there is no numeric-accuracy or
model-competence claim that lacks a real benchmark — the only quantitative
targets are unmet future gate criteria explicitly reserved for live
measurement, and every AI-adjacent output is labelled as unverified
observation travelling with its limitations.

## 2. Pillar 2 — every suspicious output fail-closed or sent to review

The suspicious-output taxonomy across the Phase 6 chain, each class pinned by
a NAMED test (nothing here rests on a report's word):

| #   | Suspicious output class                                                                                  | Fail-closed / review mechanism                                                                                                                                                                                   | Pinning test (real, in this tree)                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Malformed/unparseable provider output                                                                    | rejected attempt; bounded ladder continues; no usage invented                                                                                                                                                    | `tests/unit/ai-draft-service.test.ts` «malformed provider output is a rejected attempt; the ladder continues bounded»                                                            |
| 2   | Semantically invalid output (unknown evidence reference)                                                 | cross-check rejects → per-model retry → typed `provider_unavailable` retry; 0 drafts                                                                                                                             | E2E «invalid provider output (unknown evidence reference)…» + unit «unknown evidence references are rejected as invalid output»                                                  |
| 3   | Schema-valid draft with NO traced claim                                                                  | R1.11.1 acceptance guard → TERMINAL `editorial_no_traced_claim`                                                                                                                                                  | E2E «schema-valid draft with NO traced claim…»                                                                                                                                   |
| 4   | Provider deadline                                                                                        | typed `retry_wait` + honest failed `ai_run` (null tokens)                                                                                                                                                        | E2E «provider deadline_exceeded → typed recoverable retry…»                                                                                                                      |
| 5   | Wall deadline vs in-flight call (late response)                                                          | late resolution ABSORBED — never commits/resurrects; attempt charged conservatively; legitimate retry is the ONLY draft                                                                                          | E2E «wall deadline fires while a call is in flight…»                                                                                                                             |
| 6   | Quota exhausted                                                                                          | budget-FIRST denial → ZERO provider calls, no fabricated run                                                                                                                                                     | E2E «budget-first quota denial…»                                                                                                                                                 |
| 7   | Terminal safety refusal                                                                                  | permanent dead_letter `editorial_ai_refused`                                                                                                                                                                     | E2E «terminal provider safety refusal…»                                                                                                                                          |
| 8   | Persistent provider failure                                                                              | bounded retries → dead_letter `job_exhausted` after exactly max_attempts, still NO draft                                                                                                                         | E2E «retry exhaustion with a persistently failing provider…»                                                                                                                     |
| 9   | Ineligible/unknown-eligibility model (Gemini)                                                            | NEVER reaches the network even when its operator flag is 'true' — eligibility unverified ⇒ structural OFF                                                                                                        | unit «ineligible/paid-unknown Gemini NEVER makes a provider call even when gated on» + «CF quota denial skips the shared-bucket CF alternate; ineligible Gemini is never called» |
| 10  | Any invalid request at the service boundary                                                              | fail-closed with ZERO side effects                                                                                                                                                                               | unit «invalid requests fail closed with zero side effects»                                                                                                                       |
| 11  | Claims that fail the fact-guard lenses (unwitnessed, number mismatch, rumor markers, negation asymmetry) | `reviewRequired` DERIVED true — typed findings, never a verdict, never a rewrite of the claim's `unverified` status                                                                                              | unit fact-guard cells (benign → false; non-benign → true) + the 5.4 `reviewRequired↔disposition` coherence cell                                                                  |
| 12  | A stored LIE (corrupted counts / bad lens / unknown code / incoherent reviewRequired)                    | strict typed reader ⇒ malformed; the view renders malformed; the core document still renders; never guessed into ok, never a crash                                                                               | unit «stored lies are malformed…» + E2E «a stored LIE (corrupted fact-guard counts)…»                                                                                            |
| 13  | Injection-like text (in claims/excerpts)                                                                 | INERT DATA — observed lexically, never executed/interpreted                                                                                                                                                      | unit «injection-like text inside claims/excerpts is INERT…»                                                                                                                      |
| 14  | Truncated excerpt scope                                                                                  | NO false precision — coverage carried, lenses stay excerpt-scope                                                                                                                                                 | unit «a truncated excerpt adds NO false precision…»                                                                                                                              |
| 15  | Foreign/stale snapshot behind an evidence reference                                                      | evidence-guard identity gate rejects at build time                                                                                                                                                               | `evidence-guard-persistence` + `exact-content-reuse` suites (R1.15/R1.15.2)                                                                                                      |
| 16  | Even a CLEAN model output                                                                                | every claim stored `status: 'unverified'`; NO code path upgrades it; conversion LAUNDERS NOTHING (non-`unverified` ⇒ typed failure); publication requires the human approval chain + the live-publish gate (OFF) | E2E «flag ON: …the conversion preserves provenance + unverified status»; R1.22 bridge suites; 5→6 gate structural proof                                                          |

**The catch-all review leg (16) is the reason no class can slip silently:**
even an output that passes every guard above lands as an explicitly
UNVERIFIED draft inside a read-only review view whose fact-guard section (6.4
surfacing) shows the lexical observations and their requiring-review counts —
the human decision point is structural, not conventional. Fail-closed (1–10,
12–15) and review (11, 16) together cover the taxonomy; no gap class was
found.

## 3. What this review cannot prove (honest limits)

- Any REAL provider/model behavior: the artificial port (ADR-0042 §6) is the
  only stub; live inference, live quota behavior and live costs are
  Posidon-only evidence (BLOCKED_LIVE).
- The future shadow metrics (blueprint §25) are unmeasurable locally by
  definition — they stay unmet and unclaimed.
- The 15 s wall deadline is exercised through the documented injectable
  scheduler seam, not real 15-second waits.
- The adapter foundation remains UNDER INDEPENDENT REVIEW (OFF) — this gate
  reviews the delivered local engineering surface, not independent
  acceptance.

## 4. Findings

- **No P0/P1 gap found.** The taxonomy of pillar 2 maps onto existing named
  tests; the two-round re-verification (6.4) executed the failure paths ALONG
  the real chain, not only at unit level.
- **Process note (recorded, no action):** the blueprint v1 shadow-gate
  percentages are the ONLY quantitative accuracy vocabulary in the tree and
  are correctly shaped as future requirements. Phase 7+ documents must keep
  citing them as unmet Phase-11 criteria, never as achieved results.
- **Carried open items (unchanged):** Gemini eligibility UNVERIFIED; OD-009
  OPEN (owner decision, no purge code exists); adapter foundation UNDER
  INDEPENDENT REVIEW; Free readiness NOT_READY.

## 5. Gate conditions carried INTO Phase 7 (binding)

1. Every Phase 7 deliverable keeps the fail-closed flag discipline
   (independent, default 'false', never implying another gate) and the
   additive-document pattern (absent = key never written; no backfill).
2. No numeric-accuracy or model-competence claim without a REAL benchmark;
   the blueprint shadow-gate metrics stay cited as FUTURE Phase-11 criteria.
3. Media rights/origin handling (roadmap 7.2) inherits the same honesty
   boundary: ambiguous rights ⇒ reject/defer with a typed reason — never a
   silent pass; YouTube stays OUTSIDE any download permission.
4. All live paths stay BLOCKED_LIVE (Posidon only): Cloudflare operations,
   real migration, flag enabling, real AI, real Telegram send, R2 writes,
   data deletion.
5. PR #11 stays open/draft; FF-only pushes on `review/r1.10.3-sql-design`;
   no force, no merge, no base change.

**Next per roadmap after this gate:** Phase 7.1 — the media/album
compatibility inventory (existing single photo/video, file_id, caption,
entities preservation) as a documented evidence-based review with its own
RED→GREEN tests where a gap is found; then 7.2 rights/origin policy design.
Delivered separately with gates, checkpoint, backup and an honest report.
