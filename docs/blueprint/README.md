# Blueprint preservation (v1)

This directory preserves the authoritative planning package for Pixel,
**verbatim and byte-identical** to the supplied archive
`pixel-blueprint-v1.zip`. It is the source of truth for all phases.

- Do **not** edit, reformat, or "improve" these files.
- Implementation notes belong in the repository's own docs
  (`docs/ARCHITECTURE.md`, `docs/DECISIONS/`, `docs/OPEN_DECISIONS.md`), never
  as modifications here.
- `pixel_schema_v1.sql` is intentionally NOT applied as a migration yet; the
  database phase (roadmap phase 1) will split it into ordered migration files
  under `migrations/`.

| File                              | Content                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `PIXEL_IMPLEMENTATION_SPEC_v1.md` | Architecture, workflows, queue semantics, panel, security, testing, roadmap |
| `pixel_schema_v1.sql`             | D1 schema with constraints and indexes                         |
| `pixel_source_registry_v1.json`   | Source endpoints, lanes, trust levels, budgets, publication policies |
| `pixel_admin_map_v1.json`         | Roles, permissions, commands, callback actions                 |
| `PIXEL_PERSONA_PROMPTS_v1.md`     | Persona, AI routing, schemas, 50-case Golden evaluation plan   |
| `README.md`                       | Blueprint package overview and status                          |
