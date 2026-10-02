# ADR-0018 — Secret scanner coverage and automated self-test in the gate

- **Status:** Accepted
- **Phase:** 0 (correction pass)
- **Date:** 2026-10-02
- **Decided by:** Alexios (Phase 0 review)

## Context

The Phase-0 secret scanner covered only a small set of credential shapes and
had no self-tests; a scanner that silently stops matching is worse than no
scanner. The project also uses Cloudflare, GitHub, and Groq credentials
whose shapes were not covered.

## Decision

**Coverage.** The scanner (scripts/scan-secrets-lib.mjs) detects at least:

- Cloudflare **user** API tokens — `cfut_` prefix
- Cloudflare **account** API tokens — `cfat_` prefix
- GitHub **fine-grained** PATs — `github_pat_` prefix
- **Groq** API keys — `gsk_` prefix
- Existing GitHub **legacy** token prefixes (`ghp_`, `gho_`, `ghu_`, `ghs_`,
  `ghr_`)
- Existing Telegram, Google, private-key, and Bearer patterns

**Structure.** Pure scanning library (`scan-secrets-lib.mjs`), CLI gate
(`scan-secrets.mjs`, with an opt-in `--scan <path>` mode), and an automated
self-test (`scan-secrets.selftest.mjs`). Findings identify pattern + file +
line ONLY; matched content is never returned, printed, or logged.

**Self-test guarantees (all enforced by `npm run test:secrets`, part of
`npm run check`):**

1. expected credential shapes are detected;
2. harmless placeholders are NOT detected;
3. findings never print the secret value;
4. the process exits non-zero on a finding.

Test fixtures construct token-shaped strings DYNAMICALLY from separate
fragments so the scanner never reports its own test source, and no real
credential is ever added to the repository.

## Consequences

- `npm run check` now runs: lint → format:check → typecheck → tests →
  scanner self-test → repo secret scan → offline build.
- The scanner failing open (broken regex, missing export) fails the gate via
  the self-test instead of silently passing.
