/**
 * Worker-compatible configuration validator (ADR-0003).
 *
 * Guarantees:
 * - Issues identify the FIELD NAME and a reason code only. Field values are
 *   never included in issues, so a misconfiguration can never leak a secret.
 * - Missing/empty required fields fail validation (fail-safe).
 * - Defaults are applied for optional fields.
 * - The parsed config is returned for internal use only; callers must never
 *   log or serialize it wholesale (docs/SECURITY_MODEL.md).
 */
import type { ConfigSpec } from './spec';

export type ConfigIssueReason = 'missing_required' | 'invalid_enum';

export interface ConfigIssue {
  readonly field: string;
  readonly reason: ConfigIssueReason;
  /**
   * Stable note describing the problem. Contains field metadata (allowed
   * values, phase) but never the offending value.
   */
  readonly note: string;
}

export interface ValidConfigResult {
  readonly ok: true;
  /** Parsed values with defaults applied. Internal use only — never log. */
  readonly config: Readonly<Record<string, string>>;
  readonly issues: readonly ConfigIssue[];
}

export interface InvalidConfigResult {
  readonly ok: false;
  /** Values that did validate are still provided for safe internal fallback. */
  readonly config: Readonly<Record<string, string>>;
  readonly issues: readonly ConfigIssue[];
}

export type ConfigValidationResult = ValidConfigResult | InvalidConfigResult;

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value === '');
}

export function validateConfig(
  source: Readonly<Record<string, unknown>>,
  spec: ConfigSpec,
): ConfigValidationResult {
  const config: Record<string, string> = {};
  const issues: ConfigIssue[] = [];

  for (const field of spec.fields) {
    const raw = source[field.name];

    if (isEmpty(raw)) {
      if (field.default !== undefined) {
        config[field.name] = field.default;
        continue;
      }
      if (field.required) {
        issues.push({
          field: field.name,
          reason: 'missing_required',
          note: `required ${field.secret ? 'secret' : 'configuration'} value is not set (phase ${field.phase})`,
        });
      }
      continue;
    }

    if (typeof raw !== 'string') {
      // Non-string values are treated as missing rather than stringified,
      // because String() of objects could embed unexpected content.
      if (field.required) {
        issues.push({
          field: field.name,
          reason: 'missing_required',
          note: `required ${field.secret ? 'secret' : 'configuration'} value is not a string (phase ${field.phase})`,
        });
      }
      continue;
    }

    if (field.type === 'enum') {
      const allowed = field.allowed ?? [];
      if (!allowed.includes(raw)) {
        issues.push({
          field: field.name,
          reason: 'invalid_enum',
          note: `value must be one of: ${allowed.join(', ')}`,
        });
        continue;
      }
    }

    config[field.name] = raw;
  }

  return issues.length === 0 ? { ok: true, config, issues } : { ok: false, config, issues };
}
