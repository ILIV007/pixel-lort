// R1.10.3 DESIGN LAB — standalone config (NOT accepted source).
// Runs the design-lab suites (candidate SQL parity + cost ledger) on the
// disposable workerd D1 via the SAME pool-workers plugin as the audit
// tools. Deliberately SEPARATE from the accepted vitest.config.ts and
// from the audit-tools trace config: each surface keeps its own counts
// and logs.
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['design-lab/**/*.test.ts'],
    maxWorkers: 1,
  },
});
