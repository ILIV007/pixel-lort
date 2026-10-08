# ADR-0035 — Admin UI language preference ordering by Telegram message metadata

Status: Accepted (Phase 2B review correction, v1.2.6). Amends ADR-0034: the
update_id write fence is superseded by message-order-metadata ordering; the
corrupt-row recovery contract is strengthened. ADR-0034's security model,
English default, per-admin isolation, and strict editorial separation are
unchanged.

## Context

The independent review of the v1.2.5 delivery rejected one of its storage
contracts. ADR-0034 fenced language-change writes with the numeric
`update_id` of the changing message (`stored.last_update_id <= incoming
update_id`). Telegram's Bot API documents that **update_id may be RANDOMIZED
after one week without updates** — the number is a durable deduplication
key, but its numeric ordering proves nothing about message chronology. A
genuinely newer language choice sent after such an idle week could carry a
LOWER update_id and would be rejected as "stale" by the v1.2.5 fence — a
false conflict. The review also required that a corrupt stored row must
never block the next valid save, and demanded delivery-integrity checks for
the shipped archive.

## Decision

- **Ordering by validated Telegram message-order metadata.** A
  language-change write is fenced by the lexicographic pair
  `(message.date, message.message_id)`:
  - `message.date` is Telegram's SERVER-assigned message time (Unix
    seconds). The bounded parser extracts it as a safe integer within
    `[0, 4102444800]` (year 2100); anything else is treated as ABSENT.
    `changed_at_ms = date × 1000` is the primary order key.
  - `message.message_id` is per-chat monotonic and breaks ties between
    messages sent within the SAME SERVER SECOND, so same-second commands
    order deterministically regardless of delivery order.
- **update_id keeps exactly one job.** It remains the DURABLE
  DEDUPLICATION boundary (ADR-0025 claims layer: one execution decision per
  update_id) and is recorded in the preference JSON for audit only. It is
  never compared numerically to decide freshness.
- **Local time is not an order.** Processing/arrival time is deliberately
  rejected as a substitute: an OLD retried message ARRIVES later, so
  arrival time would let the oldest message win. Only Telegram's own
  server-assigned metadata may order preferences.
- **Fail-safe on missing metadata.** A `/language` CHANGE whose message
  lacks validated `date` or `message_id` is ignored with the stable noop
  reason `language_missing_ordering_metadata` — no feedback, no state
  change, no order invented from local clocks. The read-only bare
  `/language` status response still works without metadata. At the store
  boundary, invalid ordering input throws the deterministic
  `internal_error` (permanent classification) instead of writing garbage.
- **Safe atomic corrupt-row recovery.** The write is ONE UPSERT whose guard
  is `CASE WHEN <stored row fully valid> THEN <ordering fence> ELSE 1 END`:
  - `json_valid(settings.value_json) = 1` is evaluated FIRST, so
    `json_extract` never runs on malformed JSON (which would throw and
    permanently wedge the row).
  - "Fully valid" mirrors the JS parser exactly: JSON object, language
    `en`/`fa`, `changed_at_ms` and `last_update_id` safe integers in
    range, optional `last_message_id` a positive safe integer when
    present (absent, not null, when unknown).
  - A row that fails ANY validity condition is treated as absent and the
    same atomic statement REPAIRS it — malformed JSON (`'{broken'`) and
    valid-JSON-with-invalid-types (string timestamps, wrong language
    codes, out-of-range numbers) can never become permanently stuck rows.
  - The fence applies UNCHANGED to fully valid rows: strictly newer
    ordering wins, equal ordering (a redelivered message) re-applies
    idempotently, strictly older ordering writes nothing (`changes = 0`
    → honest `stale`). Recovery never weakens the fence.
  - All writes remain inside the dedicated `admin_ui_language:` key
    namespace; no other settings key is ever read or written by this
    feature.
- **Delivery integrity (repository).** Tracked file executable bits are
  normalized to the Git index (exactly `scripts/deploy-preview.mjs` is
  100755; every other tracked file is 100644), `core.filemode` stays
  ENABLED, and the shipped archive is verified by extraction with filemode
  checks active — mode drift is surfaced, never hidden.

## Alternatives considered

- **Keep the update_id fence (v1.2.5).** Rejected: update_id ordering is
  false after Telegram randomizes ids following a week idle — a genuinely
  newer choice would be rejected, and an older retry with a randomized
  HIGHER id could overwrite a newer choice.
- **Local processing/arrival time.** Rejected by requirement and by
  analysis: an old retry arrives later than the newer message it must not
  overwrite; wall-clock skew between Workers makes it worse.
- **Two-statement read-decide-repair.** Rejected: a read outside the write
  statement reintroduces the read-decide-write race; the CASE-guarded
  single UPSERT keeps decision and repair atomic.
- **Store `last_message_id` as JSON null when unknown.** Rejected: a JSON
  null fails the validity predicate (its `json_type` is `'null'`), so rows
  we wrote ourselves would be misread as corrupt; the key is OMITTED
  instead.

## Verification

- Reviewer regression tests (`tests/integration/pixel-v125-review-regressions.test.ts`,
  attached verbatim by the reviewer): a newer selection with a LOWER
  update_id is accepted; an unreadable (`'{broken'`) row is repaired by the
  next valid save.
- Store-level ordering suite (`tests/integration/admin-ui-language-ordering.test.ts`):
  older-retry rejection, same-second `message_id` tiebreak both directions,
  idempotent duplicate re-application, unordered write cannot beat a
  same-second write carrying a message_id, per-admin isolation, invalid
  store input fails safely with no write, ten corrupt-row shapes repaired
  (including valid JSON with invalid field types) while an unrelated
  settings row stays byte-identical, and the fence remains strong for fully
  valid rows.
- Pipeline-level suite (`tests/integration/admin-ui-language.test.ts`):
  newer message with lower update_id accepted end-to-end; older message
  delivered late rejected with the honest stale reply; same-second ordering
  and duplicate deliveries; missing/invalid `date` changes ignored with
  `language_missing_ordering_metadata` and no write.
- Parser suite: `date` extraction bounds and fail-safe absence.
- Version gate: application 1.2.6, schema 2 (no migration added).

## Consequences

Language preferences now order by the only chronology Telegram guarantees:
its own server-assigned message metadata. The durable update_id claim
machinery (ADR-0025/0030/0031) is untouched, so delivery-level
deduplication semantics are unchanged. Corrupt preference rows self-heal on
the next legitimate write. The stored JSON gains an optional
`last_message_id` field; readers of the old shape keep working (the field
is additive). No schema change, no migration, no editorial or blueprint
file is affected.
