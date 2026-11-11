/**
 * Phase 8.2 — the publication OUTBOX lifecycle state machine (pol1).
 *
 * A TOTAL, typed state machine over the REAL schema-6 `publications` status
 * vocabulary (migration 0001 — the blueprint-approved outbox tables,
 * CONSUMED, never rebuilt; zero DDL in this slice). The machine is the
 * authority both the D1 store (src/adapters/db/publication-outbox-store.ts)
 * and the scheduler service (src/application/publishing/scheduler.ts) lean
 * on: a durable write whose (from, reason) pair this machine rejects is a
 * BUG, never a state.
 *
 * The transition table is EXPLICIT DATA (reviewable, testable — no
 * conditional inference). Every violation fails typed. Pure: no I/O, no
 * clock, no SQL, no randomness (the 7.2/8.1 house pattern).
 *
 * THE VOCABULARY CONSTRAINT AND THE HONEST PARKING PIN (owned by ADR-0058):
 * the schema-6 `publications.status` CHECK (migration 0001) has exactly nine
 * values and NONE of them is `uncertain` — widening a CHECK in SQLite means
 * a table rebuild, which the append-only house migration discipline does
 * not do for a vocabulary. The ambiguous send outcome (ADR-0032) therefore
 * parks in `failed` — whose durable meaning is pinned as «the attempt ended
 * WITHOUT A CONFIRMED publication» — with the classifier's honest code in
 * `last_error` (telegram_timeout / telegram_server_error / ... tells the
 * reader exactly what is and is not known). The truth lives in the CODE;
 * the status is the schema's parking state. The reconciliation rule (the
 * ADR-0032 gate): no second send without checking `publication_messages` —
 * recorded delivery evidence promotes a parked row to `published` (the
 * proof outranks the earlier inference); without evidence the row stays
 * parked for the human dispositions (cancel / supersede) — an unconfirmed
 * attempt is NEVER auto-resent and never asserts proved non-delivery.
 *
 * The honest semantics this machine pins:
 *  - `failed` (the parking state) NEVER auto-retries: `claim` and
 *    `schedule_retry` from it are machine-ILLEGAL; its exits are the
 *    EVIDENCE heal to `published`, and the human dispositions. An
 *    unconfirmed attempt can never assert proved non-delivery on its own —
 *    the classifier's code in last_error carries the epistemic truth.
 *  - `claimed` releases to `pending` with the attempt generation RESTORED
 *    (the release path is for policy defers — no send was attempted, so no
 *    attempt was consumed).
 *  - The terminal rows (`dead_letter`, `cancelled`, `superseded`) have NO
 *    machine exits; `published` only yields to `superseded` (the Phase 8.4
 *    correction path, reserved).
 *  - The `publishing` status is part of the schema vocabulary and the
 *    machine accepts it (claimed -> publishing and the same exits), but the
 *    Phase 8.2 engine does not use it: the engine follows the admin-post
 *    house shape (claimed -> terminal, fenced by the attempts generation) —
 *    documented in ADR-0058.
 */

export const OUTBOX_LIFECYCLE_VERSION = 'pol1' as const;

/** The REAL schema-6 `publications.status` CHECK vocabulary (migration 0001). */
export const PUBLICATION_STATUSES = [
  'pending',
  'claimed',
  'publishing',
  'published',
  'retry_wait',
  'failed',
  'dead_letter',
  'cancelled',
  'superseded',
] as const;

export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export function isPublicationStatus(value: string): value is PublicationStatus {
  return (PUBLICATION_STATUSES as readonly string[]).includes(value);
}

/**
 * The named transition reasons. Each reason names the BUSINESS event, not
 * the target state — the target state is data below, so a state change is
 * always a deliberate table edit, never an accident.
 */
export type OutboxTransitionReason =
  /** Atomic claim: pending|retry_wait -> claimed (attempts +1, lease). */
  | 'claim'
  /** The optional finer durable state before the send call (engine unused). */
  | 'mark_send_started'
  /** Policy defer / not-yet-due release: claimed -> pending, attempts restored. */
  | 'release'
  /** Send response proof, or the recorded-evidence heal: claimed|failed -> published. */
  | 'publish'
  /** Proved non-delivery, non-retryable hold: claimed|publishing -> failed. */
  | 'fail_hold'
  /**
   * Ambiguous outcome: claimed|publishing -> failed (the schema's honest
   * parking state — the classifier's code lands in last_error; NEVER
   * auto-resent; healed only by recorded evidence).
   */
  | 'mark_uncertain'
  /** Proved non-delivery, retryable, budget left: claimed|publishing -> retry_wait. */
  | 'schedule_retry'
  /** Budget spent / eligibility lost / malformed content: -> dead_letter. */
  | 'dead_letter'
  /** Human disposition: pending|retry_wait|failed|uncertain -> cancelled. */
  | 'cancel'
  /** Superseded by a newer publication (the Phase 8.4 path, reserved). */
  | 'supersede';

