// R1.10.1 AUDIT TOOLING — standalone trace config (NOT accepted source).
// Deliberately SEPARATE from the accepted vitest.config.ts so the
// instrumentation never mixes with the accepted suite (1,142 assertions
// remain untouched; this file has its own counts and logs).
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['audit-tools/trace/**/*.test.ts'],
  },
});
