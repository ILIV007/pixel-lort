# Reproducible independent R1.10.2 evidence

logs/r1102-independent-package.log:353/353 manifest, sealed prior61... input,
real f702 bundle HEAD, source297/297 byte identity, exit0.
logs/r1102-independent-traces.log: supplied unfiltered corrected config,37/37 exit0.
logs/r1102-source-diff.log: empty git tracked diff after local tests.
logs/r1102-independent-counterexamples.log:3F/1P exit1, four tests separate from37.

manager-probes/design-counterexamples.test.ts uses actual disposable D1 for
CE1, CE2 and CONTROL; CE3 uses an explicitly fake binding solely to test in-memory
reservoir saturation. No Cloudflare platform limit enforcement occurs locally.
The minimal SQL control deliberately omits engine/state overhead: it is a LOWER
BOUND proving100 retained inserts cannot turn into16 total statements through
read grouping alone. Not a new product implementation/performance claim.

IMPORTANT CE2 is literal rejected design SQL. It is expected red even after the
candidate design is corrected; preserve it as historical proof and create a
new source-bound candidate-query test. After fixing counters only, expected
original-suite composition is1F/3P, not4/4. Do not edit frozen evidence to green.

reproduce.sh clones the bundle into disposable scratch, extracts SEALED actual
input, copies its audit-tools unchanged, runs its37-test command, then overlays
only manager probes and manager config. Expected3F/1P is asserted and logs retained
in the provided external NEW log directory. Scratch is removed. Accepted source
tracked diff remains zero. Dependencies not shipped.