export type OutboxTransition = {
  readonly from: PublicationStatus;
  readonly reason: OutboxTransitionReason;
  readonly to: PublicationStatus;
};

/**
 * The EXPLICIT transition table. Rows are listed per source status; a
 * (status, reason) pair absent from the table is machine-ILLEGAL.
 */
export const OUTBOX_TRANSITIONS: Readonly<Record<PublicationStatus, readonly OutboxTransition[]>> =
  {
    pending: [
      { from: 'pending', reason: 'claim', to: 'claimed' },
      { from: 'pending', reason: 'cancel', to: 'cancelled' },
      { from: 'pending', reason: 'supersede', to: 'superseded' },
      {
        from: 'pending',
        reason: 'dead_letter',
        to: 'dead_letter',
      },
    ],
    claimed: [
      { from: 'claimed', reason: 'mark_send_started', to: 'publishing' },
      { from: 'claimed', reason: 'release', to: 'pending' },
      { from: 'claimed', reason: 'publish', to: 'published' },
      { from: 'claimed', reason: 'fail_hold', to: 'failed' },
      { from: 'claimed', reason: 'mark_uncertain', to: 'failed' },
      { from: 'claimed', reason: 'schedule_retry', to: 'retry_wait' },
      { from: 'claimed', reason: 'dead_letter', to: 'dead_letter' },
    ],
    publishing: [
      { from: 'publishing', reason: 'publish', to: 'published' },
      { from: 'publishing', reason: 'fail_hold', to: 'failed' },
      { from: 'publishing', reason: 'mark_uncertain', to: 'failed' },
      { from: 'publishing', reason: 'schedule_retry', to: 'retry_wait' },
      { from: 'publishing', reason: 'dead_letter', to: 'dead_letter' },
    ],
    published: [{ from: 'published', reason: 'supersede', to: 'superseded' }],
    retry_wait: [
      { from: 'retry_wait', reason: 'claim', to: 'claimed' },
      { from: 'retry_wait', reason: 'cancel', to: 'cancelled' },
      { from: 'retry_wait', reason: 'supersede', to: 'superseded' },
      { from: 'retry_wait', reason: 'dead_letter', to: 'dead_letter' },
    ],
    failed: [
      { from: 'failed', reason: 'publish', to: 'published' },
      { from: 'failed', reason: 'cancel', to: 'cancelled' },
      { from: 'failed', reason: 'supersede', to: 'superseded' },
    ],
    dead_letter: [],
    cancelled: [],
    superseded: [],
  };

export type OutboxTransitionResult =
  | { readonly ok: true; readonly from: PublicationStatus; readonly to: PublicationStatus }
  | {
      readonly ok: false;
      readonly reason: 'invalid_status' | 'invalid_reason' | 'invalid_transition';
    };

/**
 * The TOTAL transition function. Unknown status/reason inputs fail typed
 * (`invalid_status` / `invalid_reason`) before any table lookup; a known
 * pair absent from the table fails `invalid_transition`.
 */
export function transitionPublication(from: string, reason: string): OutboxTransitionResult {
  if (!isPublicationStatus(from)) {
    return { ok: false, reason: 'invalid_status' };
  }
  const validReasons: readonly OutboxTransitionReason[] = [
    'claim',
    'mark_send_started',
    'release',
    'publish',
    'fail_hold',
    'mark_uncertain',
    'schedule_retry',
    'dead_letter',
    'cancel',
    'supersede',
  ];
  if (!(validReasons as readonly string[]).includes(reason)) {
    return { ok: false, reason: 'invalid_reason' };
  }
  const row = OUTBOX_TRANSITIONS[from].find(
    (candidate) => candidate.reason === (reason as OutboxTransitionReason),
  );
  if (!row) {
    return { ok: false, reason: 'invalid_transition' };
  }
  return { ok: true, from: row.from, to: row.to };
}

/**
 * The sendable editorial draft statuses. A publication whose draft has left
 * this set has lost its eligibility: the send path dead-letters the row
 * (eligibility_lost) before any transport call — a rejected/superseded
 * draft can never reach the channel through the scheduler.
 */
export const SENDABLE_DRAFT_STATUSES = ['approved', 'auto_approved'] as const;

