# src/editorial — planned (not implemented in Phase 0)

Editorial rendering and persona machinery:

- Deterministic renderer: HTML escaping, tag allowlist, visible-length
  calculation, 4096/1024 limits, balanced splitting, RTL/bidi treatment,
  deterministic source line and footer (blueprint §13).
- Persian normalization contract: Arabic Yeh/Kaf, ZWNJ, digits, punctuation
  (blueprint persona document §4).
- Prompt contract storage with immutable semantic versions (phase 6).

The model NEVER emits Telegram HTML — this layer renders validated semantic
documents deterministically. No code exists in Phase 0.
