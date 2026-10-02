# ADR-0020: /version contract and build/schema metadata configuration

- **Status:** Accepted (amended by the Phase 1A correction pass — commit
  trust rules extended to preview)
- **Date:** 2026-10-02 (Phase 1A)
- **Decides:** the `GET /version` response contract and the
  APP_COMMIT / SCHEMA_VERSION configuration surface (implements the Phase 1
  item agreed in ADR-0012, closing OD-004).

## Decision

1. **Response contract.** `GET /version` returns EXACTLY four safe fields
   with `cache-control: no-store`, standard security headers, and normal
   correlation-ID behavior:

   ```json
   {
     "applicationVersion": "1.1.0",
     "commit": "322d162b2384c8f1f765470b22194845d1f2bab6",
     "schemaVersion": 1,
     "environment": "development"
   }
   ```

   No secrets, no timestamps (keeps tests deterministic), no environment
   dump. `schemaVersion` is a JSON number. The approved Phase 1A application
   version is **1.1.0**, kept in sync across `package.json`,
   `package-lock.json`, `wrangler.jsonc` (APP_VERSION), configuration
   defaults, tests, and documentation.

2. **Configuration.** Two new typed NON-SECRET fields join the config
   surface (`PHASE_1A_CONFIG_SPEC`):
   - `APP_COMMIT` (string) — commit identifier; local default `local-dev`.
   - `SCHEMA_VERSION` (string) — expected D1 schema version; validated with
     a strict positive-decimal-integer pattern (`/^[1-9][0-9]*$/`). The
     shared validator gained optional `pattern` support (`invalid_format`
     reason) for this; issues carry field names and reasons only.

3. **No silent coercion.** Defaults apply ONLY when a field is absent or
   empty (documented validator semantics). An INVALID value never falls back
   to the default: `parseDataFoundationConfig` returns `config = null` and
   callers fail closed — `/version` maps to 503 `config_invalid`, readiness
   reports `not_ready`.

4. **Commit trust rules (environment-scoped).** `/version` must never expose
   an arbitrary uncontrolled string:
   - `development` MAY use the local placeholder `APP_COMMIT=local-dev`;
   - `preview` and `production` MUST reject `local-dev` (fail-closed
     `invalid_value` issue) and MUST report their actual source commit;
   - outside development, `APP_COMMIT` MUST match a safe hexadecimal Git
     commit-identifier format of 7–64 characters
     (`GIT_COMMIT_ID_PATTERN = /^[0-9a-f]{7,64}$/i`); to keep /version
     uniformly controlled, the same format is enforced for every explicit
     non-placeholder value in ALL environments (including development);
   - values are reported verbatim — never normalized, never echoed in issues.

## Consequences

- Local development and tests boot with documented defaults (wrangler.jsonc
  vars + `.env.example`).
- Phase 1B injects the real commit identifier for preview/production at
  deploy time; no contract change is needed.
- Readiness inherits the same rules: an invalid commit identifier in preview
  or production makes `/health/ready` report `not_ready` (ADR-0021).
