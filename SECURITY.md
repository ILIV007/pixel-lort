# Security Policy

## Reporting a vulnerability

Do **not** open a public GitHub issue for security problems.

1. Use GitHub's **private security advisory** feature on this repository
   (Security tab → Report a vulnerability), or
2. Contact the repository owner directly through an established private
   channel.

Include: affected component, impact, and reproduction steps. Do not include
real credentials, tokens, or private channel data in reports.

## Scope

- This repository's source code, build tooling, and CI configuration.
- The deployed Pixel Worker (once deployment phases begin) and its Cloudflare
  bindings (D1, KV, R2, Queues, Workers AI).

## Safe-harbor

Good-faith research and reporting is welcome. We ask that you:

- avoid privacy violations, destruction of data, and service degradation;
- never exfiltrate secrets or private user/admin data;
- give maintainers reasonable time to respond before any public disclosure.

## Policy statements

- Credentials are provided only via Cloudflare secrets (`wrangler secret put`)
  or a local git-ignored `.dev.vars` file. They must never appear in the
  repository, logs, error responses, or issue trackers. See
  `docs/SECURITY_MODEL.md` for the full secret boundary model.
- The CI pipeline runs checks only and never deploys or requests credentials.
- A secret-shape scanner (`npm run scan:secrets`) runs as part of the quality
  gate to reduce the chance of committing credential-shaped strings.