export type SendableDraftStatus = (typeof SENDABLE_DRAFT_STATUSES)[number];

export function isSendableDraftStatus(value: string): boolean {
  return (SENDABLE_DRAFT_STATUSES as readonly string[]).includes(value);
}

/**
 * The blueprint §7 attempt budget: «max attempts: 3 normal, 5 P0
 * publication». Pinned from the editorial score (>= 90 is the P0 class
 * boundary of pcp1). Invalid scores fail typed — the caller validates with
 * classifyPriority first; this is defense in depth.
 */
export function publicationMaxAttempts(
  priorityScore: number,
): { ok: true; value: 3 | 5 } | { ok: false; reason: 'invalid_score' } {
  if (
    typeof priorityScore !== 'number' ||
    !Number.isFinite(priorityScore) ||
    !Number.isInteger(priorityScore) ||
    priorityScore < 0 ||
    priorityScore > 100
  ) {
    return { ok: false, reason: 'invalid_score' };
  }
  return { ok: true, value: priorityScore >= 90 ? 5 : 3 };
}

/**
 * The conservative retry floor: a retryable proved failure never re-enters
 * the send path earlier than 60s after the failure, even when the server's
 * retry_after is missing or tiny. The server's retry_after is HONORED when
 * larger (blueprint §7: «Telegram 429: respect retry_after»).
 */
export const MIN_PUBLICATION_RETRY_BACKOFF_MS = 60_000;

export type RetryPlanResult =
  | { readonly ok: true; readonly action: 'retry_wait'; readonly runAfterMs: number }
  | { readonly ok: true; readonly action: 'dead_letter' }
  | { readonly ok: false; readonly reason: 'invalid_input' };

/**
 * The retry decision after a PROVED non-delivery (the classifier said
 * failed_proved with retryable=true). Budget spent (attempts >=
 * maxAttempts) dead-letters — never a max+1-th attempt (the ADR-0037
 * lesson: the budget is enforced at the claim boundary, a crashed
 * generation can never burn an extra attempt).
 */
export function planRetryAfterProvedFailure(input: {
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly retryAfterMs: number | null;
  readonly nowMs: number;
}): RetryPlanResult {
  const { attempts, maxAttempts, retryAfterMs, nowMs } = input;
  if (
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    (retryAfterMs !== null && (!Number.isInteger(retryAfterMs) || retryAfterMs < 0)) ||
    !Number.isInteger(nowMs)
  ) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (attempts >= maxAttempts) {
    return { ok: true, action: 'dead_letter' };
  }
  const backoff = Math.max(
    retryAfterMs ?? MIN_PUBLICATION_RETRY_BACKOFF_MS,
    MIN_PUBLICATION_RETRY_BACKOFF_MS,
  );
  return { ok: true, action: 'retry_wait', runAfterMs: nowMs + backoff };
}

/**
 * The pinned re-evaluation interval for NON-time-resolvable policy defers
 * (the layout-run cap and the category-share cap change only when NEW posts
 * publish — psp1 cannot name a time). The row re-enters evaluation after
 * this interval; `scheduled_at` stays NULL (honest: no send time was
 * planned).
 */
export const POLICY_DEFER_REEVALUATE_MS = 10 * 60_000;

export type ReleasePlanResult =
  | {
      readonly ok: true;
      readonly runAfterMs: number;
      readonly scheduledAtMs: number | null;
    }
  | { readonly ok: false; readonly reason: 'invalid_input' };

/**
 * The release plan after a psp1 schedule decision, decided inside the
 * claimed section:
 *  - a future dueAt (window gate / latency / cooldown shift): the durable
 *    deferral — run_after = scheduled_at = dueAtMs;
 *  - a non-time-resolvable defer (dueAtMs null): the pinned re-evaluation
 *    interval, scheduled_at NULL.
 */
export function planReleaseAfterScheduleDecision(input: {
  readonly dueAtMs: number | null;
  readonly nowMs: number;
}): ReleasePlanResult {
  const { dueAtMs, nowMs } = input;
  if (!Number.isInteger(nowMs) || nowMs < 0) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (dueAtMs === null) {
    return {
      ok: true,
      runAfterMs: nowMs + POLICY_DEFER_REEVALUATE_MS,
      scheduledAtMs: null,
    };
  }
  if (!Number.isInteger(dueAtMs) || dueAtMs < 0) {
    return { ok: false, reason: 'invalid_input' };
  }
  return { ok: true, runAfterMs: dueAtMs, scheduledAtMs: dueAtMs };
}
