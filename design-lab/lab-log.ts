/**
 * R1.10.3 DESIGN LAB — the single sanctioned measurement-output channel.
 *
 * The lab's console lines are NOT debug prints: they are the CONTRACTED
 * transport parsed by `design-lab/extract-ledger.mjs` (`LABLEDGER[…]`)
 * and bound into `logs/32-design-lab-run.log` / `cost-ledger.json`, and
 * the workerd test pool forwards diagnostics to the host ONLY through
 * `console`. All lab suites emit through this helper so the linter
 * exception is visible, documented, and confined to one line.
 */
export function labLog(...parts: unknown[]): void {
  // eslint-disable-next-line no-console -- contracted measurement channel: parsed by design-lab/extract-ledger.mjs; workerd tests reach the host log only via console
  console.log(...parts);
}
