import { describe, expect, it } from 'vitest';
import { decideRichPresentation } from '../../src/domain/inbound/rich-decision';

/**
 * Slice 4 — rich decision (MERGE_MAP §7 step 7 / §11.9, DESIGN §10.3): rich
 * only when the source was rich (entity fidelity — the rich transport is
 * the only entity-faithful path) and only in richMode auto/always. Every
 * rich send falls back to classic on failure (the fallback itself is
 * exercised in the integration suite with a failing transport).
 */
describe('inbound rich decision', () => {
  it('chooses rich when the source carried entities', () => {
    expect(
      decideRichPresentation({
        sourceWasRich: true,
        partCount: 1,
        media: 'none',
        richMode: 'auto',
      }),
    ).toBe('rich');
  });

  it('chooses classic for a plain single-part text post', () => {
    expect(
      decideRichPresentation({
        sourceWasRich: false,
        partCount: 1,
        media: 'none',
        richMode: 'auto',
      }),
    ).toBe('classic');
  });

  it('chooses classic when rich mode is off, even for a rich source', () => {
    expect(
      decideRichPresentation({
        sourceWasRich: true,
        partCount: 1,
        media: 'none',
        richMode: 'off',
      }),
    ).toBe('classic');
  });

  it('chooses rich in always mode when the source was rich', () => {
    expect(
      decideRichPresentation({
        sourceWasRich: true,
        partCount: 3,
        media: 'photo',
        richMode: 'always',
      }),
    ).toBe('rich');
  });

  it('chooses classic for a plain media post without entities', () => {
    expect(
      decideRichPresentation({
        sourceWasRich: false,
        partCount: 1,
        media: 'photo',
        richMode: 'auto',
      }),
    ).toBe('classic');
  });
});
