/**
 * Stable ID generation helpers.
 *
 * Workers expose Web Crypto (`crypto.randomUUID`), which is the sanctioned ID
 * source. Random UUIDs are used for entity/job IDs; deterministic idempotency
 * keys live in `idempotency-key.ts` and must NOT use randomness.
 */
export interface IdGenerator {
  newId(): string;
}

/** UUID v4 generator backed by Web Crypto (available in Workers and Node 19+). */
export const cryptoIdGenerator: IdGenerator = {
  newId: () => crypto.randomUUID(),
};

export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
