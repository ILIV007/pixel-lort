# src/domain — planned (not implemented in Phase 0)

Pure domain models and rules for Pixel. Blueprint §3 maps the following
submodules here over later phases:

- `story` — Story, Claim, Evidence, fingerprints and trust rules (phase 5)
- `editorial` — Draft document, layout, persona and fact contracts (phase 6)
- `publication` — Publication state machine and edit/correction rules (phase 8)
- `source` — Source, cursor, budget, reputation, normalized SourceItem (phase 4)
- `media` — Media candidate, rights state, album plan, usage history (phase 7; **7.2+7.3 DELIVERED**: the PURE policy layer ADR-0055 (`media-candidate`/`media-rights`/`r2-temporary`/`album-plan`) + the upload path and the album CONTENT kind ADR-0056 (`media-usage` over the blueprint media_assets table + `media-ports` + `album-content` + the upload service + the D1 asset store); the album-post pipeline integration (capture/preview/approve/publish) is carried into Phase 8 planning)
- `identity` — Admin, permission, one-time action token (phase 2)

Boundary rule: domain code imports NO Cloudflare, Telegram, provider SDK, or
HTTP client types. Domain code must not be added before its phase (see
docs/ROADMAP.md).
