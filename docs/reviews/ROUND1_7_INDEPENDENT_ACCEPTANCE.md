# Round 1.7 — independent R04 acceptance

Posidon, acting for Zeus, independently accepts the LOCAL R04 product fix on top
of `4b044f4940e0167af3e74e1f96764f971c501f77`. This is reviewed work in progress,
not a release, main merge, Cloudflare deployment, migration or activation approval.

## Independent observations

- Input ZIP SHA-256 `978b96909ed82b42bf224b66c2133902213c9119b4b0375e04fbb501a24c9d01`;
  all 311 manifest entries verified. Exactly two modified/four added source files;
  no other accepted product file or existing acceptance assertion changed.
- Single full-suite command with maxWorkers=1: 1032 passed / 2 failed (1034);
  original R04 acceptance green, known R09/R10 red. DB subset263/263.
- Four additional independent tests, OUTSIDE published source composition:
  fresh handler/registry/executor/HTTP dependencies persist/reload real D1 cursor
  across successful/429/restarted polls; exhaustive pure cyclic coverage for all
  N1..50/B1..25/from every start; early/later failure matrix from a non-head window;
  real SafeFetch redirect accounting (3 observed raw attempts for2 entries).
  All four passed; do not add subsets or external proofs to product1034.
- No blocking R04 runtime defect found. Failure windows intentionally stall until
  success; resets on watchlist change revisit the head; fingerprint is not a
  security token; redirect over-budget R10 and cross-worker ownership R09 remain.

## Manager corrections (no runtime logic/assertion changes)

GLM's new persistence harness reused a handler/registry while claiming fresh
instances; corrected the description and test title without changing assertions.
A separate independent real-D1 proof supplies actual fresh-instance evidence.
Corrected18 (not19) invalid cursor fixtures, wraparound-repeat wording, raw-hop
request accounting, and a forged-cursor test comment that claimed a measured hash
collision. Qualified helper coverage language. Existing original assertion files
and runtime logic remain unchanged. Full manager/final gate logs and token-equivalence
checks accompany the comprehensive handoff, outside this product tree.

Applied app1.4.0/schema3/migrations0001–0003 and blueprints stay unchanged.
No remote resource/deployment/migration action is part of this acceptance.
