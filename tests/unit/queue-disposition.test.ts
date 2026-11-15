/**
 * Phase 9C — the pure queue-disposition module (qd1) RED-first suite.
 *
 * The disposition decision is DATA (the 7.2/8.1 house pattern): the TOTAL
 * table over the REAL pol1 vocabulary, and the whole-token argument grammar.
 * Every status of the vocabulary is enumerated — a vocabulary change fails
 * this suite loudly.
 */
import { describe, expect, it } from 'vitest';

import {
  QUEUE_DISPOSITION_VERSION,
  evaluateQueueDisposition,
  isPublicationStatus,
  parseQueueDispositionArgument,
} from '../../src/domain/publishing/queue-disposition';
import { PUBLICATION_STATUSES } from '../../src/domain/publishing/outbox-lifecycle';

describe('queue-disposition qd1 — the TOTAL disposition table', () => {
  it('carries the pinned version', () => {
    expect(QUEUE_DISPOSITION_VERSION).toBe('qd1');
  });

  it('covers EVERY status of the pol1 vocabulary (no gaps, no strangers)', () => {
    // The table must be TOTAL over the REAL vocabulary: every status maps
    // to exactly one verdict, and the suite fails if the vocabulary grows.
    for (const status of PUBLICATION_STATUSES) {
      const verdict = evaluateQueueDisposition(status);
      expect(['cancellable', 'refused']).toContain(verdict.kind);
    }
    // And no status outside the vocabulary is accepted (the isPublicationStatus
    // guard is the module's own — it must agree with the machine's).
    expect(isPublicationStatus('pending')).toBe(true);
    expect(isPublicationStatus('queued')).toBe(false);
    expect(isPublicationStatus('')).toBe(false);
    expect(isPublicationStatus('PENDING')).toBe(false);
  });

  it('pending / retry_wait / failed are cancellable (the pol1 cancel rows)', () => {
    for (const status of ['pending', 'retry_wait', 'failed'] as const) {
      expect(evaluateQueueDisposition(status)).toEqual({ kind: 'cancellable', status });
    }
  });

  it('claimed / publishing are refused in_flight (a worker may hold the lease)', () => {
    for (const status of ['claimed', 'publishing'] as const) {
      expect(evaluateQueueDisposition(status)).toEqual({
        kind: 'refused',
        status,
        reason: 'in_flight',
      });
    }
  });

  it('published is refused already_published (the 8.4 supersede flow owns it)', () => {
    expect(evaluateQueueDisposition('published')).toEqual({
      kind: 'refused',
      status: 'published',
      reason: 'already_published',
    });
  });

  it('the terminal rows are refused terminal (pol1: no exits)', () => {
    for (const status of ['dead_letter', 'cancelled', 'superseded'] as const) {
      expect(evaluateQueueDisposition(status)).toEqual({
        kind: 'refused',
        status,
        reason: 'terminal',
      });
    }
  });

  it('an unknown status fails typed, never guessed', () => {
    expect(evaluateQueueDisposition('uncertain')).toEqual({ kind: 'invalid_status' });
    expect(evaluateQueueDisposition('')).toEqual({ kind: 'invalid_status' });
  });

  it('is deterministic (JSON-equal on repeated calls)', () => {
    const a = JSON.stringify(evaluateQueueDisposition('failed'));
    const b = JSON.stringify(evaluateQueueDisposition('failed'));
    expect(a).toBe(b);
  });
});

describe('queue-disposition qd1 — the whole-token argument grammar', () => {
  it('accepts a bounded opaque id (the publication id shape)', () => {
    const verdict = parseQueueDispositionArgument('pub-1234567890abcdef');
    expect(verdict).toEqual({ kind: 'valid', publicationId: 'pub-1234567890abcdef' });
  });

  it('rejects the empty and absent argument', () => {
    expect(parseQueueDispositionArgument(undefined)).toEqual({ kind: 'invalid' });
    expect(parseQueueDispositionArgument('')).toEqual({ kind: 'invalid' });
  });

  it('rejects whitespace-bearing arguments (the R1.18.1 V1 discipline)', () => {
    expect(parseQueueDispositionArgument('pub id')).toEqual({ kind: 'invalid' });
    expect(parseQueueDispositionArgument(' pub')).toEqual({ kind: 'invalid' });
    expect(parseQueueDispositionArgument('pub ')).toEqual({ kind: 'invalid' });
    expect(parseQueueDispositionArgument('pub\tid')).toEqual({ kind: 'invalid' });
  });

  it('rejects newline-bearing arguments BEFORE any query could exist', () => {
    expect(parseQueueDispositionArgument('pub\nid')).toEqual({ kind: 'invalid' });
    expect(parseQueueDispositionArgument('pub\r\nid')).toEqual({ kind: 'invalid' });
  });

  it('rejects control characters and DEL', () => {
    expect(parseQueueDispositionArgument('pub\x01id')).toEqual({ kind: 'invalid' });
    expect(parseQueueDispositionArgument('pub\x1bid')).toEqual({ kind: 'invalid' });
    expect(parseQueueDispositionArgument('pub\x7fid')).toEqual({ kind: 'invalid' });
  });

  it('rejects oversized arguments (the bounded whole-token byte cap)', () => {
    expect(parseQueueDispositionArgument('p'.repeat(200))).toEqual({ kind: 'invalid' });
  });

  it('accepts a 128-unit id at the documented bound', () => {
    const id = 'p'.repeat(128);
    expect(parseQueueDispositionArgument(id)).toEqual({ kind: 'valid', publicationId: id });
    expect(parseQueueDispositionArgument('p'.repeat(129))).toEqual({ kind: 'invalid' });
  });

  it('accepts multibyte ids within the byte bound, rejects beyond it', () => {
    // 64 two-byte units = 128 bytes: exactly at the bound.
    const atBound = 'ی'.repeat(64);
    expect(parseQueueDispositionArgument(atBound)).toEqual({
      kind: 'valid',
      publicationId: atBound,
    });
    expect(parseQueueDispositionArgument('ی'.repeat(65))).toEqual({ kind: 'invalid' });
  });
});
