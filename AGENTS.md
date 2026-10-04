# AGENTS.md — standing instructions for coding agents

This document gives future coding agents (human or automated) stable rules for
working in this repository. It is intentionally terse and version-stable.

## 1. Source of truth

1. The blueprint at `docs/blueprint/v1/` is the **authoritative specification**.
   Do not rewrite, reformat, or "improve" those files. Preserve them as-is.
2. `docs/ROADMAP.md` defines phase boundaries. Implement **one phase at a time**
   and only the deliverables of the current phase.
3. Do not silently change architectural decisions. If a decision is ambiguous,
   record it in `docs/OPEN_DECISIONS.md` instead of inventing a permanent
   solution. If you _must_ change architecture, write an ADR in
   `docs/DECISIONS/` first.

## 2. Cloudflare Workers runtime constraints

- Target the Workers runtime (workerd), not Node.js. Do not use Node-only APIs
  in `src/` unless they are explicitly supported by Workers compatibility
  settings AND truly necessary (document via ADR).
- Workers have CPU/time limits: no long-running loops, no heavy transcoding,
  no full-table scans. Chunked, bounded work only.
- D1 is the source of truth. Queues carry only durable job references.
  KV is cache/lock storage only — never authoritative state.
- Queues are at-least-once: consumers must be idempotent; externally visible
  actions require deterministic idempotency keys (`src/shared/ids/`).
- **D1 rules (Phase 1A+):** all D1 access goes through the typed boundary in
  `src/adapters/db/` (ADR-0022). Never log SQL text or bind parameters
  (they may carry user/source content) and never log full rows. Batches are
  atomic — rely on that for multi-write idempotency. Applied migration files
  in `migrations/` are append-only; application schema metadata lives in the
  `schema_metadata` table and is distinct from Wrangler's `d1_migrations`
  bookkeeping (ADR-0019). Remote migration commands require explicit owner
  instruction and an approved Phase 1B binding.
- **Telegram rules (Phase 2A+):** the webhook route exists only behind the
  fail-closed `TELEGRAM_INGRESS_ENABLED` flag with valid Phase 2 config
  (ADR-0024). Verify the shared secret with the timing-safe helper in
  `src/shared/security/timing-safe.ts` — never a plain-string comparison.
  update_id is the idempotency boundary via durable D1 claims (ADR-0025);
  duplicates are acknowledged without reprocessing. Command behavior goes
  through the command router's TYPED actions, never direct fetches
  (ADR-0026). Outbound Telegram HTML must be composed with
  `src/admin/telegram-html.ts` and passes the validator before sending.
  Callback data is the opaque `a:<base64url_token>` contract only.

## 3. Security and secret rules — non-negotiable

- Never commit real credentials or realistic token-shaped examples anywhere:
  source, fixtures, docs, logs, commit messages, or generated reports.
- Never log or print: authorization headers, cookies, tokens, request bodies,
  full environment objects, Telegram update payloads (including message text,
  usernames, phone numbers, chat/user ids, callback data), or provider
  responses. Webhook/pipeline logs carry stable event names, reason codes,
  action types, role names, and update_id only.
- All log fields pass through the redaction layer (`src/observability/`),
  which also FAIL-SAFE serializes Error instances (name + stable code +
  HTTP status only; raw messages/stacks/causes are never emitted —
  ADR-0017). Do not bypass `src/observability/logger.ts` with `console.*`
  (lint-enforced).
- Errors returned over HTTP must flow through
  `src/shared/errors/serialize.ts` — safe, minimal, no stacks.
- No query-string secrets. No public mutation/debug endpoints. Fail closed on
  authorization.
- Run `npm run scan:secrets` (part of `npm run check`) before every handoff.

## 4. Required checks before any handoff

Run and pass the complete gate:

```bash
npm run check   # lint + format:check + typecheck + test + test:secrets + scan:secrets + build
```

- Tests must run offline (fixtures/mocks only; no real network calls).
- `npm run build` is a `wrangler deploy --dry-run` — never an actual deploy.
- Never claim a check passed without actually running it.

## 5. Workflow rules

- Use focused conventional commits (`feat:`, `fix:`, `test:`, `docs:`,
  `chore:`, `refactor:`). Work on `phase/NN-name` branches; never commit
  directly to `main`.
- Do not push, merge, deploy, or create Cloudflare resources unless the
  project owner explicitly instructs it for that phase.
- Runtime dependencies stay minimal. Justify any new dependency in the handoff
  report and prefer Workers-compatible, dependency-light options.
- Persian/RTL behavior is a product requirement, not decoration: preserve the
  persona and normalization contracts in `docs/blueprint/v1/`.
- Update `docs/ROADMAP.md` status and (when relevant) `docs/OPEN_DECISIONS.md`
  as part of your phase work.

## 6. Do-not-touch list

- `docs/blueprint/v1/**` — preserved verbatim.
- Applied D1 migrations (once the database phase starts) — append new ones.
- Prior phases' behavior unless a phase explicitly requires a change; if a
  change is required, record it via ADR or an open decision first.
