/**
 * D1 adapter boundary (Phase 1A).
 * Public surface of the smallest useful database access layer: a typed
 * execution boundary, atomic batch support, schema health query, and safe
 * D1 error mapping. No repositories and no business queries yet (Phase 1A
 * scope — docs/ROADMAP.md).
 */
export {
  createDbExecutor,
  type DbExecutor,
  type DbStatement,
  type DbQueryMeta,
  type DbRows,
  type DbExecutorOptions,
} from './db-executor';
export { classifyD1Error, toDbAppError, type DbErrorCode } from './d1-errors';
export {
  checkSchemaHealth,
  SCHEMA_METADATA,
  type SchemaHealthResult,
  type SchemaHealthReason,
} from './schema-health';
