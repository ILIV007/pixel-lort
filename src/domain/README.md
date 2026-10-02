# src/domain — planned (not implemented in Phase 0)

Pure domain models and rules for Pixel. Blueprint §3 maps the following
submodules here over later phases:

- `story` — Story, Claim, Evidence, fingerprints and trust rules (phase 5)
- `editorial` — Draft document, layout, persona and fact contracts (phase 6)
- `publication` — Publication state machine and edit/correction rules (phase 8)
- `source` — Source, cursor, budget, reputation, normalized SourceItem (phase 4)
- `media` — Media candidate, rights state, album plan, usage history (phase 7)
- `identity` — Admin, permission, one-time action token (phase 2)

Boundary rule: domain code imports NO Cloudflare, Telegram, provider SDK, or
HTTP client types. Domain code must not be added before its phase (see
docs/ROADMAP.md).
