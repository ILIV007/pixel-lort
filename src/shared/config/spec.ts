/**
 * Configuration field specification primitives.
 *
 * A tiny, Worker-compatible validation layer without third-party dependencies.
 * Deliberately minimal: string and enum fields, required/optional, defaults,
 * and a `secret` classification (ADR-0003). Schema-heavy validation (AI
 * contracts) will adopt Zod in its own phase per the blueprint.
 */

export type ConfigValueType = 'string' | 'enum';

export interface ConfigFieldSpec {
  /** Environment variable name, e.g. "LOG_LEVEL". */
  readonly name: string;
  readonly type: ConfigValueType;
  /** Missing/empty without a default is a validation failure. */
  readonly required: boolean;
  /**
   * Secret fields are validated but their values are never echoed in issues,
   * logs, or responses. See docs/SECURITY_MODEL.md.
   */
  readonly secret: boolean;
  /** Allowed values for `type: 'enum'`. */
  readonly allowed?: readonly string[];
  /** Applied when the field is absent or empty. */
  readonly default?: string;
  /** Human-readable description for docs and error notes. */
  readonly description: string;
  /** Roadmap phase that starts consuming this field (0 = already active). */
  readonly phase: number;
}

export interface ConfigSpec {
  readonly fields: readonly ConfigFieldSpec[];
}

export function defineConfigSpec(fields: readonly ConfigFieldSpec[]): ConfigSpec {
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.name)) {
      throw new Error(`duplicate config field name: ${field.name}`);
    }
    seen.add(field.name);
  }
  return { fields };
}
