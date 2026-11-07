/**
 * R1.10.1/R1.10.2 AUDIT TOOLING — the single sanctioned measurement-output
 * channel for the trace suite (v3).
 *
 * The trace suite's console lines are the bound evidence transport: they
 * are captured into `logs/30-trace-run-r1103.log` and parsed for the
 * per-trace tables in free-plan/FREE_PLAN_WORKSHEET.md. The workerd test
 * pool forwards diagnostics to the host ONLY through `console`. All trace
 * suites emit through this helper so the linter exception is visible,
 * documented, and confined to one line.
 */
export function traceLog(...parts: unknown[]): void {
  // eslint-disable-next-line no-console -- contracted measurement channel: trace output is bound into logs/30-trace-run-r1103.log; workerd tests reach the host log only via console
  console.log(...parts);
}
