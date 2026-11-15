# Phase 12 — the private test-channel kit (the installer checklist + the evidence templates)

- Version: 1.30.0; status: the KIT is DONE_ENGINEERING; the actual
  private-channel verification is **BLOCKED_LIVE** (Posidon only, with the
  owner's permission and on REAL clients).

## 1. What Posidon executes (the installer checklist)

1. **Environment**: a PRIVATE Telegram channel the owner controls; the
   bot is a member with the post permission; the operator-configured
   `TARGET_CHANNEL` is set to that channel id (NEVER user input —
   ADR-0009); the `ADMIN_POST_LIVE_PUBLISH_ENABLED` gate is ON for the
   private channel ONLY after the checklist review.
2. **Pre-send review**: the preview→approve flow is exercised first for
   EVERY scenario below; the approval binds the server-side version
   (the fingerprint cannot bypass the binding); the approve→publish
   chain uses the SAME stored version.
3. **The scenario matrix** — each row maps to the REAL suite that pins
   the same behavior offline (the evidence column records the CI run of
   THAT SHA):
   | #   | Scenario                                              | The offline pin                                                        |
   | --- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
   | S1  | Plain text post                                       | `admin-post-send-integrity.test.ts`                                    |
   | S2  | Entity-rich text (UTF-16 offsets)                     | `telegram-rich-text-demo.test.ts` + the envelope suite                 |
   | S3  | Single photo / single video                           | `admin-post-media.test.ts`                                             |
   | S4  | Album (2..10, caption ordinal-0)                      | `media-73-upload.test.ts` + `media-74-adversarial-album-fixes.test.ts` |
   | S5  | The scheduler path (outbox enqueue→send→ledger)       | `publication-82-scheduler.test.ts`                                     |
   | S6  | Edit/correction (in-place edit + follow-up supersede) | `publication-84-edit-correction.test.ts`                               |
   | S7  | Failure paths (429 hold / uncertain parking)          | the 8.2 + 8.4 suites                                                   |
   | S8  | RBAC denial (role without `publication.publish`)      | `admin-post-role-flow-ui.test.ts`                                      |
   | S9  | Replay/idempotency (the same send identity twice)     | the 8.2 identity + ledger tests                                        |
4. **Per-scenario evidence template** (one file per row, kept in the
   owner's records — never secrets):
   - the executed SHA + APP_VERSION/SCHEMA_VERSION;
   - the scenario id + the input fixture id;
   - the observed client behavior (the message arrived? the entities
     rendered? the RTL correct? the album order?);
   - the durable ledger state read back (`publications`,
     `publication_messages`, `audit_events`) — the ledger is the truth
     the client display is checked against;
   - any deviation = an incident row (id, severity, disposition).
5. **Cleanup**: the private channel posts are deleted ONLY by the owner
   (OD-009 — no purge path exists in the code by design); the D1 rows
   stay (append-only).

## 2. The honest carry

Nothing in this kit has run against a live Telegram client. The suites
named above pin the OFFLINE behavior over REAL D1 with the transport
faked; the 12.x gate (the real-client verification) is BLOCKED_LIVE
until Posidon executes the matrix and records the evidence. No
completion may be claimed from this document alone.
