# Phase 4 Source Field Ownership — registry import vs owner runtime (Round 1.3, R07)

Status: REVIEW DOCUMENTATION for the R03/R07/R08 candidate. No schema change,
no migration, no activation — this document describes the ownership contract
that `src/adapters/db/source-registry-store.ts` (`seedSourcesFromRegistry`)
now enforces and the scheduler's R08 reconciliation relies on.

## Why a field map

Two writers touch one row of `sources` (and one row of `source_state`):

1. **The registry import** (cron reconciliation / explicit re-import) — the
   validated blueprint catalog (ADR-0038 §2) is the authority for WHAT a
   source IS: its identity, descriptor, and policy facts.
2. **The owner** (you, via reviewed SQL/runbook operations) — the authority
   for WHETHER and HOW a source RUNS: activation, scheduling overrides, and
   runtime watchlists.

Before Round 1.3 the import refreshed the whole descriptor including the
ENTIRE `config_json` column, so a routine re-import silently destroyed owner
watchlists (Steam `apps`, YouTube `playlists`, GitHub `repositories`, Reddit
`subreddits`). The contract below makes every field's owner explicit.

## `sources` column map (on CONFLICT, i.e. re-import of an existing row)

| Column                 | Owner on re-import         | Behavior                                                                                                                               |
| ---------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | —                          | primary key; conflict key                                                                                                              |
| `name`                 | REGISTRY                   | refreshed                                                                                                                              |
| `connector`            | REGISTRY                   | refreshed                                                                                                                              |
| `lane`                 | REGISTRY                   | refreshed                                                                                                                              |
| `trust_tier`           | REGISTRY                   | refreshed                                                                                                                              |
| `enabled`              | **OWNER**                  | NEVER written by the import (insert defaults to 0; an existing value is never flipped — a re-import can neither re-enable nor disable) |
| `interval_seconds`     | **OWNER** (overridable)    | written ONLY on first insert; never refreshed (owner overrides preserved; see "Resetting to registry defaults")                        |
| `priority`             | **OWNER**                  | NEVER written by the import (first insert seeds the lane default)                                                                      |
| `daily_request_budget` | **OWNER** (overridable)    | written ONLY on first insert; never refreshed                                                                                          |
| `approval_policy`      | REGISTRY                   | refreshed                                                                                                                              |
| `attribution_template` | REGISTRY                   | refreshed (null when the registry omits it)                                                                                            |
| `config_json`          | **MERGED per key** (below) | never overwritten wholesale                                                                                                            |
| `created_at`           | **OWNER**                  | never written by the import                                                                                                            |
| `updated_at`           | REGISTRY                   | refreshed on every applied change                                                                                                      |

## `config_json` key map

The persisted config is ONE JSON object carrying two domains. The import
merges the registry side INTO the current value with SQLite
`json_patch(sources.config_json, json_remove(excluded.config_json,
'$.apps', '$.playlists', '$.repositories', '$.subreddits'))` evaluated
in-row (atomic; no application-layer read → no read-modify-write race).

### OWNER watchlist keys (removed from the registry patch side — never touched by a re-import)

| Key            | Connector         | Registry default    | Owner runtime meaning      |
| -------------- | ----------------- | ------------------- | -------------------------- |
| `apps`         | steam-news        | none shipped        | watched Steam app IDs      |
| `playlists`    | youtube-playlists | none shipped        | watched playlist IDs       |
| `repositories` | github-releases   | `[]`                | watched `owner/repo` pairs |
| `subreddits`   | reddit-oauth      | blueprint ships one | watched subreddits         |

Registry defaults for watchlist keys apply ONLY on FIRST insert of a row.

### REGISTRY-owned keys (refreshed by every applied import)

- Endpoint facts: `endpoint` (rss, steam-news, youtube-playlists,
  bluesky-public, igdb), `detailsEndpoint` (youtube-playlists),
  `endpointTemplates` (rss, ≤ 4 entries). The blueprint's singular
  `endpointTemplate` (reddit/github) is informational — those connectors
  pin their own official endpoints — and is not part of the runtime
  config surface (unchanged from Phase 4).
- Connector policy/config keys, validated STRICTLY per connector:
  steam-news `appsPerBatch`, `maxItemsPerApp`; youtube-playlists
  `useSearchEndpoint` (must be `false`), `downloadVideo` (must be
  `false`); reddit-oauth `limit`, `stripDownloadLinks`;
  github-releases `includePrereleases`; bluesky-public
  `accounts`/`reposts`/`replies`; igdb `commercialUseAllowed`/
  `requestsPerSecond`/`onDemand`.
- Unknown keys are rejected by the strict runtime schemas (R03) —
  preflight fails visibly; nothing is silently ignored. A stale registry
  key that a future blueprint drops therefore surfaces as a preflight
  failure requiring explicit owner cleanup (fail-safe by design).

## `source_state` — owner runtime domain, ENTIRELY

The import NEVER updates an existing state row (`INSERT … ON CONFLICT
(source_id) DO NOTHING`). Cursors, etags, windows, failure counters,
budget-day bookkeeping are the poll pipeline's/owner's domain. Missing
state rows are created at `next_poll_at = 0` (due since the beginning —
the pre-existing seeding semantic).

## Invalid persisted config (malformed syntax OR non-object root)

If a persisted `config_json` is not valid JSON, `json_patch` raises inside
the atomic import batch: the whole batch rolls back and the error
propagates (AppError). The malformed value is never wiped, defaulted, or
"repaired" — the failure is visible and the owner fixes the value
explicitly (tested in `tests/integration/round13-r03-r07-r08.test.ts`).

Valid JSON that is NOT a JSON object is equally invalid as a config and is
rejected the same way (Round 1.3.1): `null`, arrays, strings, numbers, and
booleans would otherwise be silently DISCARDED by RFC-7396 MergePatch
(`json_patch` replaces a non-object target with the patch), i.e. reset to
registry defaults. The merge therefore runs inside a
`CASE WHEN json_type(sources.config_json) = 'object' … ELSE NULL END`
evaluated IN the mutating statement: any non-object root makes that
statement violate the column's `NOT NULL` constraint, which aborts the
whole atomic batch — the original value, every other row, and all owner
state remain byte-identical. The object requirement lives at the atomic
mutation boundary (no application-layer pre-read whose snapshot could
race), introduces no schema/migration change, and never silently repairs
bad configuration (tested in `tests/integration/round131-seed-contract.test.ts`
and `tests/integration/posidon-round13-review.test.ts`).

## Resetting owner-overridable columns to registry defaults

Because `interval_seconds` / `daily_request_budget` are owner-owned after
insert, a registry-side change to them does NOT propagate silently. To
adopt a new registry default the owner resets the column explicitly (one
reviewed SQL statement from the runbook), after which subsequent imports
keep the owner value again. This is the deliberate trade-off required by
"preserve owner overrides" without adding schema (no separate
last-seen-registry shadow column exists).

## Reconciliation (R08) in one paragraph

Every scheduler pass runs two bounded indexed probes (`SELECT id FROM
sources WHERE id IN (…registry ids…)`, same for `source_state`). If ANY
registry source lacks a source row OR a state row — even when the table is
not empty — the import above runs as ONE atomic D1 batch (≤ 2 × 32
statements, registry-capped): missing rows are created (disabled), missing
state rows are created at 0, existing rows are merged under this contract.
A failed batch rolls back wholly; repeated or overlapping passes converge
idempotently.
