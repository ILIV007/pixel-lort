# PIXEL Blueprint v1

Implementation-ready planning package for the Pixel editorial Telegram agent and the **PIXEL LORT** channel (`@pixellort`).

## Files

- `PIXEL_IMPLEMENTATION_SPEC_v1.md` — architecture, workflows, queue semantics, panel, security, testing and roadmap.
- `pixel_schema_v1.sql` — D1 schema with constraints and indexes.
- `pixel_source_registry_v1.json` — source endpoints, lanes, trust levels, budgets and publication policies.
- `pixel_admin_map_v1.json` — roles, permissions, commands and callback actions.
- `PIXEL_PERSONA_PROMPTS_v1.md` — persona, AI routing, schemas and 50-case Golden evaluation plan.

## Status

Architecture decisions are frozen for v1. Inputs still required at implementation time are credentials, Telegram IDs, initial game/publisher/account/repository watchlists, and populated Golden fixtures.
