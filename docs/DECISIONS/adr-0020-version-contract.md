# ADR-0020: /version contract and build/schema metadata configuration

- **Status:** Accepted
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
     "applicationVersion": "0.0.0-phase0",
     "commit": "local-dev",
     "schemaVersion": 1,
     "environment": "development"
   }
   ```

   No secrets, no timestamps (keeps tests deterministic), no environment
   dump. `schemaVersion` is a JSON number.

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

4. **Production guard.** The local placeholder `APP_COMMIT=local-dev` is
   invalid in production deployments (fail-closed `invalid_value` issue):
   a production `/version` must report a real commit identifier.

## Consequences

- Local development and tests boot with documented defaults (wrangler.jsonc
  vars + `.env.example`).
- A later phase replaces the placeholder at deploy time with the real commit
  identifier; no contract change is needed.
